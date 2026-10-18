/**
 * Chat file-open interception for the sidebar workbench.
 *
 * Wraps `ctx.workspaces.openPath` so tool-row / chip / mention opens land in
 * the sidebar editor with that tab's docked explorer panel forced open — the
 * file and its place in the tree appear together, exactly like "Show in
 * folder" — and the file's row tinted once. The folder-reveal gesture (`'.'`
 * — official deliverables "Show in folder") tints the workspace root once.
 *
 * Turn-tail UI is owned by first-party `@xrkseek/client-ui-deliverables`
 * only; this plugin does not register on `conversation.chat.turnTail`.
 */
import type { Context } from '../context-types.ts'
import {
  allLeaves, patchTabMeta, revealPaths, togglePanel,
  type SidebarState, type SidebarStore,
} from './state.ts'
import { t } from './locales.ts'
import { baseName } from './paths.ts'
import { rebasePath, sessionCwdFor } from './session-cwd.ts'
import { wrapOpenPath } from './openpath-intercept.ts'

/** Clear the explorer reveal tint after one flash (ms). */
const REVEAL_FLASH_MS = 1_600

/**
 * Timers that clear the reveal highlight (one flash each), keyed per store.
 * A single module-level timer let two stores (two sidebar roots / sessions)
 * cancel each other's clear, so one session's tint could stay lit until the
 * next reveal — the WeakMap keeps each store's flash independent and lets
 * the entry go away with its store.
 */
const revealClearTimers = new WeakMap<SidebarStore, ReturnType<typeof setTimeout>>()

/** Clear one store's pending reveal-tint timer (if any). */
function clearRevealTimer(store: SidebarStore): void {
  const pending = revealClearTimers.get(store)
  if (pending === undefined) return
  clearTimeout(pending)
  revealClearTimers.delete(store)
}

/**
 * Force one editor tab's docked explorer panel open. Accepts both the editor
 * The tab is found by PATH — openTab may have CREATED a per-path tab or
 * FOCUSED an existing one, and the path is the one identifier both share.
 * Passing `undefined` targets the pathless「文件」home window.
 * @param state - current sidebar state.
 * @param path - the tab's absolute file path, or undefined for the home window.
 * @returns the next state, or the same reference when no tab matches.
 */
function forceTreeOpen(state: SidebarState, path: string | undefined): SidebarState {
  const home = path === undefined || path === ''
  const target = allLeaves(state.splits).concat(allLeaves(state.bottomSplits)).flatMap(leaf => leaf.tabs)
    .concat(state.floats.map(float => float.tab))
    .find(tab => (home ? tab.path === undefined || tab.path === '' : tab.path === path))
  return target === undefined ? state : patchTabMeta(state, target.id, { treeOpen: true })
}

/** Open a file in the sidebar's editor (used by the explorer and openPath wrap). */
export function openSidebarFile(ctx: Context, store: SidebarStore, sessionId: string, path: string): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  // Chat spells its absolute path against the *list summary* cwd, which the
  // session may have outgrown; re-spell it under the host's cwd so the editor
  // tab and every later read agree with where the session actually lives.
  const absolute = rebasePath(sessionCwdFor(sessionId, summary?.cwd), summary?.cwd, path)
  const title = baseName(absolute)
  const tabId = `editor:${absolute}`
  // Route through the sidebar service so the editor descriptor's dedupeKey
  // (per-path) applies; the id is path-derived so multiple editors coexist.
  ctx.get('betterSidebar')?.openTab({
    type: 'editor',
    title,
    path: absolute,
    id: tabId,
  })
  // The tab may have been FOCUSED (same path already open) rather than
  // created, in which case the seed's meta was ignored — force the docked
  // explorer open on the tab that actually ended up active for this path.
  store.reduce(state => forceTreeOpen(state, absolute))
}

/**
 * Reveal a chat open in the sidebar.
 *
 * A FILE open tints the freshly opened file's row in the explorer and expands
 * its ancestors; the tab itself flashes too (TabBar), and the docked panel
 * was already forced open by {@link openSidebarFile}. A FOLDER gesture
 * (`files` empty, the official "Show in folder") has no file to point at, so
 * it opens the workspace root's explorer — the pathless editor home window —
 * and tints that root row.
 */
export function revealInExplorer(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  files: readonly string[],
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = sessionCwdFor(sessionId, summary?.cwd)
  if (files.length > 0) {
    const targets = files.map(path => rebasePath(cwd, summary?.cwd, path))
    store.reduce(state => revealPaths(state, cwd, targets))
  } else {
    // Folder gesture: reveal the workspace root — the folder the session
    // lives in — and open the pathless「文件」home window so its tree (and the
    // tinted root row) is on screen. File opens land their own editor tab, so
    // they never take this branch.
    if (cwd !== undefined) store.reduce(state => revealPaths(state, cwd, [cwd], true))
    ctx.get('betterSidebar')?.openTab({ type: 'editor', title: t('files') })
    store.reduce(state => forceTreeOpen(state, undefined))
  }
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  // One flash only: clear the tint so tree-watch / tab churn cannot keep it lit.
  clearRevealTimer(store)
  revealClearTimers.set(store, setTimeout(() => {
    revealClearTimers.delete(store)
    store.reduce(s => ((s.revealed ?? []).length === 0 ? s : { ...s, revealed: [] }))
  }, REVEAL_FLASH_MS))
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * so opens land in the sidebar editor and flash in the explorer. Folder-
 * reveal (`'.'`) highlights the workspace folder once. Returns the disposer
 * restoring the original.
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => !store.getSuspended()
      && store.getPrefs().interceptOpenPath !== false
      && store.getPrefs().tabsEnabled['editor'] !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: (path, sessionId) => {
      openSidebarFile(ctx, store, sessionId, path)
      revealInExplorer(ctx, store, sessionId, [path])
    },
    // Official deliverables passes `'.'`; highlight the workspace folder once.
    revealInExplorer: (_path, sessionId) => { revealInExplorer(ctx, store, sessionId, []) },
  })
}
