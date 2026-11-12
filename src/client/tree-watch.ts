/**
 * Client half of the explorer's incremental refresh: one poller per session
 * that reconciles the host's directory watchers (`fs.watch.sync`) and re-lists
 * only the levels that actually changed (`fs.tree.batch`).
 *
 * Why a shared broker instead of a hook per tree: a merged editor+explorer
 * tab and every split editor tab all want the same answer. One timer per
 * subscriber would multiply the request rate by the number of open panes and
 * make the host do the same `opendir` work several times per second.
 *
 * Cadence model (VS Code / chokidar family):
 * - Native `fs.watch` on the host is the source of truth; this loop only
 *   *pulls* the cheap watch-log (`fs.watch.sync`) and re-lists when dirty.
 * - After activity (event, nudge, wake) stay "hot" (~250ms pulls) so the
 *   UI feels near-instant — the sync round itself is cheap when quiet.
 * - After a quiet streak, exponentially back off toward a few seconds so
 *   an idle desktop is not opendir-hammered.
 * - Unwatchable levels (network / mobile proot / EPERM) cannot rely on
 *   events, so the loop stays on a fixed short listing cadence.
 * - A time-based full sweep (~30s) covers silently dropped OS events.
 * - Hidden tabs relax further; becoming visible wakes every channel now.
 */
import { api, type FsEntry, type FsStatInfo, type SessionScope } from './api.ts'

/** One re-listed directory level handed to a subscriber. */
export interface TreeWatchLevel {
  path: string
  entries: FsEntry[]
  truncated: boolean
}

/** What one subscriber tells the broker and receives back. */
export interface TreeWatchHandlers {
  /** Directories currently rendered (loaded levels only). */
  dirs(): readonly string[]
  /** Open files to stat every round (external-modification detection). */
  statPaths?(): readonly string[]
  /** Levels the host re-listed this round. */
  onLevels(levels: readonly TreeWatchLevel[]): void
  /** Stat probes for the open files. */
  onStats?(stats: readonly FsStatInfo[]): void
}

/**
 * Hot pull after activity — cheap `fs.watch.sync` only when nothing changed.
 * ~250ms matches VS Code's "feel instant once the OS event lands" without
 * turning the Host into a listing mill.
 */
export const TREE_WATCH_HOT_MS = 250

/** Steady healthy pull while recently active. */
export const TREE_WATCH_ACTIVE_MS = 750

/** Backoff ceiling after a long quiet stretch. */
export const TREE_WATCH_IDLE_MS = 3_000

/**
 * Fixed cadence while any subscribed level is unwatchable.
 * Those levels have no events — listing IS the signal (chokidar `usePolling`
 * on network drives is the same idea).
 */
export const TREE_WATCH_DEGRADED_MS = 1_500

/** Relaxed cadence while the page is hidden. */
export const TREE_WATCH_HIDDEN_MS = 15_000

/** Cadence after a failed round (host restarting, fence refusal). */
export const TREE_WATCH_ERROR_MS = 4_000

/**
 * Time-based full-subscription re-read — the lost-event backstop.
 * Prefer wall-clock over round counts: adaptive delays would otherwise make
 * a "every N rounds" sweep drift from a few seconds to minutes.
 */
export const TREE_WATCH_FALLBACK_MS = 30_000

/** @deprecated Use {@link TREE_WATCH_HOT_MS}; kept for older test imports. */
export const TREE_WATCH_FALLBACK_ROUNDS = 40

/** @deprecated Degraded path is time-based now ({@link TREE_WATCH_DEGRADED_MS}). */
export const TREE_WATCH_DEGRADED_ROUNDS = 2

/** One subscriber inside a channel. */
interface Subscription {
  handlers: TreeWatchHandlers
}

/** The poller state of one (sessionId, cwd) pair. */
interface Channel {
  scope: SessionScope
  /** Identity handed to the host's per-subscriber reference counting. */
  subscriber: string
  subscriptions: Set<Subscription>
  /** Host watch-log cursor from the last successful sync. */
  seq: number
  timer: ReturnType<typeof setTimeout> | undefined
  /** A round is in flight (skip the tick instead of stacking requests). */
  busy: boolean
  /**
   * A {@link nudgeTreeWatch} arrived while `busy`. The in-flight round's
   * finally-path would otherwise park on the idle cadence and miss the
   * "refresh now" intent (save, mutation, visibility wake).
   */
  pendingNudge: boolean
  /** Consecutive quiet rounds — drives exponential backoff. */
  quietStreak: number
  /** Wall-clock of the last full-subscription sweep. */
  lastSweepAt: number
  /** The host reported unwatchable levels — fixed short listing cadence. */
  degraded: boolean
}

