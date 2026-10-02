/**
 * Directory watch registry behind `fs.watch.sync`: the explorer asks "did
 * anything under the directories I am showing change?" and this answers
 * without re-reading those directories.
 *
 * Why not just poll `fs.tree`: a poll of every expanded level re-runs
 * `opendir` on each one (a level with a few thousand entries is not free),
 * and the answer is almost always "no". A native `fs.watch` per expanded
 * level is one handle per directory and fires within milliseconds of the
 * write, so the client only pays the listing cost when something really
 * changed.
 *
 * Shape of the protocol:
 * - The client calls `sync(subscriber, keys, since)` with the exact set of
 *   directories it wants watched. Registration is a diff against what THIS
 *   subscriber held last round: keys that vanished drop their subscription
 *   (a collapsed tree unsubscribes simply by omitting the key), new keys get
 *   a subscription. There is no separate teardown route, so a closed session
 *   leaks nothing as long as its pane sends one final sync — and the
 *   reference counting below means two windows on one session never close
 *   each other's handles.
 * - Every watcher event bumps a monotonic sequence number and appends
 *   `{key, seq}` to a bounded log. `sync` replays the log past the caller's
 *   `since` cursor, so several clients (or two sidebar windows) each keep
 *   their own cursor and none of them consumes anyone else's events.
 * - The log is a ring: when it overflows, the client's cursor is declared
 *   `missed` and it gets its full subscription back. A watcher that cannot
 *   be opened at all (EPERM, ENOSPC on inotify, a path that vanished) comes
 *   back as `unwatched` — the client degrades that scope to a slow full
 *   listing instead of silently showing a frozen tree. A watcher that dies
 *   later (the platform dropped it) invalidates its key, which forces that
 *   key into the next round's `changed` and re-arms the handle, so the gap
 *   between the drop and the re-arm is never silent.
 *
 * Watchers are deliberately non-recursive: the explorer registers exactly
 * the levels it has expanded, so one handle per visible row-group and no
 * blind subtree traversal of a huge tree.
 */
import { watch, type FSWatcher } from 'node:fs'

/** One watcher handle plus the state the replay log needs. */
interface WatchEntry {
  key: string
  /** Close the handle; safe to call twice. */
  close(): void
}

/** One recorded change event. */
interface ChangeRecord {
  key: string
  seq: number
}

/** The minimum a platform watcher must provide (test seam). */
export interface WatchHandle {
  close(): void
}

/** Factory seam so the unit tests can drive events without the real FS. */
export interface DirectoryWatchRegistryOptions {
  /**
   * Open one watcher on a directory; defaults to `fs.watch`.
   * @param dir - the absolute directory to watch.
   * @param onChange - a filesystem event fired (already coalesced by the OS).
   * @param onError - the handle died (the platform dropped it, EPERM, …);
   *   the registry invalidates the key and re-arms it on the next sync.
   */
  open?: (dir: string, onChange: () => void, onError: () => void) => WatchHandle
  /** Replay-log capacity (changes older than this force a full re-read). */
  logLimit?: number
}

/** What one `sync` call reports back to a client. */
export interface DirectoryWatchSyncResult {
  /** Subscribed directories that changed since the cursor. */
  changed: string[]
  /** Cursor to pass as `since` on the next sync. */
  seq: number
  /** The cursor fell out of the replay log: `changed` is the full set. */
  missed: boolean
  /** Subscribed directories whose watcher could not be opened. */
  unwatched: string[]
}

/** How many change records the replay log keeps before declaring cursors stale. */
const DEFAULT_LOG_LIMIT = 2048

/** Subscriber id used when a caller does not name itself (single client). */
const DEFAULT_SUBSCRIBER = '\0default'

/** `fs.watch` with no listeners keeps the process busy on some platforms. */
function openNativeWatcher(dir: string, onChange: () => void, onError: () => void): WatchHandle {
  const watcher: FSWatcher = watch(dir, { persistent: false }, () => { onChange() })
  watcher.on('error', () => { onError() })
  return { close: () => { watcher.close() } }
}

export class DirectoryWatchRegistry {
  /** Live handles, keyed by watch key (shared across subscribers). */
  private readonly entries = new Map<string, WatchEntry>()
  /** Per-subscriber key sets: the source of truth for reference counting. */
  private readonly subscribers = new Map<string, Set<string>>()
  /** Keys whose handle died or could not be opened; forced into `changed`. */
  private readonly invalidated = new Set<string>()
  /** Bounded replay log; the head is dropped once it exceeds `logLimit`. */
  private log: ChangeRecord[] = []
  /** Sequence of the oldest DROPPED record (0 → nothing dropped yet). */
  private oldestSeq = 0
  private seq = 0
  private readonly open: (dir: string, onChange: () => void, onError: () => void) => WatchHandle
  private readonly logLimit: number

