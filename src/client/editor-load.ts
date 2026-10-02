/**
 * Pure editor-load planning: the decision logic the editor host needs to
 * turn a matched file viewer + a host fs.read result into a render action.
 * Kept dependency-free (no React, no fetch) so the strategy dispatch is
 * unit-testable and the wire contract (head bytes, binary flag) is pinned.
 *
 * The host flow this module drives:
 *   1. `matchFileViewer(path)` picks a viewer by extension/priority.
 *   2. `planFirstMatch` dispatches its fetchStrategy.
 *   3. An fsRead viewer fetches through the host; `planFsReadOutcome`
 *      decides what to do with the result — including the head-based
 *      re-match that lets a `detect` viewer claim a binary the extension
 *      match could not see (the builtin NUL probe on `binary-download`).
 */
import type { FileViewerDescriptor } from './service.ts'

/** One host fs.read result (mirror of the wire; `head` present when binary). */
export interface FsReadOutcome {
  binary: boolean
  content: string
  truncated: boolean
  /** base64 of the first bytes (present on binary reads; sniffing material). */
  head?: string
  /**
   * Last-modified time of the file as the HOST saw it (absent for the media
   * routes, which never read bytes). The editor keeps it as the baseline for
   * "changed on disk" detection: the watcher broker only says a file's
   * directory is dirty, so without this stamp there is no way to tell an
   * external edit from the window in which our own save is landing.
   */
  mtimeMs?: number
}

/** What the editor host should do next. */
export type EditorLoadAction =
  /** No renderer: show the download UI. */
  | { kind: 'binary' }
  /** Render `viewer`'s component with the carried payload. */
  | { kind: 'render'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown; mtimeMs?: number }
  /** Fetch the file through the host (fsRead strategy). */
  | { kind: 'fetchFsRead'; viewer: FileViewerDescriptor }
  /** Call the viewer's load() and render with its return value. */
  | { kind: 'customLoad'; viewer: FileViewerDescriptor }

/**
 * What one watch round's stat says about the open file.
 *
 * The explorer broker reports dirty DIRECTORIES, so "did the file I have
 * open change?" is answered by comparing the mtime the load recorded against
 * the mtime the round stat observed. The three cases are deliberately
 * distinct:
 * - `ignore`: nothing to do, or no baseline to compare against. A viewer that
 *   never reads bytes (an image, a PDF) has no baseline, and treating "no
 *   stamp" as "changed" would remount the editor on every poll.
 * - `reload`: the file moved on and the editor holds nothing the user wrote —
 *   reload silently so the view is true.
 * - `notify`: a draft is live. The reload would remount the editor instance
 *   and drop the keystrokes, so the user is told instead.
 */
export type ExternalChangeAction = 'ignore' | 'reload' | 'notify'

/** Decide what a stat round means for the open file. */
export function decideExternalChange(
  baseline: number | undefined,
  observed: number | undefined,
  draftDirty: boolean,
): ExternalChangeAction {
  if (baseline === undefined || observed === undefined) return 'ignore'
  if (observed === baseline) return 'ignore'
  return draftDirty ? 'notify' : 'reload'
}

/** Decode the host's base64 head bytes into the sniffing buffer. */
export function decodeHead(headBase64: string): Uint8Array {
  const binary = atob(headBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Dispatch one matched viewer's fetchStrategy. A missing viewer or a
 * `binary-download` strategy both mean "no client-side renderer" → the
 * download UI. `mediaUrlOf` builds the media URL for `mediaUrl`/`none`
 * strategies (pure, but scope-bound — injected by the host).
 */
export function planFirstMatch(
  viewer: FileViewerDescriptor | undefined,
  mediaUrlOf: () => string,
): EditorLoadAction {
  if (viewer === undefined || viewer.fetchStrategy === 'binary-download') return { kind: 'binary' }
  switch (viewer.fetchStrategy) {
    case 'mediaUrl':
    case 'none':
      return { kind: 'render', viewer, mediaUrl: mediaUrlOf() }
    case 'custom':
      return { kind: 'customLoad', viewer }
    case 'fsRead':
      return { kind: 'fetchFsRead', viewer }
  }
}

/**
 * Decide what an fsRead result means for the editor.
 * - Text: the first match stands (content is valid for any fsRead viewer).
 * - Binary: the host head bytes enable a re-match — a `detect` viewer (e.g.
 *   a plugin sniffing a binary format) may claim the file. `custom` viewers
 *   load their own bytes; `mediaUrl`/`none` viewers render the media route;
 *   an fsRead viewer or nothing cannot render binary → download UI.
 */
export function planFsReadOutcome(
  viewer: FileViewerDescriptor,
  result: FsReadOutcome,
  rematch: (head: Uint8Array) => FileViewerDescriptor | undefined,
  mediaUrlOf: () => string,
): EditorLoadAction {
  if (!result.binary) {
    return { kind: 'render', viewer, content: result.content, truncated: result.truncated, mtimeMs: result.mtimeMs }
  }
  const claimed = result.head === undefined ? undefined : rematch(decodeHead(result.head))
  if (claimed !== undefined && claimed.fetchStrategy === 'custom') {
    return { kind: 'customLoad', viewer: claimed }
  }
  if (claimed !== undefined && (claimed.fetchStrategy === 'mediaUrl' || claimed.fetchStrategy === 'none')) {
    return { kind: 'render', viewer: claimed, mediaUrl: mediaUrlOf() }
  }
  return { kind: 'binary' }
}
