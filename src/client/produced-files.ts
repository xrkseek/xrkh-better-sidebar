/**
 * Pure derivation of one turn's file lanes from finalized conversation
 * nodes — a structural replica of ui-deliverables' `fileLanesForClosing`
 * (the mutation tools' follow-along locations classified by op; reads and
 * failures produce nothing). Kept dependency-free so the takeover logic is
 * unit-testable and the replica is easy to diff against upstream when it
 * drifts.
 *
 * Three lanes, not one: created / modified / deleted. The host publishes the
 * op on every `deliverables.produced` row — dropping it collapses the rows
 * into a single "produced" list that hides edits and deletions.
 */
import { isAbsolutePath } from './paths.ts'

/** What one mutation did to a path during the Turn. */
export type FileLaneOp = 'create' | 'modify' | 'delete'

/** One mutation recorded against a path. */
export interface FileLaneMutation {
  readonly seq: number
  readonly path: string
  readonly op: FileLaneOp
}

/** Three turn-tail chip lanes (empty arrays omitted by the renderer). */
export interface FileLanes {
  readonly created: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
}

const EMPTY_LANES: FileLanes = { created: [], modified: [], deleted: [] }

/** No lane holds a chip. */
export function lanesEmpty(lanes: FileLanes): boolean {
  return lanes.created.length === 0 && lanes.modified.length === 0 && lanes.deleted.length === 0
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function push(mutations: FileLaneMutation[], seq: number, path: unknown, op: FileLaneOp): void {
  if (typeof path !== 'string') return
  const normalized = normalizePath(path)
  if (normalized === '') return
  mutations.push({ seq, path: normalized, op })
}

/** Classify one diff side-pair: no old text → created, empty new text → deleted. */
function opFromDiff(diff: { oldText?: unknown; newText?: unknown }): FileLaneOp {
  if (diff.oldText === null) return 'create'
  if (diff.newText === '') return 'delete'
  return 'modify'
}

/**
 * Mutations one tool-result node reports, by render intent. A diff card
 * classifies through its side-pairs; a `locations`-only diff degrades to
 * modify. `edit` / `delete` cards classify by kind.
 */
export function mutationsFromView(view: unknown, seq: number): readonly FileLaneMutation[] {
  if (view === null || typeof view !== 'object') return []
  const record = view as { card?: unknown; kind?: unknown; locations?: unknown; diffs?: unknown }
  const mutations: FileLaneMutation[] = []
  if (record.card === 'diff') {
    if (Array.isArray(record.diffs)) {
      for (const diff of record.diffs) {
        if (diff === null || typeof diff !== 'object') continue
        const { path } = diff as { path?: unknown }
        push(mutations, seq, path, opFromDiff(diff as { oldText?: unknown; newText?: unknown }))
      }
      if (mutations.length > 0) return mutations
    }
    if (Array.isArray(record.locations)) {
      for (const location of record.locations) {
        if (location === null || typeof location !== 'object') continue
        push(mutations, seq, (location as { path?: unknown }).path, 'modify')
      }
    }
    return mutations
  }
  if (record.card === 'generic' && Array.isArray(record.locations)) {
    const op: FileLaneOp | undefined = record.kind === 'delete'
      ? 'delete'
      : record.kind === 'edit' ? 'modify' : undefined
    if (op === undefined) return []
    for (const location of record.locations) {
      if (location === null || typeof location !== 'object') continue
      push(mutations, seq, (location as { path?: unknown }).path, op)
    }
  }
  return mutations
}

/** Fold mutations in seq order: the last op per path wins. */
export function foldFileLanes(mutations: readonly FileLaneMutation[]): FileLanes {
  const last = new Map<string, FileLaneOp>()
  const order: string[] = []
  for (const row of mutations) {
    if (!row.path) continue
    if (!last.has(row.path)) order.push(row.path)
    last.set(row.path, row.op)
  }
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const path of order) {
    const op = last.get(path)
    if (op === 'create') created.push(path)
    else if (op === 'modify') modified.push(path)
    else if (op === 'delete') deleted.push(path)
  }
  return { created, modified, deleted }
}

/**
 * Fallback when only the workspace/changes summary is available (cold reopen).
 * Line-count heuristic, identical to the host: zero-add + deletes → deleted;
 * zero-delete + adds → created; else modified.
 */
export function lanesFromChangesFiles(files: readonly unknown[]): FileLanes {
  const created: string[] = []
  const modified: string[] = []
  const deleted: string[] = []
  for (const file of files) {
    if (file === null || typeof file !== 'object') continue
    const row = file as { path?: unknown; added?: unknown; deleted?: unknown }
    if (typeof row.path !== 'string') continue
    const path = normalizePath(row.path)
    const added = typeof row.added === 'number' ? row.added : 0
    const removed = typeof row.deleted === 'number' ? row.deleted : 0
    if (added === 0 && removed > 0) deleted.push(path)
    else if (removed === 0 && added > 0) created.push(path)
    else modified.push(path)
  }
  return { created, modified, deleted }
}