/** Live channels keyed by `${sessionId}\0${cwd}`. */
const channels = new Map<string, Channel>()

/** Whether the page is hidden (absent document → treat as visible). */
function hidden(): boolean {
  try {
    return typeof document !== 'undefined' && document.hidden
  } catch {
    return false
  }
}

/** Channel key: one poller per session and workspace root. */
function channelKey(scope: SessionScope): string {
  return `${scope.sessionId}\0${scope.cwd ?? ''}`
}

/**
 * The host-side subscription id for a channel.
 *
 * It must be stable for the channel's life (the host reference-counts
 * watchers per subscriber, so a fresh id every round would make it close and
 * re-open every handle) and distinct per session (one session's sync must not
 * unsubscribe another's levels).
 */
function subscriberOf(scope: SessionScope): string {
  return `${scope.sessionId}/${scope.cwd ?? ''}`
}

/** Cancel a channel's pending tick (if any). */
function stopTimer(channel: Channel): void {
  if (channel.timer !== undefined) {
    clearTimeout(channel.timer)
    channel.timer = undefined
  }
}

/** Schedule the next round. */
function schedule(channel: Channel, delayMs: number): void {
  stopTimer(channel)
  if (channel.subscriptions.size === 0) return
  channel.timer = setTimeout(() => { void run(channel) }, delayMs)
  // A pending refresh must never hold the process open (plugin reload, tests).
  const timer = channel.timer as { unref?: () => void }
  timer.unref?.()
}

/** Collect the union of every subscriber's watched dirs and stat paths. */
function collect(channel: Channel): { dirs: string[]; statPaths: string[] } {
  const dirs = new Set<string>()
  const statPaths = new Set<string>()
  for (const subscription of channel.subscriptions) {
    for (const dir of subscription.handlers.dirs()) dirs.add(dir)
    for (const file of subscription.handlers.statPaths?.() ?? []) statPaths.add(file)
  }
  return { dirs: [...dirs], statPaths: [...statPaths] }
}

/** Hand one round's payload to every subscriber. */
function dispatch(
  channel: Channel,
  levels: readonly TreeWatchLevel[],
  stats: readonly FsStatInfo[],
): void {
  for (const subscription of [...channel.subscriptions]) {
    // A level only concerns the subscribers that actually render it; with one
    // tree per pane this usually means "everyone", but a pane scrolled to a
    // different subtree should not reconcile rows it does not show.
    const wanted = new Set(subscription.handlers.dirs())
    const owned = levels.filter(level => wanted.has(level.path))
    if (owned.length > 0) subscription.handlers.onLevels(owned)
    const wantedStats = new Set(subscription.handlers.statPaths?.() ?? [])
    const ownedStats = stats.filter(row => wantedStats.has(row.path))
    if (ownedStats.length > 0) subscription.handlers.onStats?.(ownedStats)
  }
}

/**
 * Next delay after a round — VS Code-style hot → steady → backoff.
 *
 * Exported for unit tests so cadence tables stay honest without driving
 * the whole broker clock.
 */
export function computeWatchDelay(input: {
  pendingNudge: boolean
  hidden: boolean
  degraded: boolean
  quietStreak: number
}): number {
  if (input.pendingNudge) return 0
  if (input.hidden) return TREE_WATCH_HIDDEN_MS
  if (input.degraded) return TREE_WATCH_DEGRADED_MS
  const streak = input.quietStreak
  if (streak <= 0) return TREE_WATCH_HOT_MS
  if (streak <= 2) return TREE_WATCH_ACTIVE_MS
  if (streak <= 6) return Math.min(TREE_WATCH_IDLE_MS, TREE_WATCH_ACTIVE_MS * 2)
  return TREE_WATCH_IDLE_MS
}

/** Idle delay for the next round (honours a coalesced nudge). */
function nextDelay(channel: Channel): number {
  const delay = computeWatchDelay({
    pendingNudge: channel.pendingNudge,
    hidden: hidden(),
    degraded: channel.degraded,
    quietStreak: channel.quietStreak,
  })
  if (channel.pendingNudge) channel.pendingNudge = false
  return delay
}

/** Mark the channel hot (activity just happened). */
function markActive(channel: Channel): void {
  channel.quietStreak = 0
}

