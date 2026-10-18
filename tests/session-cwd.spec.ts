import { describe, expect, it } from 'vitest'
import { hostCwdOf, noteHostCwd, rebasePath, sessionCwdFor } from '../src/client/session-cwd.ts'

describe('rebasePath', () => {
  it('swaps a stale root for the host root, keeping the tail', () => {
    // Chat joined the list-summary cwd; the session has since moved.
    expect(rebasePath('/new/proj', '/old/proj', '/old/proj/src/a.ts')).toBe('/new/proj/src/a.ts')
  })

  it('keeps a path that is not under the stale root (a linked worktree, another workspace)', () => {
    expect(rebasePath('/new/proj', '/old/proj', '/elsewhere/lib/x.ts')).toBe('/elsewhere/lib/x.ts')
  })

  it('keeps a relative path — the host joins it onto its own cwd', () => {
    expect(rebasePath('/new/proj', '/old/proj', 'src/a.ts')).toBe('src/a.ts')
  })

  it('is a no-op when the roots agree or the host root is unknown', () => {
    expect(rebasePath('/same', '/same', '/same/src/a.ts')).toBe('/same/src/a.ts')
    expect(rebasePath(undefined, '/old', '/old/src/a.ts')).toBe('/old/src/a.ts')
    expect(rebasePath('/new', undefined, '/old/src/a.ts')).toBe('/old/src/a.ts')
  })

  it('mirrors the stale separator style onto the host root', () => {
    expect(rebasePath('C:\\new\\proj', 'C:\\old\\proj', 'C:\\old\\proj\\src\\a.ts'))
      .toBe('C:\\new\\proj\\src/a.ts')
  })
})

describe('session cwd cache', () => {
  it('prefers the host answer over the list summary, falling back until it is known', () => {
    const id = 'sess-cwd-cache-1'
    expect(sessionCwdFor(id, '/summary')).toBe('/summary')
    expect(hostCwdOf(id)).toBeUndefined()
    noteHostCwd(id, '/host')
    expect(hostCwdOf(id)).toBe('/host')
    expect(sessionCwdFor(id, '/summary')).toBe('/host')
    expect(sessionCwdFor(id, undefined)).toBe('/host')
  })

  it('ignores an empty answer so a blank host reply cannot mask the summary', () => {
    const id = 'sess-cwd-cache-2'
    noteHostCwd(id, '')
    expect(sessionCwdFor(id, '/summary')).toBe('/summary')
  })
})