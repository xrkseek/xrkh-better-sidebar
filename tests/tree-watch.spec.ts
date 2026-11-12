/**
 * Unit tests for the explorer's incremental-refresh client half.
 *
 * Two layers are covered: the pure signature/merge/cadence helpers, and the
 * broker that owns the polling round (request merging, cursor advance,
 * degrade handling, adaptive backoff). Timers are fake; `api` is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsBatchListing, FsStatInfo, FsWatchSyncResult } from '../src/client/api.ts'

const fsWatchSync = vi.fn<(scope: unknown, dirs: string[], since: number, subscriber: string) => Promise<FsWatchSyncResult>>()
const fsTreeBatch = vi.fn<(scope: unknown, dirs: string[], stats: string[]) => Promise<{ listings: FsBatchListing[]; stats: FsStatInfo[] }>>()

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsWatchSync: (...args: Parameters<typeof fsWatchSync>) => fsWatchSync(...args),
    fsTreeBatch: (...args: Parameters<typeof fsTreeBatch>) => fsTreeBatch(...args),
  },
}))

const {
  levelSignature,
  reconcileLevel,
  resetTreeWatch,
  subscribeTreeWatch,
  nudgeTreeWatch,
  computeWatchDelay,
  TREE_WATCH_HOT_MS,
  TREE_WATCH_ACTIVE_MS,
  TREE_WATCH_IDLE_MS,
  TREE_WATCH_DEGRADED_MS,
  TREE_WATCH_HIDDEN_MS,
  TREE_WATCH_ERROR_MS,
  TREE_WATCH_FALLBACK_MS,
} = await import('../src/client/tree-watch.ts')

/** The scope every test polls; one channel is keyed on it. */
const scope = { sessionId: 's1', cwd: '/w' }

/** A minimal explorer row. */
function entry(name: string, extra: Partial<{ isDir: boolean; isSymlink: boolean; broken: boolean }> = {}) {
  return {
    name,
    path: `/w/${name}`,
    isDir: false,
    hidden: false,
    isSymlink: false,
    broken: false,
    ...extra,
  }
}

/**
 * Fire any timer due at "now" (the subscribe `schedule(0)` path and a
 * coalesced nudge). Does NOT advance into the next idle beat.
 */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/** Wait `ms`, then fire the scheduled round. */
async function after(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  fsWatchSync.mockReset()
  fsTreeBatch.mockReset()
  fsWatchSync.mockResolvedValue({ changed: [], seq: 0, missed: false, unwatched: [] })
  fsTreeBatch.mockResolvedValue({ listings: [], stats: [] })
})

afterEach(() => {
  resetTreeWatch()
  vi.useRealTimers()
})

describe('levelSignature', () => {
  it('treats an unchanged listing as identical and a renamed row as a change', () => {
    const rows = [entry('a.ts'), entry('src', { isDir: true })]
    expect(levelSignature(rows)).toBe(levelSignature([entry('a.ts'), entry('src', { isDir: true })]))
    expect(levelSignature(rows)).not.toBe(levelSignature([entry('a.ts'), entry('src')]))
  })

  it('folds in the row flags that change how a row renders', () => {
    expect(levelSignature([entry('link', { isSymlink: true })])).not.toBe(levelSignature([entry('link')]))
    expect(levelSignature([entry('link', { broken: true })])).not.toBe(levelSignature([entry('link')]))
  })
})

describe('reconcileLevel', () => {
  it('returns undefined when nothing visible changed, and a new array when it did', () => {
    const current = [entry('a.ts')]
    expect(reconcileLevel({ entries: current }, [entry('a.ts')])).toBeUndefined()
    const merged = reconcileLevel({ entries: current }, [entry('a.ts'), entry('b.ts')])
    expect(merged?.map(row => row.name)).toEqual(['a.ts', 'b.ts'])
    expect(merged).not.toBe(current)
  })

  it('never invents a level the tree has not loaded', () => {
    expect(reconcileLevel(undefined, [entry('a.ts')])).toBeUndefined()
  })

  it('repairs a level that has rows only as a placeholder or a stale error', () => {
    expect(reconcileLevel({}, [entry('a.ts')])?.map(row => row.name)).toEqual(['a.ts'])
    expect(reconcileLevel({ error: 'EACCES' }, [entry('a.ts')])?.map(row => row.name)).toEqual(['a.ts'])
  })

  it('skips the write when the fresh listing matches', () => {
    expect(reconcileLevel({ entries: [entry('a.ts')] }, [entry('a.ts')])).toBeUndefined()
  })
})

