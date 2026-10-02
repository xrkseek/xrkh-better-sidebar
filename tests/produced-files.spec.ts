import { describe, expect, it } from 'vitest'
import {
  foldFileLanes, lanesForClosing, resolveSidebarPath, selectProducedLanes,
} from '../src/client/produced-files.ts'

describe('produced-files lane derivation', () => {
  const diffResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'diff', locations: [{ path }] },
  })
  const editResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'edit', locations: [{ path }] },
  })
  const deleteResult = (path: string) => ({
    kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'delete', locations: [{ path }] },
  })
  const sidePairResult = (path: string, op: 'create' | 'modify' | 'delete') => ({
    kind: 'tool-result',
    isError: false,
    callView: {
      card: 'diff',
      diffs: [{
        path,
        oldText: op === 'create' ? null : 'a',
        newText: op === 'delete' ? '' : 'b',
      }],
      locations: [{ path }],
    },
  })

  it('classifies edits and deletes, not just creations', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      sidePairResult('new.ts', 'create'),
      editResult('old.ts'),
      deleteResult('gone.ts'),
      { kind: 'assistant', seq: 2, turn: 1 },
    ]
    expect(lanesForClosing(nodes, 2)).toEqual({
      created: ['new.ts'],
      modified: ['old.ts'],
      deleted: ['gone.ts'],
    })
  })

  it('classifies a locations-only diff card as modified', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      diffResult('a.ts'),
      { kind: 'assistant', seq: 2, turn: 1 },
    ]
    expect(lanesForClosing(nodes, 2).modified).toEqual(['a.ts'])
  })

  it('resets lanes on user messages and turn changes', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      editResult('old.ts'),
      { kind: 'user' },
      { kind: 'assistant', seq: 2, turn: 2 },
      editResult('new.ts'),
      { kind: 'assistant', seq: 3, turn: 2 },
    ]
    expect(lanesForClosing(nodes, 3)).toEqual({ created: [], modified: ['new.ts'], deleted: [] })
  })

  it('ignores reads, errors, and unknown cards', () => {
    const nodes = [
      { kind: 'assistant', seq: 1, turn: 1 },
      { kind: 'tool-result', isError: true, callView: { card: 'diff', locations: [{ path: 'x.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'read', locations: [{ path: 'r.ts' }] } },
      { kind: 'tool-result', isError: false, callView: { card: 'generic', kind: 'list', locations: [{ path: 'l.ts' }] } },
    ]
    expect(lanesForClosing(nodes, 1)).toEqual({ created: [], modified: [], deleted: [] })
  })

  it('keeps only the last op per path (a later delete wins)', () => {
    const lanes = foldFileLanes([
      { seq: 1, path: 'a.ts', op: 'create' },
      { seq: 2, path: 'a.ts', op: 'delete' },
      { seq: 3, path: 'b.ts', op: 'modify' },
    ])
    expect(lanes).toEqual({ created: [], modified: ['b.ts'], deleted: ['a.ts'] })
  })

  it('reads the op published on the turn data rows', () => {
    expect(selectProducedLanes({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? { produced: [
              { seq: 1, path: 'a.ts', op: 'create' },
              { seq: 2, path: 'b.ts', op: 'modify' },
              { seq: 3, path: 'c.ts', op: 'delete' },
            ] }
            : undefined,
        },
      },
      seq: 3,
    })).toEqual({ created: ['a.ts'], modified: ['b.ts'], deleted: ['c.ts'] })
  })

  it('drops rows after the closing seq', () => {
    expect(selectProducedLanes({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? {
              produced: [
                { seq: 1, path: 'a.ts', op: 'create' },
                { seq: 9, path: 'later.ts', op: 'create' },
              ],
            }
            : undefined,
        },
      },
      seq: 2,
    })).toEqual({ created: ['a.ts'], modified: [], deleted: [] })
  })

  it('falls back to the changes summary when no op was published', () => {
    expect(selectProducedLanes({
      turn: {
        data: {
          get: (key: string) => key === 'deliverables'
            ? {
              produced: [{ seq: 1, path: 'a.ts' }],
              changes: {
                seq: 2,
                files: [
                  { path: 'a.ts', added: 0, deleted: 4 },
                  { path: 'b.ts', added: 3, deleted: 0 },
                  { path: 'c.ts', added: 1, deleted: 1 },
                ],
              },
            }
            : undefined,
        },
      },
      seq: 2,
    })).toEqual({ created: [], modified: ['c.ts'], deleted: ['a.ts'] })
  })

  it('claims only when some lane holds a chip', () => {
    expect(selectProducedLanes({ nodes: [{ kind: 'assistant', seq: 1, turn: 1 }], seq: 1 })).toBeNull()
    expect(selectProducedLanes(null)).toBeNull()
    expect(selectProducedLanes({
      nodes: [diffResult('a.ts'), { kind: 'assistant', seq: 1, turn: 1 }],
      seq: 1,
    })).toEqual({ created: [], modified: ['a.ts'], deleted: [] })
  })

  it('resolves relative paths against the session cwd', () => {
    expect(resolveSidebarPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(resolveSidebarPath('/work/proj', '/abs/x.ts')).toBe('/abs/x.ts')
    expect(resolveSidebarPath(undefined, 'a.ts')).toBe('a.ts')
  })
})
