/**
 * EditorHost (the files window): a path-less tab renders the empty-state hint
 * with its docked explorer open (meta.treeOpen defaults open for the home
 * window), a file tab defaults it closed. The editorExplorer pref controls
 * FILE-OPEN behavior — in-place rewrites the current tab via updateTab, split
 * opens a per-path dedupe tab via openSidebarFile — and in split mode a
 * PATH-LESS window becomes the standalone explorer (tree panel only, no
 * editor chrome); file tabs keep the full chrome in both modes.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import type { Context } from '../src/context-types.ts'
import { EditorHost } from '../src/client/EditorHost.tsx'
import { createBetterSidebarService } from '../src/client/service.ts'
import { allLeaves, createSidebarStore, treeOpenOf, treeWidthOf, type SidebarTab } from '../src/client/state.ts'

// The act() environment flag (React 18.2 reads it before flushing effects).
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

/** A store with the seeded editor-home tab (default prefs: separate mode;
 *  merged-mode scenarios re-enable editorExplorer explicitly). */
function setup(): {
  store: ReturnType<typeof createSidebarStore>
  ctx: Context
  homeTab: () => SidebarTab
} {
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // The openTab path needs a registered editor descriptor (dedupe by path).
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession('editor-home-session')
  const homeTab = (): SidebarTab =>
    allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      .find(tab => tab.type === 'editor' && tab.path === undefined)!
  // openSidebarFile reads the session cwd from ctx.sessions.
  const sessionsSnapshot = { byId: { 'editor-home-session': { cwd: '/tmp' } }, current: 'editor-home-session' }
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessionsSnapshot } },
  } as unknown as Context
  return { store, ctx, homeTab }
}