describe('computeWatchDelay', () => {
  it('returns 0 for a coalesced nudge', () => {
    expect(computeWatchDelay({ pendingNudge: true, hidden: false, degraded: false, quietStreak: 99 })).toBe(0)
  })

  it('uses the hidden / degraded fixed cadences', () => {
    expect(computeWatchDelay({ pendingNudge: false, hidden: true, degraded: false, quietStreak: 0 })).toBe(TREE_WATCH_HIDDEN_MS)
    expect(computeWatchDelay({ pendingNudge: false, hidden: false, degraded: true, quietStreak: 0 })).toBe(TREE_WATCH_DEGRADED_MS)
  })

  it('backs off from hot → active → idle like VS Code / chokidar', () => {
    expect(computeWatchDelay({ pendingNudge: false, hidden: false, degraded: false, quietStreak: 0 })).toBe(TREE_WATCH_HOT_MS)
    expect(computeWatchDelay({ pendingNudge: false, hidden: false, degraded: false, quietStreak: 1 })).toBe(TREE_WATCH_ACTIVE_MS)
    expect(computeWatchDelay({ pendingNudge: false, hidden: false, degraded: false, quietStreak: 3 })).toBe(
      Math.min(TREE_WATCH_IDLE_MS, TREE_WATCH_ACTIVE_MS * 2),
    )
    expect(computeWatchDelay({ pendingNudge: false, hidden: false, degraded: false, quietStreak: 9 })).toBe(TREE_WATCH_IDLE_MS)
  })
})

