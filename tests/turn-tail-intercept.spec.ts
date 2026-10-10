// @vitest-environment jsdom
/**
 * Open-path interception (folder reveal): turn-tail UI is first-party only;
 * the sidebar wraps `workspaces.openPath` so official "Show in folder" (`.`)
 * highlights the workspace folder once, then clears the tint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSidebarStore } from '../src/client/state.ts'
import { registerOpenPathInterception, revealInExplorer } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'

afterEach(() => {
  vi.useRealTimers()
})

/** Minimal client context the open-path seats touch. */
const clientCtx = (): Context => {
  const betterSidebar = { openTab: vi.fn(), updateTab: vi.fn() }
  const workspaces = { openPath: vi.fn(async () => {}) }
  return {
    workspaces,
    sessions: {
      list: { getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: '/w', displayTitle: 's1' } } }) },
    },
    betterSidebar,
    get: (name: string) => name === 'betterSidebar' ? betterSidebar : undefined,
  } as unknown as Context
}

describe('open-path folder reveal (replaces turnTail takeover)', () => {
  it('registers the openPath wrap and routes "." to a one-flash explorer highlight', async () => {
    vi.useFakeTimers()
    const ctx = clientCtx()
    const store = createSidebarStore()
    store.setSession('s1')
    const restore = registerOpenPathInterception(ctx, store)

    await ctx.workspaces.openPath('.')
    expect(ctx.get('betterSidebar')!.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'editor' }),
    )
    expect(store.getSnapshot().state?.revealed).toEqual(['/w'])

    // One flash only — tint clears after the reveal window.
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])

    restore()
  })

  it('revealInExplorer with no files highlights the session cwd once', async () => {
    vi.useFakeTimers()
    const ctx = clientCtx()
    const store = createSidebarStore()
    store.setSession('s1')
    revealInExplorer(ctx, store, 's1', [])
    expect(store.getSnapshot().state?.revealed).toEqual(['/w'])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])
  })

  it('file opens go to the sidebar editor and flash in the explorer', async () => {
    vi.useFakeTimers()
    const ctx = clientCtx()
    const store = createSidebarStore()
    store.setSession('s1')
    const restore = registerOpenPathInterception(ctx, store)
    await ctx.workspaces.openPath('/w/src/a.ts')
    expect(ctx.get('betterSidebar')!.openTab).toHaveBeenCalledWith({
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
      meta: { treeOpen: true },
    })
    // Chip / mention opens must tint the tree row (and expand ancestors).
    expect(store.getSnapshot().state?.revealed).toEqual(['/w/src/a.ts'])
    expect(store.getSnapshot().state?.expanded).toEqual(expect.arrayContaining(['/w/src']))
    // One openTab only — must not also open the pathless Files home.
    expect(ctx.get('betterSidebar')!.openTab).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])
    restore()
  })
})