  constructor(options: DirectoryWatchRegistryOptions = {}) {
    this.open = options.open ?? openNativeWatcher
    this.logLimit = Math.max(1, options.logLimit ?? DEFAULT_LOG_LIMIT)
  }

  /**
   * Reconcile ONE subscriber's watched set and replay changes since `since`.
   *
   * Keys are opaque to the registry — the route maps them back to paths — and
   * a key normally carries its session prefix (`<sessionId>\0<dir>`) so two
   * sessions watching the same folder get independent cursors.
   *
   * @param subscriber - identity of the calling client surface (an empty or
   *   missing value collapses to one shared subscriber).
   * @param keys - the complete set of directories this surface is showing.
   * @param since - the cursor from the previous sync.
   */
  sync(subscriber: string, keys: readonly string[], since: number): DirectoryWatchSyncResult {
    const id = subscriber === '' ? DEFAULT_SUBSCRIBER : subscriber
    const wanted = new Set(keys)
    const held = this.subscribers.get(id) ?? new Set<string>()

    // Drop this subscriber's stale subscriptions; a key whose last holder
    // left is closed (a collapsed tree really does release its handle).
    for (const key of held) {
      if (wanted.has(key)) continue
      held.delete(key)
      if (this.heldBy(key)) continue
      this.closeKey(key)
    }

    const unwatched: string[] = []
    const reopened = new Set<string>()
    for (const key of wanted) {
      if (!this.entries.has(key) && this.watchKey(key) !== undefined) reopened.add(key)
      // A key whose handle could not be opened keeps its subscription anyway:
      // the client's `unwatched` report drives its degraded cadence, and the
      // next round retries the open.
      else if (!this.entries.has(key)) unwatched.push(key)
      held.add(key)
    }
    this.subscribers.set(id, held)

    // A cursor outside the retained window cannot be served faithfully, and a
    // key whose handle died may have missed events nobody logged.
    const stale = since < this.oldestSeq || since > this.seq
    const changed = new Set<string>()
    if (stale) {
      for (const key of wanted) changed.add(key)
    } else {
      for (const record of this.log) {
        if (record.seq > since && wanted.has(record.key)) changed.add(record.key)
      }
    }
    for (const key of wanted) {
      if (this.invalidated.has(key)) changed.add(key)
    }
    // The re-armed key's dead-handle window is now covered by `changed`, so it
    // is safe to forget — clearing it earlier (in watchKey) would let the
    // exact gap this flag exists for pass silently.
    for (const key of reopened) this.invalidated.delete(key)
    return { changed: [...changed], seq: this.seq, missed: stale, unwatched }
  }

  /** Close every watcher and forget every subscriber (plugin unload). */
  dispose(): void {
    for (const entry of this.entries.values()) entry.close()
    this.entries.clear()
    this.subscribers.clear()
    this.invalidated.clear()
    this.log = []
    this.oldestSeq = 0
    this.seq = 0
  }

  /** Number of live watchers (tests + diagnostics). */
  get size(): number {
    return this.entries.size
  }

  /** Whether any subscriber other than the holder still wants this key. */
  private heldBy(key: string): boolean {
    for (const held of this.subscribers.values()) {
      if (held.has(key)) return true
    }
    return false
  }

  /** Close one key's handle if it has one, and clear its invalidation. */
  private closeKey(key: string): void {
    this.entries.get(key)?.close()
    this.entries.delete(key)
    this.invalidated.delete(key)
  }

  /**
   * Open one watcher, recording every event into the replay log.
   *
   * @returns the entry, or undefined when the platform refused the handle.
   */
  private watchKey(key: string): WatchEntry | undefined {
    // The registry is keyed by `<sessionId>\0<dir>`; the directory is the
    // tail, so a failure message can still name the path it came from. A key
    // with no prefix (tests, or a single-tenant route) is its own directory.
    const dir = key.slice(key.indexOf('\0') + 1)
    let handle: WatchHandle
    try {
      handle = this.open(dir, () => { this.record(key) }, () => { this.invalidate(key) })
    } catch {
      return undefined
    }
    const entry: WatchEntry = { key, close: () => { handle.close() } }
    this.entries.set(key, entry)
    return entry
  }

  /** Drop a dead handle; the next sync re-arms it and reports the change. */
  private invalidate(key: string): void {
    this.entries.get(key)?.close()
    this.entries.delete(key)
    this.invalidated.add(key)
  }

  /** Append one change record and trim the ring. */
  private record(key: string): void {
    this.seq += 1
    this.log.push({ key, seq: this.seq })
    while (this.log.length > this.logLimit) {
      const dropped = this.log.shift()
      if (dropped !== undefined) this.oldestSeq = dropped.seq
    }
  }
}