/** Mount the host for one tab; returns the container and an unmount helper. */
function mountHost(ctx: Context, store: ReturnType<typeof createSidebarStore>, tab: () => SidebarTab): {
  container: HTMLDivElement
  rerender: () => void
  unmount: () => void
} {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const render = (): void => {
    root.render(createElement(EditorHost, {
      ctx,
      store,
      scope: { sessionId: 'editor-home-session' },
      tab: tab(),
      expanded: [],
      revealed: [],
      onToggleDir: () => {},
      onReferenceFile: () => {},
    }))
  }
  act(render)
  return {
    container,
    // The real app re-renders the host with the fresh tab on every store
    // change (Sidebar subscribes); mirror that after mutating the store.
    rerender: () => { act(render) },
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** Type into the controlled path input (native setter) and press Enter. */
function typeAndCommit(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

describe('EditorHost (files window)', () => {
  it('a path-less tab renders the empty-state hint with the docked explorer open', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const html = container.innerHTML
      // The empty-state hint renders instead of the viewer loading flow.
      expect(html).toContain('use the file-tree button')
      expect(html).not.toContain('Loading…')
      // The header carries the path input AND the explorer toggle (on).
      expect(container.querySelector('input[placeholder^="File path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull()
      // The path-less home window IS the browsable one: its docked explorer
      // (search row + tree) is on screen, separated by the resize handle.
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('in-place mode: the path input Enter switches the CURRENT tab (stable id, meta kept)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: true })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      const before = homeTab()
      typeAndCommit(container.querySelector('input')!, '/tmp/a.ts')
      // The same tab id now carries the file (homeTab's path-less finder no
      // longer matches — look the tab up by id).
      const after = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.id === before.id)!
      expect(after.id).toBe(before.id)
      expect(after.path).toBe('/tmp/a.ts')
      expect(after.title).toBe('a.ts')
      expect(after.meta).toBeUndefined()
      // No new tab landed.
      expect(allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)).toHaveLength(1)
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab\'s path input Enter opens a NEW per-path tab; the source tab keeps its path', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({ type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      typeAndCommit(container.querySelector('input[placeholder^="File path"]')!, '/tmp/b.ts')
      const tabs = allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
      // home + a.ts + b.ts
      expect(tabs).toHaveLength(3)
      expect(fileTab().path).toBe('/tmp/a.ts')
      const opened = tabs.find(tab => tab.path === '/tmp/b.ts')!
      expect(opened.type).toBe('editor')
      expect(opened.title).toBe('b.ts')
      expect(opened.id).toBe('editor:/tmp/b.ts')
    } finally {
      unmount()
    }
  })

  it('split mode: the path-less window is the standalone explorer (tree only, no chrome)', () => {
    const { store, ctx, homeTab } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    const { container, unmount } = mountHost(ctx, store, homeTab)
    try {
      // No editor chrome: no path input, no tree toggle, no resize handle.
      expect(container.querySelector('input[placeholder^="File path"]')).toBeNull()
      expect(container.querySelector('button[aria-pressed]')).toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      // The tree panel fills the whole window — its search box is the only
      // input, and (no cwd) the tree shows its no-session placeholder.
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
      expect(container.innerHTML).toContain('Select a conversation')
    } finally {
      unmount()
    }
  })

  it('split mode: a file tab keeps the full chrome; its docked explorer defaults closed', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      expect(container.querySelector('input[placeholder^="File path"]')).not.toBeNull()
      // The toggle is there but OFF, and no tree is docked until asked for.
      expect(container.querySelector('button[aria-pressed="false"]')).not.toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      expect(container.querySelector('input[placeholder^="Search files"]')).toBeNull()
    } finally {
      unmount()
    }
  })

  it('a file tab with meta.treeOpen docks the explorer beside the content', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
      meta: { treeOpen: true, treeWidth: 300 },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      // The file content keeps the chrome AND the explorer is docked open,
      // at the persisted width.
      expect(container.querySelector('input[placeholder^="File path"]')).not.toBeNull()
      expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull()
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
      expect(container.querySelector('input[placeholder^="Search files"]')).not.toBeNull()
      const dock = container.querySelector<HTMLElement>('[class*="editorTreeDock"]')
      expect(dock?.style.width).toBe('300px')
    } finally {
      unmount()
    }
  })

  it('the docked splitter is keyboard-nudgeable and commits to meta.treeWidth', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
      meta: { treeOpen: true, treeWidth: 300 },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, rerender, unmount } = mountHost(ctx, store, fileTab)
    try {
      const splitter = container.querySelector<HTMLElement>('[role="separator"]')!
      // Reachable by keyboard, and it advertises the contract range.
      expect(splitter.tabIndex).toBe(0)
      expect(splitter.getAttribute('aria-valuenow')).toBe('300')
      expect(splitter.getAttribute('aria-valuemin')).toBe('160')
      expect(splitter.getAttribute('aria-valuemax')).toBe('480')
      // The panel docks right, so ArrowLeft widens it by one step (16px).
      act(() => { splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })) })
      expect(store.getSnapshot().state).toBeDefined()
      expect(treeWidthOf(fileTab())).toBe(316)
      // Home/End snap to the contract bounds.
      act(() => { splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true })) })
      expect(treeWidthOf(fileTab())).toBe(160)
      act(() => { splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })) })
      expect(treeWidthOf(fileTab())).toBe(480)
      // An unrelated key is a no-op (no preventDefault, no write).
      act(() => { splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })) })
      expect(treeWidthOf(fileTab())).toBe(480)
      rerender()
      expect(container.querySelector<HTMLElement>('[class*="editorTreeDock"]')?.style.width).toBe('480px')
    } finally {
      unmount()
    }
  })

  it('dragging the splitter commits the pointer delta, and a bare click writes nothing', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
      meta: { treeOpen: true, treeWidth: 300 },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      const splitter = container.querySelector<HTMLElement>('[role="separator"]')!
      const pointer = (type: string, clientX: number): void => {
        splitter.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
      }
      // A bare click (press + release, no move) must NOT rewrite the width:
      // an un-seeded pending ref read as 0 and clamped to 160, silently
      // snapping a custom width on the first click of the handle.
      act(() => { pointer('pointerdown', 500); pointer('pointerup', 500) })
      expect(treeWidthOf(fileTab())).toBe(300)
      // A real drag left by 40px widens the dock by 40px (it docks right).
      act(() => {
        pointer('pointerdown', 500)
        pointer('pointermove', 460)
        pointer('pointerup', 460)
      })
      expect(treeWidthOf(fileTab())).toBe(340)
    } finally {
      unmount()
    }
  })

  it('a non-primary press and a lost capture never resize the dock', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
      meta: { treeOpen: true, treeWidth: 300 },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      const splitter = container.querySelector<HTMLElement>('[role="separator"]')!
      const pointer = (type: string, clientX: number, button: number): void => {
        splitter.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button }))
      }
      // A right press belongs to the context menu: the strip must not grab it
      // (a drag that never ends would then follow the pointer forever).
      act(() => {
        pointer('pointerdown', 500, 2)
        pointer('pointermove', 300, 2)
        pointer('pointerup', 300, 2)
      })
      expect(treeWidthOf(fileTab())).toBe(300)
      // A capture lost mid-drag (the OS took the pointer, the window went
      // away) aborts the drag — the release must not commit the swept width.
      act(() => {
        pointer('pointerdown', 500, 0)
        pointer('pointermove', 300, 0)
        splitter.dispatchEvent(new MouseEvent('lostpointercapture', { bubbles: true }))
        pointer('pointerup', 300, 0)
      })
      expect(treeWidthOf(fileTab())).toBe(300)
    } finally {
      unmount()
    }
  })

  it('the docked-explorer toggle flips on every click (the handler reads the live meta)', () => {
    const { store, ctx } = setup()
    store.setPrefs({ ...store.getPrefs(), editorExplorer: false })
    ctx.betterSidebar.openTab({
      type: 'editor', title: 'a.ts', path: '/tmp/a.ts', id: 'editor:/tmp/a.ts',
      meta: { treeOpen: true, treeWidth: 300 },
    })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/a.ts')!
    const { container, rerender, unmount } = mountHost(ctx, store, fileTab)
    try {
      const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]')!
      expect(toggle.getAttribute('aria-pressed')).toBe('true')
      // Open → the first click closes it, and the chrome re-renders closed.
      act(() => { toggle.click() })
      rerender()
      expect(treeOpenOf(fileTab())).toBe(false)
      expect(container.querySelector('button[aria-pressed="false"]')).not.toBeNull()
      expect(container.querySelector('[role="separator"]')).toBeNull()
      // A SECOND click on the same button must reopen it. A handler memoised on
      // [store, tab.id] but closing over the first render's `tab` would keep
      // reading the original value and write `false` again — the panel would
      // never come back.
      act(() => { toggle.click() })
      rerender()
      expect(treeOpenOf(fileTab())).toBe(true)
      expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull()
      expect(container.querySelector('[role="separator"]')).not.toBeNull()
    } finally {
      unmount()
    }
  })

  it('the header hosts the viewer toolbar (mode toggle / dirty dot / save)', () => {
    const { store, ctx } = setup()
    const service = ctx.betterSidebar
    const calls: string[] = []
    // A viewer with a hoisted toolbar (the TextEditor contract): register
    // commands and report the state once on mount.
    service.registerFileViewer({
      id: 'test:fake',
      exts: ['fake'],
      fetchStrategy: 'none',
      component: (viewerProps) => {
        useEffect(() => {
          viewerProps.onToolbarControls?.({
            setMode: (next) => { calls.push(`mode:${next}`) },
            save: () => { calls.push('save') },
          })
          viewerProps.onToolbarState?.({ modes: true, mode: 'preview', dirty: true, editable: true, saveState: 'idle' })
          return () => { viewerProps.onToolbarControls?.(null) }
        }, [])
        return null
      },
    })
    service.openTab({ type: 'editor', title: 'x.fake', path: '/tmp/x.fake', id: 'editor:/tmp/x.fake' })
    const fileTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/tmp/x.fake')!
    const { container, unmount } = mountHost(ctx, store, fileTab)
    try {
      // Mode toggle + dirty dot + save button sit in the header row.
      const header = container.querySelector('input')!.parentElement!
      const buttons = [...header.querySelectorAll('button')]
      expect(buttons.map(b => b.textContent)).toContain('Preview')
      expect(buttons.map(b => b.textContent)).toContain('Edit')
      expect(header.querySelector('button[aria-label="Save"]')).not.toBeNull()
      expect(header.querySelector('[title="Unsaved"]')).not.toBeNull()
      // The header commands reach the viewer's registered controls.
      act(() => { buttons.find(b => b.textContent === 'Edit')!.click() })
      act(() => { header.querySelector<HTMLButtonElement>('button[aria-label="Save"]')!.click() })
      expect(calls).toEqual(['mode:edit', 'save'])
    } finally {
      unmount()
    }
  })

  it('a folder tab (meta.dir) renders the tree rooted at the folder, no editor chrome', () => {
    const { store, ctx } = setup()
    ctx.betterSidebar!.openTab({
      type: 'editor',
      title: 'src',
      path: '/work/src',
      id: 'editor:/work/src',
      meta: { dir: true },
    }, { sessionId: 'editor-home-session' })
    const dirTab = (): SidebarTab =>
      allLeaves(store.getSnapshot().state!.splits).flatMap(leaf => leaf.tabs)
        .find(tab => tab.path === '/work/src')!
    const { container, unmount } = mountHost(ctx, store, dirTab)
    try {
      const html = container.innerHTML
      // The folder window is the full tree surface: the folder basename is
      // the tree root row and the search box is present; the editor empty
      // hint and the file path input are NOT.
      expect(html).toContain('src')
      expect(html).toContain('Search files by name…')
      expect(html).not.toContain('Type a path in the input above')
      expect(html).not.toContain('File path (relative')
    } finally {
      unmount()
    }
  })
})
