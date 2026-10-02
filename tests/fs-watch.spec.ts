/**
 * Unit tests for the directory-watch registry.
 *
 * The registry is the whole correctness surface of `fs.watch.sync`: it owns
 * reference counting across subscribers, per-subscriber cursors, and the
 * degrade signals the client needs when a watcher cannot run. All of that is
 * driven through an injected `open` factory here — no real filesystem, no
 * timing, and every lost-event path reachable on demand (a real platform
 * would need an unlucky inotify overflow to test the same branch).
 */
import { describe, expect, it } from 'vitest'
import { DirectoryWatchRegistry } from '../src/fs-watch.ts'

/** A registry plus the levers a test needs to drive the fake platform. */
interface Harness {
  registry: DirectoryWatchRegistry
  /** Directories whose `open` throws (EPERM, ENOSPC, a vanished path). */
  blocked: Set<string>
  /** Every directory an `open` call received, in order. */
  opened: string[]
  /** Every directory whose handle was closed, in order. */
  closed: string[]
  /** Fire one filesystem event on a directory. */
  change(dir: string): void
  /** Fire the handle-died event on a directory. */
  drop(dir: string): void
}

function harness(options: { logLimit?: number } = {}): Harness {
  const changes = new Map<string, () => void>()
  const failures = new Map<string, () => void>()
  const opened: string[] = []
  const closed: string[] = []
  const blocked = new Set<string>()
  const registry = new DirectoryWatchRegistry({
    logLimit: options.logLimit,
    open: (dir, onChange, onError) => {
      if (blocked.has(dir)) throw new Error(`EPERM: ${dir}`)
      opened.push(dir)
      changes.set(dir, onChange)
      failures.set(dir, onError)
      return {
        close: () => {
          closed.push(dir)
          changes.delete(dir)
          failures.delete(dir)
        },
      }
    },
  })
  return {
    registry,
    blocked,
    opened,
    closed,
    change: (dir) => { changes.get(dir)?.() },
    drop: (dir) => { failures.get(dir)?.() },
  }
}

describe('DirectoryWatchRegistry', () => {
  it('opens one watcher per newly subscribed directory and nothing on a repeat sync', () => {
    const h = harness()
    const first = h.registry.sync('win-1', ['/w/a'], 0)
    expect(h.opened).toEqual(['/w/a'])
    expect(first).toEqual({ changed: [], seq: 0, missed: false, unwatched: [] })

    const second = h.registry.sync('win-1', ['/w/a', '/w/b'], 0)
    expect(h.opened).toEqual(['/w/a', '/w/b'])
    expect(second.unwatched).toEqual([])
    expect(h.registry.size).toBe(2)
  })

  it('reports only the directories that changed past the cursor', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a', '/w/b'], 0)
    h.change('/w/a')

    const dirty = h.registry.sync('win-1', ['/w/a', '/w/b'], 0)
    expect(dirty.changed).toEqual(['/w/a'])
    expect(dirty.seq).toBe(1)
    expect(dirty.missed).toBe(false)

    // A consumed event must not come back on the next round.
    expect(h.registry.sync('win-1', ['/w/a', '/w/b'], 1).changed).toEqual([])
  })

  it('strips the session prefix before opening a watcher', () => {
    const h = harness()
    h.registry.sync('win-1', ['sess-7\0/w/a'], 0)
    expect(h.opened).toEqual(['/w/a'])
  })

  it('keeps a handle alive while another subscriber still holds it', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a', '/w/shared'], 0)
    h.registry.sync('win-2', ['/w/shared'], 0)

    // win-1 collapses the shared row; win-2 still shows it.
    h.registry.sync('win-1', ['/w/a'], 0)
    expect(h.closed).toEqual([])
    expect(h.registry.size).toBe(2)

    h.registry.sync('win-2', [], 0)
    expect(h.closed).toEqual(['/w/shared'])
    expect(h.registry.size).toBe(1)
  })

  it('never lets one subscriber consume another subscriber\'s events', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a'], 0)
    h.registry.sync('win-2', ['/w/a'], 0)
    h.change('/w/a')

    expect(h.registry.sync('win-2', ['/w/a'], 0).changed).toEqual(['/w/a'])
    // win-1 is at cursor 1: the event is not re-delivered, only advanceable.
    const behind = h.registry.sync('win-1', ['/w/a'], 1)
    expect(behind.changed).toEqual([])
    expect(behind.seq).toBe(1)
  })

  it('declares an overflowed cursor missed and hands back the whole subscription', () => {
    const h = harness({ logLimit: 2 })
    h.registry.sync('win-1', ['/w/a', '/w/b'], 0)
    h.change('/w/a')
    h.change('/w/a')
    h.change('/w/a')

    const stale = h.registry.sync('win-1', ['/w/a', '/w/b'], 0)
    expect(stale.missed).toBe(true)
    expect([...stale.changed].sort()).toEqual(['/w/a', '/w/b'])
  })

  it('treats a cursor ahead of the sequence as missed', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a'], 0)
    const ahead = h.registry.sync('win-1', ['/w/a'], 999)
    expect(ahead.missed).toBe(true)
    expect(ahead.changed).toEqual(['/w/a'])
  })

  it('reports an unopenable directory as unwatched and retries it next round', () => {
    const h = harness()
    h.blocked.add('/w/locked')
    const refused = h.registry.sync('win-1', ['/w/locked'], 0)
    expect(refused.unwatched).toEqual(['/w/locked'])
    expect(refused.changed).toEqual([])

    // The subscription survived the failure, so the next round retries.
    h.blocked.delete('/w/locked')
    const recovered = h.registry.sync('win-1', ['/w/locked'], refused.seq)
    expect(recovered.unwatched).toEqual([])
    expect(h.opened).toEqual(['/w/locked'])
  })

  it('re-arms a dead handle and reports the level as changed so the gap is not silent', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a'], 0)
    h.drop('/w/a')

    const healed = h.registry.sync('win-1', ['/w/a'], 0)
    expect(healed.changed).toEqual(['/w/a'])
    expect(healed.unwatched).toEqual([])
    expect(h.opened).toEqual(['/w/a', '/w/a'])

    // The flag is one-shot: the healed handle must not force a re-read forever.
    expect(h.registry.sync('win-1', ['/w/a'], healed.seq).changed).toEqual([])
  })

  it('closes every handle on dispose', () => {
    const h = harness()
    h.registry.sync('win-1', ['/w/a'], 0)
    h.registry.sync('win-2', ['/w/b'], 0)
    h.registry.dispose()
    expect([...h.closed].sort()).toEqual(['/w/a', '/w/b'])
    expect(h.registry.size).toBe(0)
  })
})
