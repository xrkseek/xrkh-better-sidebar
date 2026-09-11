/**
 * Append text to the current session's composer draft through the
 * conversation service — the shared path behind the explorer's @-reference
 * button and the viewer selection popup. The service is resolved lazily
 * through `ctx.get` (the inject-free read the app's own plugins use); a
 * missing service or scope degrades to a logged no-op, never a crash.
 */
import type { Context, SidebarConversation } from '../context-types.ts'

/** Kind of workspace path the explorer is mentioning into the composer. */
export type PathMentionKind = 'file' | 'directory'

/**
 * Format a workspace-relative path as composer `@` mention text.
 * Directories always end with `/` (plain-text folder grammar); paths with
 * whitespace use the quoted `@"…"` form.
 */
export function formatPathMention(relativePath: string, kind: PathMentionKind): string {
  let path = relativePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (kind === 'directory') {
    if (path === '.' || path === '') path = '/'
    else if (!path.endsWith('/')) path = `${path}/`
  } else if (path === '' || path === '.') {
    path = '.'
  }
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

/**
 * Append `text` to the session's composer draft (space-separated, always with
 * a trailing space so the next keystroke is outside the `@` token and stays
 * undecorated). Then focus the composer. Returns false — and logs — when the
 * conversation service or the session scope is unavailable.
 */
export function appendToDraft(ctx: Context, sessionId: string, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation') as SidebarConversation | undefined
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const draft = input.state.getSnapshot().draft
    const chunk = `${text.replace(/\s+$/u, '')} `
    const base = draft.replace(/\s+$/u, '')
    input.setDraft(base === '' ? chunk : `${base} ${chunk}`)
    // Host SessionInput.focus already defers past the button click turn.
    input.focus?.()
    return true
  } catch (error) {
    console.warn('[xrkh-better-sidebar] draft insert failed:', error)
    return false
  }
}

/**
 * Append a file/directory `@` mention for `relativePath`, then focus the composer.
 */
export function appendPathMention(
  ctx: Context,
  sessionId: string,
  relativePath: string,
  kind: PathMentionKind,
): boolean {
  return appendToDraft(ctx, sessionId, formatPathMention(relativePath, kind))
}