interface DeliverablesTurnDataLike {
  readonly produced?: readonly { seq?: unknown; path?: unknown; op?: unknown }[]
  readonly changes?: { seq?: unknown; files?: readonly unknown[] }
}

/**
 * Lanes from the authoritative Turn data (the same `deliverables` record the
 * host's ui-deliverables reads), bounded by the closing seq.
 */
export function lanesFromTurnData(data: DeliverablesTurnDataLike, seq: number): FileLanes {
  const rows = Array.isArray(data.produced) ? data.produced : []
  const mutations: FileLaneMutation[] = []
  const legacy: string[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.seq === 'number' && row.seq > seq) continue
    if (typeof row.path !== 'string' || normalizePath(row.path) === '') continue
    const op = row.op
    if (op === 'create' || op === 'modify' || op === 'delete') {
      mutations.push({ seq: typeof row.seq === 'number' ? row.seq : 0, path: normalizePath(row.path), op })
    } else {
      // Legacy rows (older sessions) carry no op: treat as created unless
      // the changes summary reports the path as deleted.
      legacy.push(normalizePath(row.path))
    }
  }
  if (mutations.length > 0) return foldFileLanes(mutations)
  const changesInRange = data.changes !== undefined
    && (typeof data.changes.seq !== 'number' || data.changes.seq <= seq)
    && Array.isArray(data.changes.files)
    ? lanesFromChangesFiles(data.changes.files)
    : null
  if (legacy.length > 0) {
    const deleted = new Set(changesInRange?.deleted ?? [])
    const created: string[] = []
    const seen = new Set<string>()
    for (const path of legacy) {
      if (seen.has(path) || deleted.has(path)) continue
      seen.add(path)
      created.push(path)
    }
    const modified = (changesInRange?.modified ?? []).filter(path => !seen.has(path))
    return { created, modified, deleted: [...deleted] }
  }
  return changesInRange ?? EMPTY_LANES
}

/**
 * Lanes reported by the closing turn's tool results, in surface order.
 * Accumulation resets on turn boundaries (a user message, or a node
 * reporting a different turn number).
 * @param nodes - snapshot nodes in surface order (structural, unknown-safe).
 * @param seq - the closing assistant's seq (the render site's anchor).
 */
export function lanesForClosing(nodes: readonly unknown[], seq: number): FileLanes {
  const mutations: FileLaneMutation[] = []
  let turn: number | undefined
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const record = node as { kind?: unknown; isError?: unknown; callView?: unknown; resultView?: unknown; turn?: unknown; seq?: number }
    if (record.kind === 'tool-result') {
      if (record.isError === true) continue
      const at = record.seq ?? Number.POSITIVE_INFINITY
      mutations.push(...mutationsFromView(record.resultView, at), ...mutationsFromView(record.callView, at))
      continue
    }
    if (record.kind === 'user') {
      mutations.length = 0
      turn = undefined
    } else if (typeof record.turn === 'number') {
      if (turn !== undefined && record.turn !== turn) mutations.length = 0
      turn = record.turn
    }
    if (record.kind === 'assistant' && record.seq === seq) return foldFileLanes(mutations)
  }
  return EMPTY_LANES
}

/**
 * Claim the turn-tail chain only when the closing turn produced files.
 *
 * The authoritative source is the engine Turn data — the same value
 * ui-deliverables reads (`owner.turn.data.get('deliverables')`): a
 * `{ produced: [{ seq, path, op }, ...] }` record accumulated per Turn. The
 * node-based replica below stays as a fallback for compositions that do not
 * publish it.
 * @param owner - the turn-tail owner currency ({turn, seq, openFile}).
 * @returns the three lanes as the matched value, or null to decline.
 */
export function selectProducedLanes(owner: unknown): FileLanes | null {
  const record = owner as {
    turn?: { data?: { get?: (key: string) => unknown } }
    nodes?: unknown
    seq?: unknown
  } | null
  if (record === null || typeof record !== 'object') return null
  const seq = typeof record.seq === 'number' ? record.seq : Number.POSITIVE_INFINITY
  const data = record.turn?.data?.get?.('deliverables') as DeliverablesTurnDataLike | null | undefined
  if (data !== null && typeof data === 'object' && Array.isArray(data.produced)) {
    const lanes = lanesFromTurnData(data, seq)
    return lanesEmpty(lanes) ? null : lanes
  }
  if (!Array.isArray(record.nodes)) return null
  const lanes = lanesForClosing(record.nodes, seq)
  return lanesEmpty(lanes) ? null : lanes
}

/**
 * Resolve a (possibly relative) path against the session cwd for the sidebar.
 * Absolute detection mirrors the host (see client/paths.isAbsolutePath):
 * POSIX roots, drive letters and UNC shares must not be joined onto the cwd.
 */
export function resolveSidebarPath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}
