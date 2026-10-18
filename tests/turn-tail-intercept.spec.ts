// @vitest-environment jsdom
/**
 * Open-path interception (folder reveal): turn-tail UI is first-party only;
 * the sidebar wraps `workspaces.openPath` so official "Show in folder" (`.`)
 * reveals the workspace root (opens the pathless「文件」window, tints its root
 * row) once, then clears the tint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allLeaves, createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { registerOpenPathInterception, revealInExplorer } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'

afterEach(() => {
  vi.useRealTimers()
})

type Store = ReturnType<typeof createSidebarStore>

/** Every open tab of the store's active session. */
const tabsOf = (store: Store) => allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)

/** One tab by path (asserts it exists). */
const tabAt = (store: Store, path: string | undefined) => {
  const tab = tabsOf(store).find(candidate => candidate.path === path)
  if (tab === undefined) throw new Error(`expected a tab at ${String(path)}`)
  return tab
}

/** A client context whose `betterSidebar` is the REAL service over `store`,
 *  so an intercepted open actually lands its tab (and its meta). `openTab`
 *  is spied in place, so call-count assertions stay honest. */
const clientCtx = (store: Store): { ctx: Context; openTab: ReturnType<typeof vi.fn> } => {
  const service = createBetterSidebarService(store)
  // The editor descriptor registers the per-path dedupe the real plugin has.
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: tab => tab.path, component: () => null })
  const openTab = vi.spyOn(service, 'openTab')
  const workspaces = { openPath: vi.fn(async () => {}) }
  const ctx = {
    workspaces,
    sessions: {
      list: { getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: '/w', displayTitle: 's1' } } }) },
    },
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
  } as unknown as Context
  return { ctx, openTab }
}

describe('open-path folder reveal (replaces turnTail takeover)', () => {
  it('registers the openPath wrap and routes "." to a one-flash explorer highlight', async () => {
    vi.useFakeTimers()
    const store = createSidebarStore()
    store.setSession('s1')
    const { ctx, openTab } = clientCtx(store)
    const restore = registerOpenPathInterception(ctx, store)

    await ctx.workspaces.openPath('.')
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'editor' }),
    )
    expect(store.getSnapshot().state?.revealed).toEqual(['/w'])
    // The workspace root row only exists inside the pathless「文件」window,
    // so the gesture opens it (its tree is open by default).
    expect(tabAt(store, undefined).meta).toMatchObject({ treeOpen: true })

    // One flash only — tint clears after the reveal window.
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])

    restore()
  })

  it('revealInExplorer with no files highlights the session cwd once', async () => {
    vi.useFakeTimers()
    const store = createSidebarStore()
    store.setSession('s1')
    const { ctx } = clientCtx(store)
    revealInExplorer(ctx, store, 's1', [])
    expect(store.getSnapshot().state?.revealed).toEqual(['/w'])
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])
  })

  it('file opens go to the sidebar editor and flash the tab they produced', async () => {
    vi.useFakeTimers()
    const store = createSidebarStore()
    store.setSession('s1')
    const { ctx, openTab } = clientCtx(store)
    const restore = registerOpenPathInterception(ctx, store)
    await ctx.workspaces.openPath('/w/src/a.ts')
    expect(openTab).toHaveBeenCalledWith({
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    })
    // Chip / mention opens flash the opened tab (and expand its ancestors in
    // the explorer, so the explorer agrees).
    expect(store.getSnapshot().state?.revealed).toEqual(['/w/src/a.ts'])
    expect(store.getSnapshot().state?.expanded).toEqual(expect.arrayContaining(['/w/src']))
    // …and the docked explorer is forced open on the tab that owns the file,
    // so the file and its tree row appear together (the whole point).
    const opened = tabAt(store, '/w/src/a.ts')
    expect(opened.path).toBe('/w/src/a.ts')
    expect(opened.meta).toMatchObject({ treeOpen: true })
    // One openTab only — must not also open the pathless Files home.
    expect(openTab).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_600)
    expect(store.getSnapshot().state?.revealed).toEqual([])
    restore()
  })
})
