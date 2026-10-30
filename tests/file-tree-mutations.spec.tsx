/**
 * FileTree mutation menu: new file / new folder / rename / delete.
 *
 * The tree owns the prompts (window.prompt / window.confirm) and hands the
 * decision to the caller; this spec pins that contract — including the two
 * cases that are easy to regress and expensive in the field:
 * - a CANCELLED prompt (null) or an empty name is a no-op, not a write to
 *   `dir/` ;
 * - delete asks for confirmation naming the entry, and a refusal deletes
 *   nothing.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

const { triggerBrowserDownload } = vi.hoisted(() => ({
  triggerBrowserDownload: vi.fn(async () => {}),
}))

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [
        { name: 'dir', path: '/tmp/dir', isDir: true },
        { name: 'a.ts', path: '/tmp/a.ts', isDir: false },
      ],
    }),
    fsWatchSync: async () => ({ changed: [], seq: 0, missed: false, unwatched: [] }),
    fsTreeBatch: async () => ({ listings: [], stats: [] }),
  },
  downloadUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${path}&download=1`,
  downloadBasename: (path: string) => path.split(/[/\\]/).pop() || 'download',
  triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args),
  isOutsideWorkspaceMessage: () => false,
}))

interface Calls {
  create: { dir: string; name: string; isDir: boolean }[]
  rename: { path: string; name: string }[]
  remove: { path: string; name: string }[]
}

let container: HTMLDivElement
let root: Root
let calls: Calls

async function mount(): Promise<void> {
  calls = { create: [], rename: [], remove: [] }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onReferenceFile: () => {},
      onFsCreate: (dir, name, isDir) => { calls.create.push({ dir, name, isDir }) },
      onFsRename: (path, name) => { calls.rename.push({ path, name }) },
      onFsDelete: (path, name) => { calls.remove.push({ path, name }) },
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
}

/** The tree row showing `name` (directories and files alike). */
function rowFor(name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === name)
  if (row === undefined) throw new Error(`row ${name} not found`)
  return row
}

/** Right-click a row, then pick the menu item labelled `label`. */
function choose(row: string, label: string): void {
  act(() => {
    rowFor(row).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(el => el.textContent?.trim() === label)
  if (item === undefined) throw new Error(`menu item ${label} not found`)
  act(() => { item.click() })
}

/** Right-click a row and report which labels the menu offers. */
function labelsOf(row: string): string[] {
  act(() => {
    rowFor(row).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
  })
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(el => el.textContent?.trim() ?? '')
}

beforeEach(async () => {
  triggerBrowserDownload.mockClear()
  await mount()
})
afterEach(() => {
  act(() => { root.unmount() })
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('FileTree mutation menu', () => {
  it('offers create entries on a directory and rename/delete on a file', () => {
    const dirLabels = labelsOf('dir')
    expect(dirLabels).toContain('New file')
    expect(dirLabels).toContain('New folder')
    expect(dirLabels).not.toContain('Rename')
    expect(dirLabels).not.toContain('Download')

    const fileLabels = labelsOf('a.ts')
    expect(fileLabels).toContain('Rename')
    expect(fileLabels).toContain('Delete')
    expect(fileLabels).toContain('Download')
    expect(fileLabels).not.toContain('New folder')
  })

  it('routes file Download through the mobile-safe blob helper', () => {
    choose('a.ts', 'Download')
    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      '/sidebar/file?path=/tmp/a.ts&download=1',
      'a.ts',
    )
  })

  it('creates a file in the chosen directory', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('notes.md')
    choose('dir', 'New file')
    expect(calls.create).toEqual([{ dir: '/tmp/dir', name: 'notes.md', isDir: false }])
  })

  it('creates a folder in the chosen directory', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('assets')
    choose('dir', 'New folder')
    expect(calls.create).toEqual([{ dir: '/tmp/dir', name: 'assets', isDir: true }])
  })

  it('ignores a cancelled prompt', () => {
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    choose('dir', 'New file')
    expect(calls.create).toEqual([])
  })

  it('ignores an empty or whitespace-only name', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('   ')
    choose('dir', 'New folder')
    expect(calls.create).toEqual([])
  })

  it('trims the name it forwards', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('  spaced.txt  ')
    choose('dir', 'New file')
    expect(calls.create).toEqual([{ dir: '/tmp/dir', name: 'spaced.txt', isDir: false }])
  })

  it('renames with the current name prefilled and no-op on an unchanged name', () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('b.ts')
    choose('a.ts', 'Rename')
    expect(prompt).toHaveBeenCalledWith('New name', 'a.ts')
    expect(calls.rename).toEqual([{ path: '/tmp/a.ts', name: 'b.ts' }])

    prompt.mockReturnValue('a.ts')
    choose('a.ts', 'Rename')
    // Same name: nothing to do, so no second rename is issued.
    expect(calls.rename).toHaveLength(1)
  })

  it('deletes only after a confirmation naming the entry', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    choose('a.ts', 'Delete')
    expect(confirmSpy).toHaveBeenCalledWith('Delete "a.ts"? This cannot be undone.')
    expect(calls.remove).toEqual([{ path: '/tmp/a.ts', name: 'a.ts' }])
  })

  it('deletes nothing when the confirmation is refused', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    choose('a.ts', 'Delete')
    expect(calls.remove).toEqual([])
  })

  /** The delete row must be the destructive one. The primitives Menu renders it
   *  via `clsx(..., css.danger)`, but CSS-module class names are empty strings
   *  under vitest, so the styling is not observable here — instead this pins
   *  the contract that makes the danger styling possible: a refused
   *  confirmation never reaches the caller, while an accepted one does. (The
   *  row is only marked `danger` for styling; nothing branches on it.) */
  it('routes delete through a confirmation the caller can refuse', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    choose('a.ts', 'Delete')
    expect(confirmSpy).toHaveBeenCalledOnce()
    expect(calls.remove).toEqual([])

    confirmSpy.mockReturnValue(true)
    choose('a.ts', 'Delete')
    expect(calls.remove).toHaveLength(1)
  })
})