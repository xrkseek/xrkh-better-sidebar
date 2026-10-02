/**
 * Interception of the chat's file-lane rows: the turn-tail chain entry that
 * replaces ui-deliverables' rows when the closing turn produced files.
 * All three lanes (modified / deleted / created) render, like the host rows
 * they shadow; the chips open the file in the sidebar instead of the host
 * OS. Priority -1 runs before the default-0 deliverables entry; when nothing
 * was produced the selector returns null and the original rows render.
 *
 * Conflict with host ChangedFiles: claiming the chain hides the whole
 * deliverables entry (changed-files card + chips). When the turn also
 * announced a workspace/changes card, decline so deliverables keeps the
 * review card; chip opens still ride `workspaces.openPath` interception.
 */
import { IconCodeOutline16 } from '@xrkseek/client-ui-primitives'
import type { Context } from '../context-types.ts'
import { firstLeaf, revealPaths, togglePanel, type SidebarStore } from './state.ts'
import { t } from './locales.ts'
import {
  isFileLanes,
  lanesEmpty,
  resolveSidebarPath,
  selectProducedLanes,
  turnHasChangesCard,
  type FileLanes,
} from './produced-files.ts'
import { wrapOpenPath } from './openpath-intercept.ts'
import css from './sidebar.module.css'

/** Open a file in the sidebar's editor (used by the intercepted row and the explorer). */
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
 * The lanes the turn-tail selector last matched for the visible session.
 * The "Show in folder" gesture carries no file path of its own (`'.'`), so
 * the reveal highlights exactly these rows when available.
 */
let lastProduced: readonly string[] = []

/**
 * Reveal the produced files in the sidebar explorer: expand their parent
 * directories, highlight the rows, and focus the explorer tab (expanding the
 * hosting panel when it is collapsed). Unknown files fall back to revealing
 * the workspace root itself.
 */
export function revealInExplorer(
  ctx: Context,
  store: SidebarStore,
  sessionId: string,
  files: readonly string[],
): void {
  const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
  const cwd = summary?.cwd
  // Deliverables report paths as-is (often relative to the session cwd), but
  // the explorer tree and revealPaths work on absolute paths — resolve every
  // target so the ancestors expand and the row actually matches.
  const targets = files.length > 0
    ? files.map(path => resolveSidebarPath(cwd, path))
    : cwd === undefined ? [] : [cwd]
  store.reduce(state => revealPaths(state, cwd, targets))
  // A type-only open never auto-expands the panel (only content opens do,
  // see service.openTab) — so a reveal opens the panel itself when it is
  // collapsed, exactly like the subagent auto-open flows, or the highlight
  // would be set on an invisible panel.
  store.reduce(s => (s.panelOpen ? s : togglePanel(s)))
  // Pin the landing to the right panel: the files window must appear where
  // the panel just expanded, not in a bottom-panel pane the user last
  // touched.
  store.reduce(s => ({ ...s, activePane: firstLeaf(s.splits).id }))
  // Focus the single-instance editor home tab (the files window) where the
  // reveal highlight renders. Read via ctx.get like every other internal
  // consumer (#357): the provider is not on this fiber chain, so a direct
  // ctx.betterSidebar read can throw before optional chaining applies.
  ctx.get('betterSidebar')?.openTab({ type: 'editor', title: t('files') })
}

/** At most six chips compete for one lane row; every other path stays counted. */
const SHOWN_LIMIT = 6

/**
 * The intercepted file-lane rows (visual twin of the deliverables chips):
 * one row per lane, in the host's order — modified, deleted, created.
 * Deleted chips are inert: the file is gone, so there is nothing to open.
 *
 * Host chain seats inject the selector result as `matched` (`ChainEntryProps`).
 * Never rename that prop. Invalid/missing `matched` re-derives from owner
 * fields the host also spreads onto the seat (same as DeliverablesTail).
 */