describe('tree-watch broker', () => {
  it('polls once with the merged subscription and re-lists only dirty levels', async () => {
    const seen: string[][] = []
    subscribeTreeWatch(scope, {
      dirs: () => ['/w/a', '/w/b'],
      onLevels: (levels) => { seen.push(levels.map(level => level.path)) },
    })
    // First round is a dueSweep (lastSweepAt=0) — skip past it.
    await tick()
    expect(fsTreeBatch).toHaveBeenCalled()
    fsWatchSync.mockClear()
    fsTreeBatch.mockClear()
    seen.length = 0

    fsWatchSync.mockResolvedValue({ changed: ['/w/b'], seq: 7, missed: false, unwatched: [] })
    fsTreeBatch.mockResolvedValue({ listings: [{ path: '/w/b', entries: [entry('b.ts')], truncated: false }], stats: [] })

    // After a quiet initial sweep the streak is 1 → ACTIVE, not HOT.
    await after(TREE_WATCH_ACTIVE_MS)
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsWatchSync.mock.calls[0]?.[1]).toEqual(['/w/a', '/w/b'])
    expect(fsTreeBatch.mock.calls[0]?.[1]).toEqual(['/w/b'])
    expect(seen).toEqual([['/w/b']])

    // Activity resets to HOT for the follow-up pull.
    fsWatchSync.mockResolvedValue({ changed: [], seq: 7, missed: false, unwatched: [] })
    await after(TREE_WATCH_HOT_MS)
    expect(fsWatchSync.mock.calls[1]?.[2]).toBe(7)
  })

  it('merges several panes into one request pair', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    subscribeTreeWatch(scope, { dirs: () => ['/w/b'], onLevels: () => {} })

    await tick()

    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect([...(fsWatchSync.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('only hands a level to the panes that render it', async () => {
    const left: string[][] = []
    const right: string[][] = []
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: (levels) => { left.push(levels.map(l => l.path)) } })
    subscribeTreeWatch(scope, { dirs: () => ['/w/b'], onLevels: (levels) => { right.push(levels.map(l => l.path)) } })
    // First round sweeps everything (lastSweepAt=0).
    fsWatchSync.mockResolvedValue({ changed: [], seq: 1, missed: false, unwatched: [] })
    fsTreeBatch.mockResolvedValue({
      listings: [
        { path: '/w/a', entries: [entry('a.ts')], truncated: false },
        { path: '/w/b', entries: [entry('b.ts')], truncated: false },
      ],
      stats: [],
    })
    await tick()
    left.length = 0
    right.length = 0
    fsTreeBatch.mockClear()

    fsWatchSync.mockResolvedValue({ changed: ['/w/a', '/w/b'], seq: 2, missed: false, unwatched: [] })
    fsTreeBatch.mockResolvedValue({
      listings: [
        { path: '/w/a', entries: [entry('a.ts')], truncated: false },
        { path: '/w/b', entries: [entry('b.ts')], truncated: false },
      ],
      stats: [],
    })
    await after(TREE_WATCH_ACTIVE_MS)

    expect(left).toEqual([['/w/a']])
    expect(right).toEqual([['/w/b']])
  })

  it('skips the batch when nothing changed after the initial sweep and no stat is wanted', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    await tick() // initial dueSweep lists
    expect(fsTreeBatch).toHaveBeenCalledTimes(1)
    fsTreeBatch.mockClear()
    fsWatchSync.mockClear()

    fsWatchSync.mockResolvedValue({ changed: [], seq: 1, missed: false, unwatched: [] })
    await after(TREE_WATCH_ACTIVE_MS)
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsTreeBatch).not.toHaveBeenCalled()
  })

  it('re-reads the whole subscription when the cursor was missed', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a', '/w/b'], onLevels: () => {} })
    await tick()
    fsTreeBatch.mockClear()

    fsWatchSync.mockResolvedValue({ changed: [], seq: 99, missed: true, unwatched: [] })
    await after(TREE_WATCH_ACTIVE_MS)
    expect([...(fsTreeBatch.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('re-reads an unwatched level this round instead of waiting for an event', async () => {
    subscribeTreeWatch(scope, {
      dirs: () => ['/w/a', '/w/locked'],
      onLevels: () => {},
    })
    await tick()
    fsTreeBatch.mockClear()

    fsWatchSync.mockResolvedValue({ changed: [], seq: 1, missed: false, unwatched: ['/w/locked'] })
    await after(TREE_WATCH_ACTIVE_MS)
    expect(fsTreeBatch.mock.calls[0]?.[1]).toEqual(['/w/locked'])
  })

  it('folds stat probes into the same round and filters them per subscriber', async () => {
    const statsSeen: string[][] = []
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    subscribeTreeWatch(scope, {
      dirs: () => [],
      statPaths: () => ['/w/a/one.ts'],
      onLevels: () => {},
      onStats: (rows) => { statsSeen.push(rows.map(row => row.path)) },
    })
    subscribeTreeWatch(scope, {
      dirs: () => [],
      statPaths: () => ['/w/a/two.ts'],
      onLevels: () => {},
      onStats: (rows) => { statsSeen.push(rows.map(row => row.path)) },
    })
    fsTreeBatch.mockResolvedValue({
      listings: [{ path: '/w/a', entries: [], truncated: false }],
      stats: [
        { path: '/w/a/one.ts', mtimeMs: 5, size: 1 },
        { path: '/w/a/two.ts', mtimeMs: 6, size: 2 },
      ],
    })

    await tick()

    expect([...(fsTreeBatch.mock.calls[0]?.[2] ?? [])].sort()).toEqual(['/w/a/one.ts', '/w/a/two.ts'])
    expect(statsSeen).toEqual([['/w/a/one.ts'], ['/w/a/two.ts']])
  })

  it('time-based fallback sweep re-lists after TREE_WATCH_FALLBACK_MS', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a', '/w/b'], onLevels: () => {} })
    await tick() // initial sweep
    fsTreeBatch.mockClear()
    fsWatchSync.mockResolvedValue({ changed: [], seq: 1, missed: false, unwatched: [] })

    // Quiet rounds: no listings while under the fallback window.
    await after(TREE_WATCH_HOT_MS)
    await after(TREE_WATCH_ACTIVE_MS)
    expect(fsTreeBatch).not.toHaveBeenCalled()

    // Jump past the wall-clock backstop.
    vi.setSystemTime(new Date(Date.now() + TREE_WATCH_FALLBACK_MS + 1))
    await after(TREE_WATCH_IDLE_MS)
    expect([...(fsTreeBatch.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('retries after a failure instead of throwing or stacking rounds', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    fsWatchSync.mockRejectedValueOnce(new Error('host restarting'))

    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsTreeBatch).not.toHaveBeenCalled()

    await after(TREE_WATCH_ACTIVE_MS)
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    await after(TREE_WATCH_ERROR_MS - TREE_WATCH_ACTIVE_MS)
    expect(fsWatchSync).toHaveBeenCalledTimes(2)
  })

  it('coalesces nudge while a round is in flight into an immediate follow-up', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    fsWatchSync.mockImplementation(async () => {
      await gate
      return { changed: [], seq: 1, missed: false, unwatched: [] }
    })
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)

    nudgeTreeWatch(scope)
    release()
    await Promise.resolve()
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(2)
  })

  it('stops polling once the last subscriber leaves', async () => {
    const stop = subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)

    stop()
    await after(TREE_WATCH_IDLE_MS)
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
  })
})
