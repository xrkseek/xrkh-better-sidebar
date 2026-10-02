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
 * The poller is deliberately dumb about content — it hands raw levels to the
 * subscribers and lets each one diff what it shows. That keeps the "did
 * anything change" decision in one place (the host's watch log) while the
 * "should I re-render" decision stays with the component that owns the state.
 *
 * Reliability: `fs.watch` is best-effort on every platform (inotify queues
 * overflow, FSEvents coalesces, network shares may not notify at all). So the
 * loop also re-reads the full subscription periodically, which turns a lost
 * event into a delayed refresh instead of a frozen tree. When the page is
 * hidden the cadence relaxes; a background tab needs no millisecond freshness.
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

/** Fresh cadence while the page is in front. */
const ACTIVE_INTERVAL_MS = 1_200

/** Relaxed cadence while hidden (a background tab refreshes lazily). */
const HIDDEN_INTERVAL_MS = 6_000

/** Cadence after a failed round (host restarting, fence refusal). */
const ERROR_INTERVAL_MS = 4_000

/** Full-subscription re-read cadence, in rounds — the lost-event backstop. */
const FALLBACK_EVERY_ROUNDS = 20

/**
 * The same backstop while the host reports unwatchable levels.
 *
 * Those levels get no events at all, so the sweep is their only refresh path;
 * it runs more often than the healthy cadence because it is the only signal
 * they have, and still slow enough that an unwatchable tree costs a handful of
 * `opendir` calls rather than one per tick.
 */
const DEGRADED_SWEEP_ROUNDS = 5

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
  rounds: number
  /** The host reported unwatchable levels — fall back to slow full reads. */
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

/** One poll round: sync the watch set, then re-list what changed. */
async function run(channel: Channel): Promise<void> {
  if (channel.busy || channel.subscriptions.size === 0) return
  const { dirs, statPaths } = collect(channel)
  if (dirs.length === 0 && statPaths.length === 0) {
    schedule(channel, hidden() ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS)
    return
  }
  channel.busy = true
  try {
    // An editor-only subscription (no tree panel, so no directories) still
    // needs its stat probe; there is nothing to reconcile in that case, so the
    // watch round is skipped rather than sent as an empty request.
    const sync = dirs.length === 0
      ? { changed: [], seq: channel.seq, missed: false, unwatched: [] }
      : await api.fsWatchSync(channel.scope, dirs, channel.seq, channel.subscriber)
    channel.seq = sync.seq
    channel.rounds += 1
    // Degraded is an internal cadence decision, not a UI signal: a level the
    // host cannot watch refreshes through the sweep below, so the only thing
    // it changes is how often that sweep runs.
    channel.degraded = sync.unwatched.length > 0
    // Periodic full sweep: covers dropped/coalesced watch events and any
    // directory whose watcher could not be opened at all. `unwatched` levels
    // are re-read THIS round (they can never show up in `changed`), and the
    // faster degraded sweep carries them after that.
    const sweepEvery = channel.degraded ? DEGRADED_SWEEP_ROUNDS : FALLBACK_EVERY_ROUNDS
    const dirty = channel.rounds % sweepEvery === 0
      ? new Set(dirs)
      : new Set([...sync.changed, ...sync.unwatched])
    const needsStats = statPaths.length > 0
    if (dirty.size === 0 && !needsStats) {
      schedule(channel, hidden() ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS)
      return
    }
    const batch = await api.fsTreeBatch(channel.scope, [...dirty], needsStats ? statPaths : [])
    const levels: TreeWatchLevel[] = []
    for (const listing of batch.listings) {
      if (listing.entries === undefined) continue
      levels.push({ path: listing.path, entries: listing.entries, truncated: listing.truncated === true })
    }
    dispatch(channel, levels, batch.stats)
    schedule(channel, hidden() ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS)
  } catch {
    // The host may be restarting or the fence may refuse this scope: slow
    // down and retry rather than spinning or surfacing an error on every tick.
    schedule(channel, ERROR_INTERVAL_MS)
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
      rounds: 0,
      degraded: false,
    }
    channels.set(key, channel)
  }
  const subscription: Subscription = { handlers }
  channel.subscriptions.add(subscription)
  if (channel.timer === undefined && !channel.busy) {
    schedule(channel, hidden() ? HIDDEN_INTERVAL_MS : ACTIVE_INTERVAL_MS)
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
 * ignore.
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
