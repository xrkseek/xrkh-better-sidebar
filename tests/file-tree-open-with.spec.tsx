/**
 * FileTree "open with" context menu: Face-probed targets + reveal; flat mode
 * on phone avoids a sideways submenu that spills off a narrow viewport.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { FileTree } from '../src/client/FileTree.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import type { OpenWithTarget } from '../src/client/open-with.ts'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

vi.mock('../src/client/api.ts', () => ({
  api: {
    fsTree: async () => ({
      entries: [{ name: 'a.ts', path: '/tmp/a.ts', isDir: false }],
    }),
  },
  downloadUrl: () => '/sidebar/file',
  downloadBasename: (path: string) => path.split(/[/\\]/).pop() || 'download',
  triggerBrowserDownload: async () => {},
}))

/** Host-probed + reveal + one custom — what EditorHost would hand FileTree. */
const targets: OpenWithTarget[] = [
  { id: 'explorer', nameKey: 'openWithExplorer', name: '', kind: 'reveal', isVscodeFamily: false, localOnly: true },
  { id: 'vscode', nameKey: 'openWithVscode', name: '', kind: 'host', isVscodeFamily: true, localOnly: false, hostAppId: 'vscode' },
  { id: 'cursor', nameKey: 'openWithCursor', name: '', kind: 'host', isVscodeFamily: true, localOnly: false, hostAppId: 'cursor' },
  { id: 'custom:w', name: 'Windsurf', kind: 'url', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false, localOnly: false },
]

interface Harness {
  container: HTMLDivElement
  onOpenWith: ReturnType<typeof vi.fn>
  onToggleOpenWithPin: ReturnType<typeof vi.fn>
  unmount: () => void
}

async function mountTree(overrides: {
  openWithTargets?: OpenWithTarget[]
  openWithPinned?: string[]
  openWithSsh?: boolean
  openWithFlat?: boolean
} = {}): Promise<Harness> {
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  const onOpenWith = vi.fn()
  const onToggleOpenWithPin = vi.fn()
  const has = (key: 'openWithTargets' | 'openWithPinned' | 'openWithSsh' | 'openWithFlat'): boolean =>
    Object.prototype.hasOwnProperty.call(overrides, key)
  await act(async () => {
    root.render(createElement(FileTree, {
      sessionId: 's1',
      cwd: '/tmp',
      store: createSidebarStore(),
      expanded: [],
      revealed: [],
      onToggle: () => {},
      onOpenFile: () => {},
      onOpenFileNewTab: () => {},
      onOpenFileSide: () => {},
      openWithTargets: has('openWithTargets') ? overrides.openWithTargets : targets,
      openWithPinned: has('openWithPinned') ? overrides.openWithPinned : ['vscode'],
      openWithSsh: has('openWithSsh') ? overrides.openWithSsh : false,
      openWithFlat: has('openWithFlat') ? overrides.openWithFlat : false,
      onOpenWith,
      onToggleOpenWithPin,
      onReferenceFile: () => {},
      onFsCreate: () => {},
      onFsRename: () => {},
      onFsDelete: () => {},
      refreshTick: 0,
      onUploadRequest: () => {},
      busy: false,
    }))
  })
  return {
    container,
    onOpenWith,
    onToggleOpenWithPin,
    unmount: () => { act(() => { root.unmount() }) },
  }
}

function fileRow(container: HTMLDivElement): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(el => el.querySelector('[class*="explorerName"]')?.textContent === 'a.ts')
  if (row === undefined) throw new Error('file row not found')
  return row
}

function openMenu(container: HTMLDivElement): void {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 })
  act(() => { fileRow(container).dispatchEvent(event) })
}

describe('FileTree open-with menu', () => {
  let harness: Harness
  afterEach(() => {
    harness.unmount()
    document.body.innerHTML = ''
  })

  it('renders the pinned direct row, Show in folder, and the submenu parent', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    const labels = items.map(item => item.textContent?.trim())
    expect(labels).toContain('VS Code')
    expect(labels).toContain('Show in folder')
    const parent = items.find(item => item.getAttribute('aria-haspopup') === 'menu')
    expect(parent?.textContent).toContain('Open with')
  })

  it('opens the submenu and lists Face-probed + custom targets', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    act(() => { parent!.click() })
    const children = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
    expect(children.map(item => item.textContent?.trim())).toEqual([
      'File Manager', 'VS Code', 'Cursor', 'Windsurf',
    ])
  })

  it('flat mode promotes every target to the top level (no nested submenu)', async () => {
    harness = await mountTree({ openWithFlat: true, openWithPinned: [] })
    openMenu(harness.container)
    expect(document.querySelector('[role="menu"] [role="menu"]')).toBeNull()
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map(item => item.textContent?.trim())
    expect(labels).toContain('Show in folder')
    expect(labels).toContain('VS Code')
    expect(labels).toContain('Cursor')
    expect(labels).toContain('Windsurf')
    expect(labels.some(label => label?.includes('Open with'))).toBe(false)
  })

  it('selecting a Face-probed child invokes onOpenWith with the row path', async () => {
    harness = await mountTree()
    openMenu(harness.container)
    const parent = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(item => item.getAttribute('aria-haspopup') === 'menu')
    act(() => { parent!.click() })
    const cursorRow = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menu"] [role="menuitem"]')]
      .find(item => item.textContent?.trim() === 'Cursor')
    act(() => { cursorRow!.click() })
    expect(harness.onOpenWith).toHaveBeenCalledWith('cursor', '/tmp/a.ts')
  })

  it('hides the whole section when the caller wires no targets', async () => {
    harness = await mountTree({ openWithTargets: [] })
    openMenu(harness.container)
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .map(item => item.textContent?.trim() ?? '')
    expect(labels.some(label => label.includes('Open with') || label.includes('Show in folder'))).toBe(false)
  })
})
