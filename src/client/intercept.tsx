/**
 * Chat file-open interception for the sidebar workbench.
 *
 * Wraps `ctx.workspaces.openPath` so tool-row / chip / mention opens land in
 * the sidebar editor. The folder-reveal gesture (`'.'` — official
 * deliverables "Show in folder") highlights the workspace folder in the
 * explorer once, then clears the tint.
 *
 * Turn-tail UI is owned by first-party `@xrkseek/client-ui-deliverables`
 * only; this plugin does not register on `conversation.chat.turnTail`.
 */
import type { Context } from '../context-types.ts'
import { firstLeaf, revealPaths, togglePanel, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import { resolveSidebarPath } from './produced-files.ts'
import { wrapOpenPath } from './openpath-intercept.ts'

/** Clear the explorer reveal tint after one flash (ms). */
const REVEAL_FLASH_MS = 1_600

/** Timer that clears the current reveal highlight (one flash only). */
let revealClearTimer: ReturnType<typeof setTimeout> | undefined

/** Open a file in the sidebar's editor (used by the explorer and openPath wrap). */
export function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const absolute = resolveSidebarPath(summary?.cwd, path)
  const at = Math.max(absolute.lastIndexOf('/'), absolute.lastIndexOf('\\'))
  const title = at === -1 ? absolute : absolute.slice(at + 1)
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title, path: absolute, id: `editor:${absolute}` })
}

/**
 * Reveal paths in the sidebar explorer: expand parents, highlight once,
 * focus the files window (expanding the panel when collapsed). Empty
 * `files` falls back to the session workspace root (folder gesture).
 */
export function revealInExplorer(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  files: readonly string[],
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = summary?.cwd
  const targets = files.length > 0
    ? files.map(path => resolveSidebarPath(cwd, path))
    : cwd === undefined ? [] : [cwd]
  store.reduce(state => revealPaths(state, cwd, targets))
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title: t('files') })
  // One flash only: clear the tint so tree-watch / expand churn cannot
  // keep re-scrolling to a sticky highlight.
  if (revealClearTimer !== undefined) clearTimeout(revealClearTimer)
  revealClearTimer = setTimeout(() => {
    revealClearTimer = undefined
    store.reduce(s => ((s.revealed ?? []).length === 0 ? s : { ...s, revealed: [] }))
  }, REVEAL_FLASH_MS)
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * so opens land in the sidebar editor. Folder-reveal (`'.'`) highlights the
 * workspace folder once. Returns the disposer restoring the original.
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => !store.getSuspended()
      && store.getPrefs().interceptOpenPath !== false
      && store.getPrefs().tabsEnabled['editor'] !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: (path, sessionId) => { openSidebarFile(ctx, store, sessionId, path) },
    // Official deliverables passes `'.'`; highlight the workspace folder once.
    revealInExplorer: (_path, sessionId) => { revealInExplorer(ctx, store, sessionId, []) },
  })
}