/**
 * Advance / reset the quiet streak after a round.
 *
 * Open-file stat probes cap the streak so external-edit detection stays near
 * {@link TREE_WATCH_ACTIVE_MS} even when a quiet tree would otherwise back
 * off to the idle ceiling (the open file's parent may not be in `dirs`).
 * Only real watch activity resets to HOT — a periodic full sweep must not,
 * or every {@link TREE_WATCH_FALLBACK_MS} would pin the loop at 250ms.
 */
function noteQuietRound(
  channel: Channel,
  hadActivity: boolean,
  needsStats: boolean,
): void {
  if (hadActivity) {
    markActive(channel)
    return
  }
  channel.quietStreak += 1
  if (needsStats) {
    channel.quietStreak = Math.min(channel.quietStreak, 2)
  }
}

/** One poll round: sync the watch set, then re-list what changed. */
async function run(channel: Channel): Promise<void> {
  if (channel.busy || channel.subscriptions.size === 0) return
  const { dirs, statPaths } = collect(channel)
  if (dirs.length === 0 && statPaths.length === 0) {
    channel.quietStreak += 1
    schedule(channel, nextDelay(channel))
    return
  }
  channel.busy = true
  try {
    // An editor-only subscription (no tree panel, so no directories) still
    // needs its stat probe; there is nothing to reconcile in that case, so the
    // watch round is skipped rather than sent as an empty request.
    const sync = dirs.length === 0
      ? { changed: [], seq: channel.seq, missed: false, unwatched: [] as string[] }
      : await api.fsWatchSync(channel.scope, dirs, channel.seq, channel.subscriber)
    channel.seq = sync.seq
    // Degraded is an internal cadence decision, not a UI signal: a level the
    // host cannot watch refreshes through the sweep below, so the only thing
    // it changes is how often that sweep runs.
    channel.degraded = sync.unwatched.length > 0
    const now = Date.now()
    const dueSweep = channel.lastSweepAt === 0
      || (now - channel.lastSweepAt) >= TREE_WATCH_FALLBACK_MS
    // Periodic full sweep: covers dropped/coalesced watch events. `missed`
    // means the host cursor was stale — trust nothing, re-read everything.
    // `unwatched` levels are re-read EVERY round (they can never show up in
    // `changed`); the degraded delay keeps that path honest without
    // re-listing healthy levels every tick.
    const sweepAll = sync.missed || dueSweep
    const dirty = sweepAll
      ? new Set(dirs)
      : new Set([...sync.changed, ...sync.unwatched])
    if (sweepAll && dirs.length > 0) channel.lastSweepAt = now

    // Real OS/watch signal only — a dueSweep that dirties every dir is not
    // "activity" for backoff purposes (otherwise the 30s backstop keeps the
    // loop hot forever).
    const hadWatchActivity = sync.missed || sync.changed.length > 0 || sync.unwatched.length > 0
    const needsStats = statPaths.length > 0
    if (dirty.size === 0 && !needsStats) {
      noteQuietRound(channel, hadWatchActivity, needsStats)
      schedule(channel, nextDelay(channel))
      return
    }
    const batch = await api.fsTreeBatch(channel.scope, [...dirty], needsStats ? statPaths : [])
    const levels: TreeWatchLevel[] = []
    for (const listing of batch.listings) {
      if (listing.entries === undefined) continue
      levels.push({ path: listing.path, entries: listing.entries, truncated: listing.truncated === true })
    }
    dispatch(channel, levels, batch.stats)
    // Quiet stats probes must not pin HOT; open-file caps keep them at ACTIVE.
    noteQuietRound(channel, hadWatchActivity, needsStats)
    schedule(channel, nextDelay(channel))
  } catch {
    // The host may be restarting or the fence may refuse this scope: slow
    // down and retry rather than spinning or surfacing an error on every tick.
    // A nudge still wins — the user just saved / the tab just woke.
    schedule(channel, channel.pendingNudge ? nextDelay(channel) : TREE_WATCH_ERROR_MS)
  } finally {
    channel.busy = false
  }
}

/**
 * Subscribe one surface (a file tree, an editor) to incremental refresh.
 *
 * @returns an unsubscribe function; the last unsubscribe stops the poller.
 */
