/**
 * Unit tests for the explorer's incremental-refresh client half.
 *
 * Two layers are covered: the pure signature/merge functions that decide
 * whether a re-listed level is worth a re-render, and the broker that owns the
 * polling round (request merging, cursor advance, degrade handling). The
 * broker tests drive real timers through `vi.advanceTimersByTimeAsync` so the
 * cadence and the in-flight guard are exercised as written, with `api` mocked
 * — no network, no React tree, no filesystem.
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

const { levelSignature, reconcileLevel, resetTreeWatch, subscribeTreeWatch } = await import('../src/client/tree-watch.ts')

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

/** Let the broker run one active-cadence round. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_200)
}

beforeEach(() => {
  vi.useFakeTimers()
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
    // Writing an unloaded level would seed the cache with a directory the user
    // never expanded, and the tree would render rows it cannot explain.
    expect(reconcileLevel(undefined, [entry('a.ts')])).toBeUndefined()
  })

  it('repairs a level that has rows only as a placeholder or a stale error', () => {
    // These are the states loadDir writes before/after a failed `fs.tree`; a
    // watch round is their only other source of truth.
    expect(reconcileLevel({}, [entry('a.ts')])?.map(row => row.name)).toEqual(['a.ts'])
    expect(reconcileLevel({ error: 'EACCES' }, [entry('a.ts')])?.map(row => row.name)).toEqual(['a.ts'])
  })

  it('skips the write when the fresh listing matches', () => {
    expect(reconcileLevel({ entries: [entry('a.ts')] }, [entry('a.ts')])).toBeUndefined()
  })
})

describe('tree-watch broker', () => {
  it('polls once with the merged subscription and re-lists only dirty levels', async () => {
    const seen: string[][] = []
    subscribeTreeWatch(scope, {
      dirs: () => ['/w/a', '/w/b'],
      onLevels: (levels) => { seen.push(levels.map(level => level.path)) },
    })
    fsWatchSync.mockResolvedValue({ changed: ['/w/b'], seq: 7, missed: false, unwatched: [] })
    fsTreeBatch.mockResolvedValue({ listings: [{ path: '/w/b', entries: [entry('b.ts')], truncated: false }], stats: [] })

    await tick()

    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsWatchSync.mock.calls[0]?.[1]).toEqual(['/w/a', '/w/b'])
    expect(fsWatchSync.mock.calls[0]?.[2]).toBe(0)
    expect(fsWatchSync.mock.calls[0]?.[3]).toBe('s1//w')
    expect(fsTreeBatch.mock.calls[0]?.[1]).toEqual(['/w/b'])
    expect(seen).toEqual([['/w/b']])

    // The next round carries the host's cursor forward, so a consumed event
    // is never re-delivered.
    await tick()
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
    fsWatchSync.mockResolvedValue({ changed: ['/w/a', '/w/b'], seq: 1, missed: false, unwatched: [] })
    fsTreeBatch.mockResolvedValue({
      listings: [
        { path: '/w/a', entries: [entry('a.ts')], truncated: false },
        { path: '/w/b', entries: [entry('b.ts')], truncated: false },
      ],
      stats: [],
    })

    await tick()

    expect(left).toEqual([['/w/a']])
    expect(right).toEqual([['/w/b']])
  })

  it('skips the batch entirely when nothing changed and no stat is wanted', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsTreeBatch).not.toHaveBeenCalled()
  })

  it('re-reads the whole subscription when the cursor was missed', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a', '/w/b'], onLevels: () => {} })
    // The host answers a stale cursor with the full subscription; the client
    // must trust it and re-read, not wait for the next event.
    fsWatchSync.mockResolvedValue({ changed: ['/w/a', '/w/b'], seq: 99, missed: true, unwatched: [] })

    await tick()

    expect([...(fsTreeBatch.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('re-reads an unwatched level this round instead of waiting for an event', async () => {
    subscribeTreeWatch(scope, {
      dirs: () => ['/w/a', '/w/locked'],
      onLevels: () => {},
    })
    fsWatchSync.mockResolvedValue({ changed: [], seq: 1, missed: false, unwatched: ['/w/locked'] })

    await tick()
    // An unwatchable directory never appears in `changed`; without this the
    // tree would freeze on it until some unrelated event woke it up.
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
      listings: [],
      stats: [
        { path: '/w/a/one.ts', mtimeMs: 5, size: 1 },
        { path: '/w/a/two.ts', mtimeMs: 6, size: 2 },
      ],
    })

    await tick()

    expect([...(fsTreeBatch.mock.calls[0]?.[2] ?? [])].sort()).toEqual(['/w/a/one.ts', '/w/a/two.ts'])
    expect(statsSeen).toEqual([['/w/a/one.ts'], ['/w/a/two.ts']])
  })

  it('sweeps the full subscription periodically so a dropped event still lands', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a', '/w/b'], onLevels: () => {} })
    // Nineteen idle rounds (nothing ever reported dirty) cost zero listings.
    for (let round = 0; round < 19; round += 1) await tick()
    expect(fsTreeBatch).not.toHaveBeenCalled()

    // The twentieth is the sweep — the backstop for a dropped watch event.
    await tick()
    expect([...(fsTreeBatch.mock.calls[0]?.[1] ?? [])].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('retries after a failure instead of throwing or stacking rounds', async () => {
    subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    fsWatchSync.mockRejectedValueOnce(new Error('host restarting'))

    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    expect(fsTreeBatch).not.toHaveBeenCalled()

    // The error cadence (4s) is longer than the active one, so the next tick
    // stays quiet; the retry lands 4s after the failed round, not on the
    // active cadence.
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_800)
    expect(fsWatchSync).toHaveBeenCalledTimes(2)
  })

  it('stops polling once the last subscriber leaves', async () => {
    const stop = subscribeTreeWatch(scope, { dirs: () => ['/w/a'], onLevels: () => {} })
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)

    stop()
    await tick()
    expect(fsWatchSync).toHaveBeenCalledTimes(1)
  })
})
