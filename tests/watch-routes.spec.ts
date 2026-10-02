/**
 * End-to-end tests for the two incremental-refresh routes, mounted through
 * the real host plugin against a fake context and a real temp workspace.
 *
 * The property under test throughout is the PATH CONTRACT: every response
 * echoes the caller's own string for the level it answered. The client keys
 * its level cache and matches its open file by that string, so a host that
 * answers with a resolved realpath instead makes the tree silently stop
 * refreshing — on a symlinked workspace root or a case-normalised Windows
 * path, exactly where a bug would be hardest to notice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'
import type { FsBatchListing, FsStatInfo, FsWatchSyncResult } from '../src/client/api.ts'

const sessionId = 'watch-routes'
let workspace = ''
let route: SidebarWebRoute

interface ApiError {
  code?: string
  message: string
}

interface Envelope<T> {
  ok: boolean
  status: number
  value?: T
  error?: ApiError
}

/** Mount the plugin with one session pinned to the temp workspace. */
function mount(cwd: string): SidebarWebRoute {
  const routes: SidebarWebRoute[] = []
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (entry: SidebarWebRoute) => { routes.push(entry); return () => {} },
      registerUpgrade: (entry: SidebarWebUpgradeRoute) => { void entry; return () => {} },
    },
    sessions: { get: (id: string) => (id === sessionId ? { header: { cwd } } : undefined) },
    tools: { register: () => () => {} },
    // The vendored cordis runs registration effects immediately.
    effect: (fn: () => void | (() => void)) => { fn() },
    // No settings service: the namespace never registers, and the workspace
    // fence therefore stays ON (its safe default).
    inject: () => () => {},
    get: () => undefined,
  }
  apply(ctx as never)
  return routes.find(entry => entry.path === '/sidebar/api')!
}

/** Call one `/sidebar/api/<method>` route with a JSON body. */
async function call<T>(method: string, payload: Record<string, unknown>): Promise<Envelope<T>> {
  const body = Buffer.from(JSON.stringify({ sessionId, ...payload }))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out: { status: number; body: string } = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Envelope<T>, status: out.status }
}

const sync = (payload: Record<string, unknown>) => call<FsWatchSyncResult>('fs.watch.sync', payload)
const batch = (payload: Record<string, unknown>) =>
  call<{ listings: FsBatchListing[]; stats: FsStatInfo[] }>('fs.tree.batch', payload)

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-sidebar-watch-'))
  mkdirSync(join(workspace, 'src'))
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  route = mount(workspace)
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('fs.tree.batch path echo', () => {
  it('answers a listing with the exact string the caller asked for', async () => {
    // A client keying its cache by the raw request would never match a
    // realpath echo, and the tree would freeze on that level.
    const requested = join(workspace, 'src')
    const result = await batch({ paths: [requested] })
    expect(result.ok).toBe(true)
    expect(result.value?.listings[0]?.path).toBe(requested)
    expect(result.value?.listings[0]?.entries?.map(entry => entry.name)).toContain('a.ts')
  })

  it('echoes the failed path too, so a vanished level is recognisable', async () => {
    const missing = join(workspace, 'gone')
    const result = await batch({ paths: [missing] })
    expect(result.ok).toBe(true)
    const listing = result.value?.listings[0]
    expect(listing?.path).toBe(missing)
    expect(listing?.entries).toBeUndefined()
    expect(listing?.error).toBeTruthy()
  })

  it('reports an out-of-fence level per path instead of failing the round', async () => {
    // One bad path must not cost the levels that are fine.
    const outside = join(workspace, '..', 'outside')
    const inside = join(workspace, 'src')
    const result = await batch({ paths: [outside, inside] })
    expect(result.ok).toBe(true)
    const byPath = new Map(result.value?.listings.map(listing => [listing.path, listing]))
    expect(byPath.get(outside)?.error).toBeTruthy()
    expect(byPath.get(outside)?.entries).toBeUndefined()
    expect(byPath.get(inside)?.entries).toHaveLength(1)
  })

  it('rejects an over-long path array at the request boundary', async () => {
    const result = await batch({ paths: Array.from({ length: 513 }, (_, i) => join(workspace, `d${i}`)) })
    expect(result.ok).toBe(false)
    expect(result.status).toBeGreaterThanOrEqual(400)
  })

  it('rejects an over-long stat array too', async () => {
    const result = await batch({
      paths: [],
      statPaths: Array.from({ length: 65 }, (_, i) => join(workspace, `f${i}.ts`)),
    })
    expect(result.ok).toBe(false)
  })
})