export function subscribeTreeWatch(scope: SessionScope, handlers: TreeWatchHandlers): () => void {
  const key = channelKey(scope)
  let channel = channels.get(key)
  if (channel === undefined) {
    channel = {
      scope,
      subscriber: subscriberOf(scope),
      subscriptions: new Set(),
      seq: 0,
      timer: undefined,
      busy: false,
      pendingNudge: false,
      quietStreak: 0,
      lastSweepAt: 0,
      degraded: false,
    }
    channels.set(key, channel)
  }
  const subscription: Subscription = { handlers }
  channel.subscriptions.add(subscription)
  // Poll immediately for the first pane AND for a later one joining an
  // already-polling channel — otherwise the new editor's first stat (or a
  // tree that mounts after the editor) waits a full idle beat.
  markActive(channel)
  if (!channel.busy) {
    schedule(channel, hidden() ? TREE_WATCH_HIDDEN_MS : 0)
  } else {
    channel.pendingNudge = true
  }
  return () => {
    const current = channels.get(key)
    if (current === undefined) return
    current.subscriptions.delete(subscription)
    if (current.subscriptions.size > 0) return
    stopTimer(current)
    channels.delete(key)
  }
}

/**
 * Pull the next watch round forward now (editor save, explicit refresh,
 * visibility wake). Coalesces with an in-flight round via `pendingNudge`
 * so the finally-path runs again immediately instead of parking on idle.
 */
export function nudgeTreeWatch(scope: SessionScope): void {
  const channel = channels.get(channelKey(scope))
  if (channel === undefined || channel.subscriptions.size === 0) return
  markActive(channel)
  if (channel.busy) {
    channel.pendingNudge = true
    return
  }
  schedule(channel, 0)
}

/** Wake every live channel (tab became visible again). */
export function wakeTreeWatch(): void {
  for (const channel of channels.values()) {
    if (channel.subscriptions.size === 0) continue
    markActive(channel)
    if (channel.busy) {
      channel.pendingNudge = true
      continue
    }
    schedule(channel, 0)
  }
}

/** Test seam: drop every channel and timer. */
export function resetTreeWatch(): void {
  for (const channel of channels.values()) stopTimer(channel)
  channels.clear()
}

/**
 * Stable signature of a level's rows.
 *
 * Two listings with the same signature are interchangeable for rendering,
 * which is what lets the tree skip a `setState` (and the reconcile that comes
 * with it) on an idle poll. Ordering IS part of the key even though the rows
 * carry their own sort: a re-order is a real change the user would notice, and
 * the host sorts deterministically, so an unchanged directory produces a
 * byte-identical signature.
 *
 * Only render-visible fields are folded in. A directory's mtime changing
 * without its row set changing is exactly the case this whole path exists to
 * ignore (open-file content refresh is the editor's stat probe, not the tree).
 */
export function levelSignature(entries: readonly FsEntry[]): string {
  return entries
    .map(entry => `${entry.isDir ? 'd' : 'f'}${entry.name}${entry.broken ? '!' : ''}${entry.isSymlink ? '@' : ''}`)
    .join('|')
}

/**
 * The tree's per-level cache entry, as far as reconciliation cares.
 *
 * `error` is declared but never read here: it is part of the tree's level
 * shape, and a fresh listing overwrites the whole entry (rows and error
 * together), so this function has no reason to look at it.
 */
export interface LevelCacheEntry {
  entries?: FsEntry[]
  error?: string
}

/**
 * Reconcile one re-listed level against what the tree already shows.
 *
 * Two deliberate refusals, both about who owns a directory:
 * - An ABSENT level was never loaded, so the refresh must not fill it — the
 *   tree decides when a directory is read, and seeding it here would
 *   materialise subtrees the user never expanded.
 * - An unchanged level returns undefined so the caller can skip the state
 *   write entirely, which is the whole point of the poll.
 *
 * A level that exists but has no rows (the placeholder `loadDir` writes while
 * its own request is in flight, or a level whose request failed) takes the
 * fresh listing verbatim — that is how a watch round repairs a stale error row
 * or a load that never landed.
 */
export function reconcileLevel(
  current: LevelCacheEntry | undefined,
  fresh: readonly FsEntry[],
): FsEntry[] | undefined {
  if (current === undefined) return undefined
  if (current.entries === undefined) return [...fresh]
  return levelSignature(current.entries) === levelSignature(fresh) ? undefined : [...fresh]
}

// Visibility wake: one document listener for the whole broker. Absent
// `document` (Node tests) is a no-op — tests drive timers directly.
try {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) wakeTreeWatch()
    })
  }
} catch {
  // Non-DOM hosts leave the broker timer-driven only.
}
