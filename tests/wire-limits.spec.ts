/**
 * Unit tests for the request-boundary helpers behind the batch routes.
 *
 * `fs.watch.sync` and `fs.tree.batch` fan out one watcher / one `opendir` per
 * element, so the array bound and the concurrency bound ARE the resource
 * limits of those routes — a regression here is a host-side fan-out storm, not
 * a type error. The numeric guard is equally load-bearing: a NaN `since` cursor
 * would compare false against every sequence number and make each watch round
 * look like a fresh subscribe.
 */
import { describe, expect, it, vi } from 'vitest'
import { mapBounded } from '../src/map-bounded.ts'
import { optionalNumber, optionalStringArray, requireStringArray, SidebarError } from '../src/wire.ts'

describe('requireStringArray', () => {
  it('accepts a bounded array of non-empty strings', () => {
    expect(requireStringArray({ dirs: ['/a', '/b'] }, 'dirs', 4)).toEqual(['/a', '/b'])
  })

  it('rejects a missing member, a non-array, and an over-long array', () => {
    expect(() => requireStringArray({}, 'dirs', 4)).toThrow(SidebarError)
    expect(() => requireStringArray({ dirs: '/a' }, 'dirs', 4)).toThrow(SidebarError)
    expect(() => requireStringArray({ dirs: ['/a', '/b', '/c'] }, 'dirs', 2)).toThrow(SidebarError)
  })

  it('rejects empty and non-string elements (a hole would resolve to the cwd)', () => {
    expect(() => requireStringArray({ dirs: ['/a', ''] }, 'dirs', 4)).toThrow(SidebarError)
    expect(() => requireStringArray({ dirs: ['/a', 7] }, 'dirs', 4)).toThrow(SidebarError)
  })
})

describe('optionalStringArray', () => {
  it('treats an absent or null member as empty', () => {
    expect(optionalStringArray({}, 'statPaths', 4)).toEqual([])
    expect(optionalStringArray({ statPaths: null }, 'statPaths', 4)).toEqual([])
  })

  it('still validates a present member', () => {
    expect(optionalStringArray({ statPaths: ['/a'] }, 'statPaths', 4)).toEqual(['/a'])
    expect(() => optionalStringArray({ statPaths: ['/a', '/b'] }, 'statPaths', 1)).toThrow(SidebarError)
  })
})

describe('optionalNumber', () => {
  it('falls back only for an absent member', () => {
    expect(optionalNumber({}, 'since', 7)).toBe(7)
    expect(optionalNumber({ since: null }, 'since', 7)).toBe(7)
    expect(optionalNumber({ since: 0 }, 'since', 7)).toBe(0)
  })

  it('rejects values that would silently break cursor arithmetic', () => {
    expect(() => optionalNumber({ since: -1 }, 'since', 0)).toThrow(SidebarError)
    expect(() => optionalNumber({ since: Number.NaN }, 'since', 0)).toThrow(SidebarError)
    expect(() => optionalNumber({ since: Number.POSITIVE_INFINITY }, 'since', 0)).toThrow(SidebarError)
    expect(() => optionalNumber({ since: '3' }, 'since', 0)).toThrow(SidebarError)
  })
})

describe('mapBounded', () => {
  it('keeps input order even when the slow work finishes last', async () => {
    const out = await mapBounded([30, 10, 20], 2, async (ms) => {
      await new Promise(resolve => { setTimeout(resolve, ms) })
      return ms
    })
    expect(out).toEqual([30, 10, 20])
  })

  it('never runs more than `limit` units at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapBounded(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => { setTimeout(resolve, 1) })
      inFlight -= 1
    })
    expect(peak).toBe(3)
  })

  it('degrades a nonsensical bound to serial work instead of stalling', async () => {
    const run = vi.fn(async (n: number) => n + 1)
    expect(await mapBounded([1, 2], 0, run)).toEqual([2, 3])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('propagates a rejection to the caller', async () => {
    await expect(mapBounded([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('opendir failed')
      return n
    })).rejects.toThrow('opendir failed')
  })

  it('handles an empty list without spawning a worker', async () => {
    expect(await mapBounded([], 8, async () => 1)).toEqual([])
  })
})