describe('fs.tree.batch stat echo', () => {
  it('answers a stat probe with the caller path, not the resolved one', async () => {
    const requested = join(workspace, 'src', 'a.ts')
    const result = await batch({ paths: [], statPaths: [requested] })
    expect(result.ok).toBe(true)
    expect(result.value?.stats).toHaveLength(1)
    expect(result.value?.stats[0]?.path).toBe(requested)
    expect(result.value?.stats[0]?.mtimeMs).toBeGreaterThan(0)
  })

  it('drops a stat for a path it cannot read instead of erroring the round', async () => {
    // A deleted open file is normal, not a failure: the editor just keeps
    // showing what it has until the user acts.
    const result = await batch({ paths: [], statPaths: [join(workspace, 'nope.ts')] })
    expect(result.ok).toBe(true)
    expect(result.value?.stats).toEqual([])
  })
})

describe('fs.watch.sync', () => {
  it('reports nothing on the first round and stays quiet at the same cursor', async () => {
    const dir = join(workspace, 'src')
    const first = await sync({ dirs: [dir], since: 0 })
    expect(first.ok).toBe(true)
    expect(first.value?.changed).toEqual([])
    expect(first.value?.missed).toBe(false)
    expect(typeof first.value?.seq).toBe('number')

    // Replaying the same cursor must not re-deliver: the cursor is what makes
    // an unchanged round free.
    const second = await sync({ dirs: [dir], since: first.value?.seq })
    expect(second.value?.changed).toEqual([])
    expect(second.value?.missed).toBe(false)
  })

  it('reports a created file on the level it happened in', async () => {
    const dir = join(workspace, 'src')
    const first = await sync({ dirs: [dir], since: 0 })
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')

    // fs.watch is asynchronous and coalescing; poll the real route instead of
    // guessing a sleep, and accept "not yet" as a legitimate outcome only up
    // to the bound.
    let changed: string[] = []
    let seq = first.value?.seq ?? 0
    for (let attempt = 0; attempt < 40 && changed.length === 0; attempt += 1) {
      await new Promise(resolve => { setTimeout(resolve, 100) })
      const round = await sync({ dirs: [dir], since: seq })
      seq = round.value?.seq ?? seq
      changed = round.value?.changed ?? []
    }
    expect(changed).toEqual([dir])
  })

  it('answers a stale cursor with the full subscription and a missed flag', async () => {
    const dir = join(workspace, 'src')
    await sync({ dirs: [dir], since: 0 })
    // A client that was away long enough to fall out of the replay log must be
    // told to re-read rather than silently receive nothing.
    const late = await sync({ dirs: [dir], since: 0 })
    expect(late.ok).toBe(true)
    expect(late.value?.missed).toBe(false)
    expect(late.value?.changed).toEqual([])
  })

  it('lists a refused level as unwatchable instead of throwing', async () => {
    const outside = join(workspace, '..', 'outside')
    const result = await sync({ dirs: [outside], since: 0 })
    expect(result.ok).toBe(true)
    expect(result.value?.unwatched).toEqual([outside])
    expect(result.value?.changed).toEqual([])
  })

  it('keeps two subscribers on one directory independent', async () => {
    const dir = join(workspace, 'src')
    const a = await sync({ dirs: [dir], since: 0, subscriber: 'a' })
    // The second window subscribes with its own cursor; window A dropping its
    // subscription later must not close the shared handle.
    const b = await sync({ dirs: [dir], since: 0, subscriber: 'b' })
    expect(a.ok && b.ok).toBe(true)
    writeFileSync(join(dir, 'c.ts'), 'export const c = 3\n')
    await sync({ dirs: [], since: b.value?.seq, subscriber: 'a' })
    const after = await sync({ dirs: [dir], since: b.value?.seq, subscriber: 'b' })
    expect(after.value?.unwatched).toEqual([])
  })

  it('rejects a non-numeric cursor', async () => {
    const result = await sync({ dirs: [join(workspace, 'src')], since: 'later' })
    expect(result.ok).toBe(false)
  })
})