export function SidebarProducedFiles(props: {
  matched?: FileLanes | null
  openInSidebar: (path: string) => void
  /** Reveal the produced files in the explorer ("Show in folder" twin). */
  onShowInFolder: (files: readonly string[]) => void
}) {
  const { openInSidebar, onShowInFolder } = props
  const lanes = isFileLanes(props.matched) ? props.matched : selectProducedLanes(props)
  if (lanes === null || lanesEmpty(lanes)) return null
  const rows = [
    { key: 'modified', label: t('laneModified'), paths: lanes.modified },
    { key: 'deleted', label: t('laneDeleted'), paths: lanes.deleted },
    { key: 'created', label: t('produced'), paths: lanes.created },
  ].filter(row => row.paths.length > 0)
  const hiddenTotal = rows.reduce(
    (sum, row) => sum + Math.max(0, row.paths.length - SHOWN_LIMIT),
    0,
  )
  const reveal = (): void => {
    onShowInFolder(rows.flatMap(row => row.paths))
  }
  return (
    <>
      {rows.map((row, index) => {
        const shown = row.paths.slice(0, SHOWN_LIMIT)
        const hidden = row.paths.length - shown.length
        const isLast = index === rows.length - 1
        return (
          <div key={row.key} className={css.producedRow} data-file-lane={row.key}>
            <span className={css.producedLabel}>{row.label}</span>
            {shown.map(path => {
              const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
              const name = at === -1 ? path : path.slice(at + 1)
              return (
                <button
                  key={path}
                  type="button"
                  className={`${css.producedChip} ${row.key === 'deleted' ? css.producedChipGone : ''}`}
                  title={path}
                  disabled={row.key === 'deleted'}
                  onClick={() => { openInSidebar(path) }}
                >
                  <IconCodeOutline16 size={12} />
                  <span>{name}</span>
                </button>
              )
            })}
            {hidden > 0 && (
              <>
                <span className={css.producedMore}>+{hidden}</span>
                {isLast && (
                  <button
                    type="button"
                    className={css.producedMore}
                    style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
                    onClick={() => { reveal() }}
                  >
                    {t('showInFolder')}
                  </button>
                )}
              </>
            )}
          </div>
        )
      })}
      {hiddenTotal === 0 && rows.length > 0 && (
        <div className={css.producedRow}>
          <button
            type="button"
            className={css.producedMore}
            style={{ cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}
            onClick={() => { reveal() }}
          >
            {t('showInFolder')}
          </button>
        </div>
      )}
    </>
  )
}

/**
 * Register the turn-tail interception (returns the disposer).
 *
 * The slot is a CHILD slot the host's ui-conversation declares in its
 * `conversation.chat.node` children table (kind: chain, scope: session).
 * Registering it directly races the declaration — the ui-slots core's
 * load-time validation throws "not declared (a parent entry's children
 * table must declare it)" when the parent entry is not on the ledger yet.
 * slots.inject waits for the declaration: the callback runs synchronously
 * when the slot is already declared, otherwise it runs inside the declaring
 * register() call once the declaration commits; declaration collapse
 * disposes the entry and a later declaration re-registers it. This mirrors
 * @xrkseek/client-ui-deliverables' registration of the same slot.
 */
export function registerTurnTailInterception(ctx: Context, store: SidebarStore): () => void {
  return ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
    name: 'conversation.chat.turnTail',
    // Decline the takeover while the editor tab type is disabled in the side
    // card settings: the produced-files row falls back to the default
    // deliverables behavior instead of offering chips that cannot open. Also
    // while the sidebar is externally disabled (aionui-panel chosen).
    // Decline when the host also has a changes card — claiming the chain
    // would hide ChangedFiles and leave only chips (or a crash face).
    select: (owner) => {
      if (store.getSuspended()) return null
      if (store.getPrefs().tabsEnabled['editor'] === false) return null
      // Decline when host already owns a changes card for this closing seq —
      // claiming the chain would hide ChangedFiles (chips still open via
      // workspaces.openPath interception).
      if (turnHasChangesCard(owner)) return null
      const lanes = selectProducedLanes(owner)
      if (lanes !== null) lastProduced = [...lanes.created, ...lanes.modified, ...lanes.deleted]
      return lanes
    },
    priority: -1,
    registrant: 'xrkh-better-sidebar',
    inject: (sessionId: string) => ({
      openInSidebar: (path: string) => { openSidebarFile(ctx, store, sessionId, path) },
      onShowInFolder: (files: readonly string[]) => { revealInExplorer(ctx, store, sessionId, files) },
    }),
  }, SidebarProducedFiles))
}

/**
 * Register the chat file-open interception: wraps `ctx.workspaces.openPath`
 * — the single funnel every chat-side file open goes through (tool-row path
 * links, the produced-files row, prose mentions) — so opens land in the
 * sidebar editor instead of the Host OS. The folder-reveal gesture ("Show in
 * folder" passes `'.'`) is the one exception: it is routed to the explorer.
 * Gated by BOTH the `interceptOpenPath` pref and the editor tab's enable
 * switch; declined opens fall through to the original method. Returns the
 * disposer restoring the original (HMR-safe).
 */
export function registerOpenPathInterception(ctx: Context, store: SidebarStore): () => void {
  return wrapOpenPath(ctx.workspaces, {
    takeoverEnabled: () => !store.getSuspended()
      && store.getPrefs().interceptOpenPath !== false
      && store.getPrefs().tabsEnabled['editor'] !== false,
    currentSessionId: () => ctx.sessions.list.getSnapshot().current,
    openInSidebar: (path, sessionId) => { openSidebarFile(ctx, store, sessionId, path) },
    revealInExplorer: (_path, sessionId) => { revealInExplorer(ctx, store, sessionId, lastProduced) },
  })
}
