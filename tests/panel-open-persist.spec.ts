/**
 * Expand/collapse must survive a hard refresh: panelOpen flips write
 * immediately (not only after the 200ms debounce).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
const g = globalThis as Record<string, unknown>
const listeners = new Map<string, Set<() => void>>()

g.window = {
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
  addEventListener: (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  },
  removeEventListener: (type: string, fn: () => void) => {
    listeners.get(type)?.delete(fn)
  },
  dispatchEvent: (event: { type: string }) => {
    for (const fn of listeners.get(event.type) ?? []) fn()
    return true
  },
  innerWidth: 1280,
}
g.document = {
  addEventListener: (type: string, fn: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(fn)
  },
  removeEventListener: (type: string, fn: () => void) => {
    listeners.get(type)?.delete(fn)
  },
  visibilityState: 'visible',
}
g.localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value) },
  removeItem: (key: string) => { memory.delete(key) },
  clear: () => { memory.clear() },
}

const { createSidebarStore, togglePanel } = await import('../src/client/state.ts')

const STORAGE_PREFIX = 'xrkh-sidebar:v1'

afterEach(() => {
  memory.clear()
  vi.restoreAllMocks()
})

describe('panelOpen persistence', () => {
  it('writes panelOpen synchronously when the drawer collapses', () => {
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), openByDefault: true })
    store.setSession('sess-persist')
    expect(store.getSnapshot().state?.panelOpen).toBe(true)

    store.reduce(togglePanel)
    expect(store.getSnapshot().state?.panelOpen).toBe(false)

    const raw = (g.localStorage as Storage).getItem(`${STORAGE_PREFIX}:sess-persist`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).panelOpen).toBe(false)

    const again = createSidebarStore()
    again.setSession('sess-persist')
    expect(again.getSnapshot().state?.panelOpen).toBe(false)

    store.dispose()
    again.dispose()
  })

  it('flushes a pending debounce on pagehide so a mid-drag refresh keeps width', () => {
    vi.useFakeTimers()
    const store = createSidebarStore()
    store.setPrefs({ ...store.getPrefs(), openByDefault: false })
    store.setSession('sess-flush')
    store.reduce((state) => ({ ...state, width: 420 }))
    expect((g.localStorage as Storage).getItem(`${STORAGE_PREFIX}:sess-flush`)).toBeNull()

    ;(g.window as { dispatchEvent: (e: { type: string }) => boolean }).dispatchEvent({ type: 'pagehide' })
    const raw = (g.localStorage as Storage).getItem(`${STORAGE_PREFIX}:sess-flush`)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!).width).toBe(420)

    store.dispose()
    vi.useRealTimers()
  })
})
