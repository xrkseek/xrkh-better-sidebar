/**
 * Tests for the editor-load planning: the pure strategy dispatch the
 * editor host runs (planFirstMatch / planFsReadOutcome / decodeHead).
 */
import { describe, expect, it } from 'vitest'
import { decodeHead, decideExternalChange, planFirstMatch, planFsReadOutcome } from '../src/client/editor-load.ts'
import type { FileViewerDescriptor } from '../src/client/service.ts'

const viewer = (over: Partial<FileViewerDescriptor>): FileViewerDescriptor => ({
  id: 'v',
  exts: [],
  fetchStrategy: 'fsRead',
  component: () => null,
  ...over,
})

describe('planFirstMatch', () => {
  it('no viewer → binary (download UI)', () => {
    expect(planFirstMatch(undefined, () => '/m')).toEqual({ kind: 'binary' })
  })

  it('binary-download strategy → binary', () => {
    const v = viewer({ id: 'dl', fetchStrategy: 'binary-download' })
    expect(planFirstMatch(v, () => '/m')).toEqual({ kind: 'binary' })
  })

  it('mediaUrl / none → render with the media URL', () => {
    const v = viewer({ id: 'img', fetchStrategy: 'mediaUrl' })
    expect(planFirstMatch(v, () => '/media')).toEqual({ kind: 'render', viewer: v, mediaUrl: '/media' })
    expect(planFirstMatch(viewer({ id: 'none', fetchStrategy: 'none' }), () => '/m').kind).toBe('render')
  })

  it('custom → customLoad (the viewer loads its own bytes)', () => {
    const v = viewer({ id: 'csv', fetchStrategy: 'custom', load: async () => [] })
    expect(planFirstMatch(v, () => '/m')).toEqual({ kind: 'customLoad', viewer: v })
  })

  it('fsRead → fetchFsRead', () => {
    const v = viewer({ id: 'code', fetchStrategy: 'fsRead' })
    expect(planFirstMatch(v, () => '/m')).toEqual({ kind: 'fetchFsRead', viewer: v })
  })
})

describe('planFsReadOutcome', () => {
  const rematch = (head: Uint8Array): FileViewerDescriptor | undefined => {
    // The builtin binary-download NUL probe shape.
    if (head.includes(0)) return viewer({ id: 'binary-download', fetchStrategy: 'binary-download' })
    return undefined
  }

  it('text result renders with content, same viewer', () => {
    const v = viewer({ id: 'code' })
    const action = planFsReadOutcome(v, { binary: false, content: 'hello', truncated: true }, rematch, () => '/m')
    expect(action).toEqual({ kind: 'render', viewer: v, content: 'hello', truncated: true })
  })

  it('binary without head bytes → binary', () => {
    expect(planFsReadOutcome(viewer({}), { binary: true, content: '', truncated: false }, rematch, () => '/m')).toEqual({ kind: 'binary' })
  })

  it('binary whose NUL head re-matches nothing renderable → binary', () => {
    const action = planFsReadOutcome(
      viewer({}),
      { binary: true, content: '', truncated: false, head: 'AAAAAA==' }, // 0x00 bytes
      rematch,
      () => '/m',
    )
    // binary-download claims it — still the download UI.
    expect(action).toEqual({ kind: 'binary' })
  })

  it('binary re-matched to a custom viewer → customLoad (external sniffer)', () => {
    const sniffer = viewer({ id: 'my:raw', fetchStrategy: 'custom', load: async () => ({}) })
    const action = planFsReadOutcome(
      viewer({}),
      { binary: true, content: '', truncated: false, head: 'AAAAAA==' },
      () => sniffer,
      () => '/m',
    )
    expect(action).toEqual({ kind: 'customLoad', viewer: sniffer })
  })

  it('binary re-matched to a mediaUrl viewer → render with the media URL', () => {
    const media = viewer({ id: 'my:binimg', fetchStrategy: 'mediaUrl' })
    const action = planFsReadOutcome(
      viewer({}),
      { binary: true, content: '', truncated: false, head: 'AAAAAA==' },
      () => media,
      () => '/m?x=1',
    )
    expect(action).toEqual({ kind: 'render', viewer: media, mediaUrl: '/m?x=1' })
  })
})

describe('decodeHead', () => {
  it('decodes base64 to the exact bytes', () => {
    const head = decodeHead('AP//AA==')
    expect(Array.from(head)).toEqual([0x00, 0xff, 0xff, 0x00])
  })
})

describe('decideExternalChange', () => {
  it('carries the host read timestamp into the render action (the reload baseline)', () => {
    // Without this stamp the editor has nothing to compare a later stat
    // against, so external modification becomes undetectable.
    const action = planFsReadOutcome(
      viewer({}),
      { binary: false, content: 'x', truncated: false, mtimeMs: 42 },
      () => undefined,
      () => '/m',
    )
    expect(action.kind === 'render' && action.mtimeMs).toBe(42)
  })

  it('ignores an unchanged mtime', () => {
    expect(decideExternalChange(100, 100, false)).toBe('ignore')
  })

  it('ignores a missing baseline — an image or PDF viewer has no stamp to compare', () => {
    // Treating "no baseline" as "changed" would remount the editor on every
    // watch round, forever.
    expect(decideExternalChange(undefined, 200, false)).toBe('ignore')
    expect(decideExternalChange(100, undefined, false)).toBe('ignore')
  })

  it('reloads a clean file that changed underneath the editor', () => {
    expect(decideExternalChange(100, 200, false)).toBe('reload')
  })

  it('notifies instead of reloading while a draft is live', () => {
    // The reload remounts the editor instance, which is where the keystrokes
    // live; overwriting them silently is the one outcome that is never ok.
    expect(decideExternalChange(100, 200, true)).toBe('notify')
  })
})
