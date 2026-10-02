/**
 * Turn-tail interception registration spec (issue #15): `registerTurnTailInterception`
 * must go through `ctx.slots.inject` — the slot is a CHILD slot the host's
 * ui-conversation declares in its `conversation.chat.node` children table, so a
 * direct `slots.register` races the declaration and the ui-slots core throws
 * "not declared (a parent entry's children table must declare it)".
 *
 * The fake `slots` mirrors SlotRegistry.inject's semantics: run the callback
 * synchronously when the slot is already declared; otherwise wait and run it
 * when the declaration commits; the returned disposer cancels a pending wait
 * and disposes any active registration; the register disposer is idempotent.
 */
import { describe, expect, it, vi } from 'vitest'
import { createSidebarStore } from '../src/client/state.ts'
import { registerTurnTailInterception, SidebarProducedFiles } from '../src/client/intercept.tsx'
import type { Context } from '../src/context-types.ts'

interface RegisteredSlot {
  options: Record<string, unknown>
  component: unknown
}

/** The lane rows a returned element tree renders, by their data attribute. */
function collectLaneKeys(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectLaneKeys(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const props = (node as { props?: Record<string, unknown> }).props
  if (props === undefined) return out
  const key = props['data-file-lane']
  if (typeof key === 'string') out.push(key)
  const children = props.children
  for (const child of Array.isArray(children) ? children : [children]) {
    collectLaneKeys(child, out)
  }
  return out
}

/**
 * A structural fake of the client slots service. `declared` selects the
 * timing: already-on-ledger (callback runs synchronously) vs. pending
 * (callback runs on `declare()`, unless the controller was disposed first).
 */
const fakeSlots = (declared: boolean) => {
  const registered: RegisteredSlot[] = []
  const disposals: number[] = []
  const pendings: Array<() => void> = []
  return {
    registered,
    disposals,
    pendings,
    slots: {
      register: (options: Record<string, unknown>, component: unknown) => {
        registered.push({ options, component })
        return () => { disposals.push(1) }
      },
      inject: (key: string, callback: () => () => void) => {
        if (key !== 'conversation.chat.turnTail') {
          throw new Error(`unexpected injected key "${key}"`)
        }
        let active: (() => void) | undefined
        let stopped = false
        const run = (): void => {
          if (stopped || active !== undefined) return
          active = callback()
        }
        if (declared) run()
        else pendings.push(run)
        return () => {
          stopped = true
          active?.()
          active = undefined
        }
      },
    },
  }
}

/** A produced-files owner currency: one closing assistant seq + its nodes. */
const producedOwner = (paths: string[]): unknown => ({
  nodes: [
    { kind: 'assistant', seq: 1, turn: 1 },
    ...paths.map(path => ({
      kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
    })),
    { kind: 'assistant', seq: 2, turn: 1 },
  ],
  seq: 2,
})

const emptyOwner = (): unknown => ({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })

/** The minimal client-context fake the registration (and its seats) touch. */
const clientCtx = (slots: unknown): Context => {
  const betterSidebar = { openTab: vi.fn() }
  return {
    slots,
    sessions: {
      list: { getSnapshot: () => ({ current: 's1', byId: { s1: { id: 's1', cwd: '/w', displayTitle: 's1' } } }) },
    },
    betterSidebar,
    get: (name: string) => name === 'betterSidebar' ? betterSidebar : undefined,
  } as unknown as Context
}

describe('turn-tail interception registration (issue #15)', () => {
  it('registers through slots.inject and lands once the slot is already declared', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // Exactly one registration, with the takeover descriptor.
    expect(fake.registered).toHaveLength(1)
    const { options, component } = fake.registered[0]!
    expect(options.name).toBe('conversation.chat.turnTail')
    expect(options.priority).toBe(-1)
    expect(options.registrant).toBe('xrkh-better-sidebar')
    expect(options.select).toBeTypeOf('function')
    expect(options.inject).toBeTypeOf('function')
    expect(component).toBeTypeOf('function')

    // Disposal removes the registration; the disposer is idempotent.
    restore()
    expect(fake.disposals).toHaveLength(1)
    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('waits for the host declaration instead of throwing (the pre-fix race)', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)

    // The slot is undeclared: nothing registered yet, no error.
    expect(fake.registered).toHaveLength(0)

    // The host's ui-conversation commits the declaration → the entry lands.
    expect(fake.pendings).toHaveLength(1)
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    // A later re-declaration does not double-register while the entry is live.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(1)

    restore()
    expect(fake.disposals).toHaveLength(1)
  })

  it('a disposal before the declaration cancels the wait permanently', () => {
    const fake = fakeSlots(false)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    restore()

    // The declaration arrives after the controller was disposed: ignored.
    fake.pendings[0]!()
    expect(fake.registered).toHaveLength(0)
  })

  it('declines the takeover while the editor tab is disabled in the settings', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    const select = fake.registered[0]!.options.select as (owner: unknown) => unknown

    // Enabled (default): a produced turn claims the chain with all three lanes;
    // an empty one declines.
    expect(select(producedOwner(['a.ts', 'b.ts']))).toEqual({
      created: [],
      modified: ['a.ts', 'b.ts'],
      deleted: [],
    })
    expect(select(emptyOwner())).toBeNull()
    // The engine Turn data path (the real owner currency: { turn, seq,
    // openFile }) claims through the deliverables record too — edits and
    // deletions stay in their own lane instead of collapsing into "produced".
    expect(select({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? { produced: [
              { seq: 1, path: 'a.ts', op: 'create' },
              { seq: 1, path: 'b.ts', op: 'modify' },
              { seq: 1, path: 'c.ts', op: 'delete' },
            ] }
            : undefined,
        },
      },
      seq: 1,
    })).toEqual({ created: ['a.ts'], modified: ['b.ts'], deleted: ['c.ts'] })

    // Editor tab disabled: even a produced turn falls back to the default
    // deliverables row (chips that cannot open must not be offered).
    store.setPrefs({ ...store.getPrefs(), tabsEnabled: { editor: false } })
    expect(select(producedOwner(['a.ts']))).toBeNull()

    restore()
  })

  it('wires the openInSidebar and onShowInFolder seats', () => {
    const fake = fakeSlots(true)
    const ctx = clientCtx(fake.slots)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(ctx, store)
    const inject = fake.registered[0]!.options.inject as (sessionId: string) => {
      openInSidebar: (path: string) => void
      onShowInFolder: (files: readonly string[]) => void
    }

    // The seat hands the session-scoped opener to the chips row.
    const seat = inject('s1')
    expect(seat.openInSidebar).toBeTypeOf('function')
    seat.openInSidebar('/w/src/a.ts')
    expect(ctx.betterSidebar.openTab).toHaveBeenCalledWith({
      type: 'editor',
      title: 'a.ts',
      path: '/w/src/a.ts',
      id: 'editor:/w/src/a.ts',
    })

    // The show-in-folder seat reveals the produced files in the files window
    // (the editor home tab) — the panel expands and the rows highlight.
    expect(seat.onShowInFolder).toBeTypeOf('function')
    seat.onShowInFolder(['/w/src/a.ts'])
    expect(ctx.betterSidebar.openTab).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'editor',
    }))

    restore()
  })

  it('reads the lanes the host injects under the `matched` prop', () => {
    // The host hands a chain entry its selector result as `matched`
    // (`ChainEntryProps = { matched: M }`) — whatever the selector happened to
    // return it under. 0.18.27 renamed this prop to `lanes` to echo the
    // selector's own shape; no host ever injected that name, so the component
    // read `undefined` and took the whole slot down with "Cannot read
    // properties of undefined (reading 'modified')". Every spec below feeds
    // props the way the host does, so the name cannot drift again unnoticed.
    const tree = SidebarProducedFiles({
      matched: { created: ['new.ts'], modified: ['edit.ts'], deleted: ['gone.ts'] },
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
    })
    expect(collectLaneKeys(tree)).toEqual(['modified', 'deleted', 'created'])
  })

  it('declines the takeover when the host already has a changes card', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    const select = fake.registered[0]!.options.select as (owner: unknown) => unknown
    expect(select({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? {
              changes: {
                seq: 1,
                turnId: 't1',
                cwd: '/w',
                files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }],
                total: 1,
                added: 1,
                deleted: 0,
              },
              produced: [{ seq: 1, path: 'a.ts', op: 'create' }],
            }
            : undefined,
        },
      },
      seq: 1,
    })).toBeNull()
    // Future-seq changes must not block this closing seq (host changesForClosing).
    expect(select({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? {
              changes: {
                seq: 9,
                turnId: 't9',
                cwd: '/w',
                files: [{ path: 'later.ts', display: 'later.ts', added: 1, deleted: 0 }],
                total: 1,
                added: 1,
                deleted: 0,
              },
              produced: [{ seq: 1, path: 'a.ts', op: 'create' }],
            }
            : undefined,
        },
      },
      seq: 1,
    })).toEqual({ created: ['a.ts'], modified: [], deleted: [] })
    restore()
  })

  it('survives a missing matched prop by re-deriving lanes from the owner', () => {
    // Host normally injects `matched`; a stale/HMR seat can omit it. Reading
    // `.modified` on undefined used to crash the whole turnTail chain.
    const tree = SidebarProducedFiles({
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? { produced: [{ seq: 1, path: 'a.ts', op: 'create' }] }
            : undefined,
        },
      },
      seq: 1,
    } as never)
    expect(collectLaneKeys(tree)).toEqual(['created'])
  })

  it('renders nothing when matched is null/undefined and the owner has no lanes', () => {
    expect(SidebarProducedFiles({
      matched: null,
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
    })).toBeNull()
    expect(SidebarProducedFiles({
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
    })).toBeNull()
    // Wrong shape must not throw on `.modified`.
    expect(SidebarProducedFiles({
      matched: { lanes: { modified: ['x'] } } as never,
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
    })).toBeNull()
  })

  it('accepts its own selector output through the host prop shape', () => {
    const fake = fakeSlots(true)
    const store = createSidebarStore()
    const restore = registerTurnTailInterception(clientCtx(fake.slots), store)
    const { options, component } = fake.registered[0]!
    const lanes = (options.select as (owner: unknown) => unknown)(producedOwner(['a.ts', 'b.ts']))

    // The whole contract end to end: selector output -> host prop name ->
    // component. A rename on either side of that boundary throws here, which
    // the registration-only specs above could never have caught.
    expect(() => (component as (props: unknown) => unknown)({
      matched: lanes,
      openInSidebar: vi.fn(),
      onShowInFolder: vi.fn(),
    })).not.toThrow()
    restore()
  })
})
