/**
 * The editor tab host: the single FILES WINDOW. It resolves a file's
 * previewer through the sidebar registry (`matchFileViewer`), fetches bytes
 * per the matched viewer's fetch strategy, and renders its component — or
 * the shared download pane when nothing can render the file.
 *
 * The file tree has two homes on this one surface, exactly like the upstream
 * workbench: a DOCKED explorer panel beside the file content (per-tab
 * `meta.treeOpen` / `meta.treeWidth`, default open for the path-less home)
 * and a full-window form for the path-less window in split mode — that window
 * IS the standalone explorer — plus a folder window (`meta.dir`) rooting the
 * same tree at that folder. A chat file open lands in the editor, forces the
 * docked panel open and tints the file's row, so the file and its place in
 * the tree appear together.
 *
 * The `editorExplorer` mode (read reactively so toggling it re-renders
 * without a reload) only decides what a tree click / path-input Enter does:
 * merged (in-place) rewrites the CURRENT tab's path/title; split opens
 * through `openSidebarFile` (a per-path dedupe tab). The tree's context menu
 * offers the explicit escapes either way: open in a new tab (per-path
 * dedupe) or to the side (a fresh tab in a fresh rightward split).
 *
 * The strategy dispatch is pure (planFirstMatch / planFsReadOutcome in
 * editor-load.ts); this component only wires it to the host APIs.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createElement } from 'react'
import clsx from 'clsx'
import { IconCheckOutlineRegular, IconFolderOpenRegular, IconRefreshOutlineRegular } from '@xrkseek/client-ui-primitives'
import type { Context } from '../context-types.ts'
import { api, isOutsideWorkspaceMessage, mediaUrl, type SessionScope } from './api.ts'
import { BinaryDownload } from './binary-download.tsx'
import { FenceErrorNotice } from './FenceErrorNotice.tsx'
import { decideExternalChange, planFirstMatch, planFsReadOutcome, type EditorLoadAction } from './editor-load.ts'
import { createFrameBatcher } from './frame-batcher.ts'
import { baseName } from './paths.ts'
import { openSidebarFile } from './intercept.tsx'
import { openWithSshActive, openWithUrl, parseOpenWithConfig, resolveOpenWithTargets } from './open-with.ts'
import { updatePluginSettings } from './plugin-settings.ts'
import { TreePanel } from './TreePanel.tsx'
import { nudgeTreeWatch, subscribeTreeWatch } from './tree-watch.ts'
import { t } from './locales.ts'
import { relativeTo } from './paths.ts'
import { resolveSidebarPath } from './produced-files.ts'
import type { EditorToolbarControls, EditorToolbarState, FileViewerDescriptor } from './service.ts'
import {
  expandDir, firstLeaf, insertLeafAt, leafWithTab, mintTabId, patchTabMeta, TREE_PANEL_MAX,
  TREE_PANEL_MIN, toggleTabTree, treeOf, treeOpenOf, treeWidthOf, type SidebarStore,
  type SidebarTab,
} from './state.ts'
import css from './sidebar.module.css'

type EditorLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; viewer: FileViewerDescriptor; content?: string; truncated?: boolean; mediaUrl?: string; customData?: unknown; mtimeMs?: number }
  | { status: 'binary' }

/** Stable empty blob for the editor pluginSettings read (a fresh `?? {}`
 *  would change identity every snapshot and loop useSyncExternalStore). */
const EMPTY_PLUGIN_BLOB: Record<string, unknown> = {}

/** The tab's persisted meta object (a malformed meta reads as empty). */
function metaOf(tab: SidebarTab): Record<string, unknown> {
  return tab.meta !== null && typeof tab.meta === 'object' && !Array.isArray(tab.meta)
    ? tab.meta as Record<string, unknown>
    : {}
}

/** The dock's width ceiling as a fraction of the editor body. This is the JS
 *  half of the max-width:70% rule on .editorTreeDock (sidebar.module.css): the
 *  drag and the ARIA range clamp to the SAME limit the layout can paint, so a
 *  narrow panel cannot report (or be dragged toward) a width that is never on
 *  screen. */
const TREE_DOCK_MAX_RATIO = 0.7

/** Clamp one dock width into the contract range (the same math the drag
 *  applies per move — shared so release can recompute it from the pointer).
 *  max is the container-aware ceiling; the contract minimum always wins,
 *  so a pathologically narrow body cannot invert the range. */
function clampTreeWidth(value: number, max: number = TREE_PANEL_MAX): number {
  return Math.min(Math.max(TREE_PANEL_MIN, max), Math.max(TREE_PANEL_MIN, Math.round(value)))
}

export function EditorHost(props: {
  ctx: Context
  store: SidebarStore
  scope: SessionScope
  tab: SidebarTab
  expanded: string[]
  /** Absolute paths tinted in the explorer (a chat file open / "Show in folder"). */
  revealed: readonly string[]
  onToggleDir: (path: string) => void
  onReferenceFile: (path: string, kind?: 'file' | 'directory') => void
}) {
  const { ctx, store, scope, tab, expanded, revealed, onToggleDir, onReferenceFile } = props
  const path = tab.path ?? ''
  const title = tab.title
  // A folder window: the model's `sidebar_open` (or any caller) opens a
  // directory as an editor tab carrying `meta.dir: true` with the directory
  // as its path. It renders the file tree rooted at that folder instead of
  // the viewer loading flow (a directory is not a file).
  const isDir = metaOf(tab).dir === true
  const [load, setLoad] = useState<EditorLoad>({ status: 'loading' })
  /** Last "open with" failure, shown as a dismissible notice on the tree. */
  const [externalError, setExternalError] = useState<string | null>(null)
  // Manual refresh (issue #167): bumping the sequence re-runs the load effect
  // with the same path/scope — the only reload entry besides open/close.
  const [reloadSeq, setReloadSeq] = useState(0)

  // Manual refresh (issue #167 + PR #228): a dirty draft is dropped by the
  // reload (the editor instance remounts), so confirm before discarding it.
  const refreshFile = (): void => {
    if (toolbar?.dirty === true) {
      const confirmed = typeof window.confirm === 'function'
        ? window.confirm(t('refreshUnsavedConfirm'))
        : false
      if (!confirmed) return
    }
    setReloadSeq(sequence => sequence + 1)
  }

  // Reactive prefs read: flipping editorExplorer re-renders this tab with no
  // reload. The snapshot is the bare boolean so unrelated store churn never
  // re-renders the editor.
  const inPlace = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.editorExplorer, [store]),
  )
  // The file tree's "open with" configuration (pluginSettings['editor']): a
  // blob subscription, so a pin click or a settings-page edit re-renders the
  // menu immediately. The parsed config also drives which targets are shown
  // (SSH mode hides the host-local ones).
  const editorBlob = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot().prefs.pluginSettings['editor'] ?? EMPTY_PLUGIN_BLOB, [store]),
  )
  const openWithConfig = useMemo(() => parseOpenWithConfig(editorBlob.openWith), [editorBlob])
  const openWithTargets = useMemo(() => resolveOpenWithTargets(openWithConfig), [openWithConfig])
  // A path-less tab shows the empty-state hint in merged mode — and in split
  // mode it is the standalone explorer (tree-only, see the render below). A
  // folder tab is a folder window in BOTH modes: the tree rooted at the
  // folder, no editor chrome.
  const showEmpty = path === ''
  // A path-less window in split mode IS the standalone explorer (the tree,
  // full-window). In merged mode a path-less window is the empty editor with
  // its path input, and the DOCKED panel is available beside it.
  const treeOnly = showEmpty && !inPlace
  const folderRoot = isDir ? path : undefined

  // ── The docked explorer panel ──────────────────────────────────────────
  // Per-tab `meta.treeOpen` / `meta.treeWidth` (state.ts). A chat file open
  // sets treeOpen=true on the tab it just landed, so the file and its row in
  // the tree appear together — the behavior the reveal gestures promise.
  const treeOpen = treeOpenOf(tab)
  const toggleTree = useCallback((): void => {
    store.reduce(state => toggleTabTree(state, tab.id))
  }, [store, tab.id])
  // The docked panel's drag-resize: pointer capture on the handle (no window
  // listeners), the width batched per frame (see createFrameBatcher) and
  // committed into `meta.treeWidth` on release. The panel docks right, so
  // dragging LEFT widens it.
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number; moved: boolean } | null>(null)
  const pendingWidthRef = useRef(0)
  const dragBatcher = useRef(createFrameBatcher()).current
  useEffect(() => () => dragBatcher.dispose(), [dragBatcher])
  // The dock renders at min(treeWidth, 70% of the body): the stylesheet's
  // max-width is the declarative half of that contract and this is the
  // measured half. Without it a narrow sidebar paints the dock well below
  // meta.treeWidth, so the ARIA value overstates the real width AND the drag
  // spends its first pixels against an invisible ceiling. jsdom ships no
  // ResizeObserver and reports clientWidth 0, so there the ceiling stays at
  // the plain contract maximum.
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [bodyWidth, setBodyWidth] = useState(0)
  useEffect(() => {
    const element = bodyRef.current
    if (element === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(() => { setBodyWidth(element.clientWidth) })
    observer.observe(element)
    setBodyWidth(element.clientWidth)
    return () => { observer.disconnect() }
  }, [treeOnly, folderRoot])
  const treeWidthMax = bodyWidth > 0
    ? Math.min(TREE_PANEL_MAX, Math.max(TREE_PANEL_MIN, Math.floor(bodyWidth * TREE_DOCK_MAX_RATIO)))
    : TREE_PANEL_MAX
  const treeWidth = Math.min(dragWidth ?? treeWidthOf(tab), treeWidthMax)
  const commitTreeWidth = useCallback((width: number): void => {
    store.reduce(state => patchTabMeta(state, tab.id, { treeWidth: width }))
  }, [store, tab.id])
  /** Drop an in-flight drag without committing (cancel / lost capture). */
  const abortTreeDrag = useCallback((): void => {
    dragBatcher.flushNow()
    dragRef.current = null
    setDragWidth(null)
  }, [dragBatcher])

  /**
   * Open a file from THIS window (tree click / search row / path input):
   * merged mode switches this tab in place (stable id, meta survives);
   * split mode opens a per-path dedupe tab through openSidebarFile.
   */
  // The five callbacks below are all the docked tree sees as props. They are
  // `useCallback`-stable on purpose: `TreePanel` is memoised, and this host
  // re-renders on EVERY path switch (in-place mode rewrites the tab in place).
  // With inline callbacks a single file click re-reconciled the whole explorer
  // subtree — hundreds of rows — while only the viewer content had changed.
  // The deps are exactly the values a path switch leaves untouched (tab.id is
  // the tab's identity; a switch rewrites only path/title), so the memo holds.
  const openFile = useCallback((absolute: string): void => {
    if (inPlace) {
      ctx.get('betterSidebar')?.updateTab(tab.id, { path: absolute, title: baseName(absolute) })
    } else {
      openSidebarFile(ctx, store, scope.sessionId, absolute)
    }
  }, [ctx, inPlace, scope.sessionId, store, tab.id])

  /** The context menu's explicit "new tab" escape (per-path dedupe). */
  const openFileNewTab = useCallback((absolute: string): void => {
    openSidebarFile(ctx, store, scope.sessionId, absolute)
  }, [ctx, scope.sessionId, store])

  /**
   * The context menu's "open to the side": a fresh editor tab (uid id — the
   * `'editor:' + path` convention would clash with the id safety net on a
   * second side-open of the same file) in a rightward split of THIS pane.
   */
  const openFileSide = useCallback((absolute: string): void => {
    store.reduce((state) => {
      const key = treeOf(state, tab.id)
      const pane = leafWithTab(state[key], tab.id) ?? firstLeaf(state[key])
      const fresh: SidebarTab = {
        id: mintTabId(),
        type: 'editor',
        title: baseName(absolute),
        path: absolute,
      }
      const { node, leafId } = insertLeafAt(state[key], pane.id, 'row', fresh, false)
      return { ...state, [key]: node, activePane: leafId }
    })
  }, [store, tab.id])

  /** The context menu's "open with" action: reveal the path in the OS file
   *  manager, or hand the target's URL (a local `file` URL, or the SSH-remote
   *  form for VSCode-family editors in remote mode) to the host's external
   *  opener. Failures surface as a notice on the tree panel: the action is
   *  fire-and-forget, so a swallowed rejection is indistinguishable from a
   *  dead menu row — a policy refusal or a missing handler used to read as
   *  "nothing happened". */
  const openWith = useCallback((targetId: string, absolute: string): void => {
    const target = openWithTargets.find(item => item.id === targetId)
    if (target === undefined) return
    const report = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('open external failed', error)
      setExternalError(t('openExternalFailed', { message }))
    }
    if (target.kind === 'reveal') {
      setExternalError(null)
      void api.openExternal({ action: 'reveal', path: absolute }).catch(report)
      return
    }
    const url = openWithUrl(target, absolute, openWithConfig)
    if (url === undefined) return
    setExternalError(null)
    void api.openExternal({ action: 'url', url }).catch(report)
  }, [openWithConfig, openWithTargets])

  /** Toggle one target's pinned state. The write is serialized (see
   *  plugin-settings.ts) and the menu re-renders when the store prefs land. */
  const toggleOpenWithPin = useCallback((targetId: string): void => {
    updatePluginSettings(store, 'editor', (blob) => {
      const config = parseOpenWithConfig(blob.openWith)
      const pinned = config.pinned.includes(targetId)
        ? config.pinned.filter(id => id !== targetId)
        : [...config.pinned, targetId]
      return { ...blob, openWith: { ...config, pinned } }
    })
  }, [store])

  /* ── File mutations (new file/folder, rename, delete) ──────────────────
     The tree owns the prompts; this host owns the API calls, the error
     surface and the tree invalidation. Every failure lands on the same
     `externalError` notice rather than the console: a silent refusal on a
     destructive action is indistinguishable from a broken menu. */
  const joinPath = (dir: string, name: string): string => {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
    return `${dir}${sep}${name}`
  }

  const reportFs = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    console.error('file operation failed', error)
    // A mkdir/write/rename/delete refusal is NOT an "open externally"
    // failure: the notice must name the action the user took.
    setExternalError(t('fsOperationFailed', { message }))
  }

  /** Re-list the levels a mutation touched, then surface the new entry. */
  const afterMutation = useCallback((path: string): void => {
    setExternalError(null)
    nudgeTreeWatch(scope)
    if (path === '') return
    // EXPAND the parent (idempotent) instead of toggling it: the folder the
    // menu was opened on is usually ALREADY open — a toggle would fold it
    // shut and hide the row that was just created.
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    if (at > 0) store.reduce(state => expandDir(state, path.slice(0, at)))
  }, [scope, store])

  const createEntry = useCallback((dir: string, name: string, isDir: boolean): void => {
    const path = joinPath(dir, name)
    const work = isDir
      ? api.fsMkdir(scope, path)
      : api.fsWrite(scope, path, '')
    void work.then(() => { afterMutation(path) }).catch(reportFs)
  }, [afterMutation, scope])

  const renameEntry = useCallback((path: string, name: string): void => {
    const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    const parent = at <= 0 ? path : path.slice(0, at)
    void api.fsRename(scope, path, joinPath(parent, name))
      .then(() => { afterMutation(joinPath(parent, name)) })
      .catch(reportFs)
  }, [afterMutation, scope])

  const deleteEntry = useCallback((path: string): void => {
    void api.fsDelete(scope, path)
      .then(() => {
        setExternalError(null)
        nudgeTreeWatch(scope)
      })
      .catch(reportFs)
  }, [scope])

  // The viewer's toolbar, hoisted into THIS header: the text editor reports
  // its state and registers its commands (both null/absent for viewers
  // without a toolbar — image, pdf, binary download).
  const [toolbar, setToolbar] = useState<EditorToolbarState | null>(null)
  const controlsRef = useRef<EditorToolbarControls | null>(null)
  const onToolbarState = useCallback((next: EditorToolbarState) => {
    setToolbar(prev => prev !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next)
  }, [])
  const onToolbarControls = useCallback((controls: EditorToolbarControls | null) => {
    controlsRef.current = controls
  }, [])

  useEffect(() => {
    // A (re)load or a path-less tab clears any hoisted toolbar state — the
    // fresh viewer re-registers its own.
    setToolbar(null)
    // The seeded home tab (no path) never loads a viewer — the empty-state
    // hint renders until the user picks a file. A folder tab never loads a
    // viewer either — its tree is rooted at the folder.
    if (showEmpty || isDir) return
    let cancelled = false
    // Aborts the matched viewer's `load` when the editor tears down (tab
    // closed, path changed, session switched) or re-matches the viewer.
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    const mediaUrlOf = (): string => mediaUrl(scope, path)
    const apply = (action: EditorLoadAction): void => {
      if (cancelled) return
      switch (action.kind) {
        case 'binary':
          setLoad({ status: 'binary' })
          return
        case 'render':
          setLoad({
            status: 'ready',
            viewer: action.viewer,
            content: action.content,
            truncated: action.truncated,
            mediaUrl: action.mediaUrl,
            customData: action.customData,
            mtimeMs: action.mtimeMs,
          })
          return
        case 'customLoad':
          void action.viewer.load?.(path, scope, controller.signal).then((data) => {
            if (cancelled) return
            setLoad({ status: 'ready', viewer: action.viewer, customData: data })
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
        case 'fetchFsRead':
          api.fsRead(scope, path).then((result) => {
            if (cancelled) return
            // Binary reads carry the head bytes for the detect re-match.
            const outcome = planFsReadOutcome(action.viewer, {
              binary: result.kind === 'binary',
              content: result.kind === 'text' ? result.content : '',
              truncated: result.truncated,
              head: result.kind === 'binary' ? result.head : undefined,
              mtimeMs: result.mtimeMs,
            }, (head) => ctx.get('betterSidebar')?.matchFileViewer(path, head), mediaUrlOf)
            apply(outcome)
          }).catch((error: unknown) => {
            if (cancelled) return
            setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
          })
          return
      }
    }
    apply(planFirstMatch(ctx.get('betterSidebar')?.matchFileViewer(path), mediaUrlOf))
    return () => { cancelled = true; controller.abort() }
  }, [scope.sessionId, scope.cwd, path, ctx, showEmpty, isDir, reloadSeq])

  // Save-then-refresh in preview mode (issue #167 part C): the edge into
  // 'saved' (never a lingering 'saved' state) triggers exactly one reload, so
  // a preview-mode Ctrl+S shows the fresh content immediately. Edit mode is
  // left alone — reloading would remount the editor and drop the caret.
  // Also nudge the explorer poller so the tree picks up rename/mtime without
  // waiting for the idle 4s heartbeat.
  const prevSaveState = useRef<EditorToolbarState['saveState'] | undefined>(undefined)
  useEffect(() => {
    const current = toolbar?.saveState
    if (prevSaveState.current !== 'saved' && current === 'saved') {
      if (scope.cwd !== undefined) {
        nudgeTreeWatch({ sessionId: scope.sessionId, cwd: scope.cwd })
      }
      if (toolbar?.mode === 'preview') {
        setReloadSeq(sequence => sequence + 1)
      }
    }
    prevSaveState.current = current
  }, [toolbar?.saveState, toolbar?.mode, scope.sessionId, scope.cwd])

  // ── External modification of the open file ───────────────────────────────
  // The broker answers with DIRTY DIRECTORIES, not files, so the editor keeps
  // the host's mtime from its own read as the baseline and asks for a stat of
  // the open path every round (the batch folds them all into one request).
  // That stamp is the whole point: without it there is no way to tell an
  // outside edit from the window in which our own save is still landing.
  const [changedOnDisk, setChangedOnDisk] = useState(false)
  /** The mtime of the bytes currently rendered (undefined without a baseline). */
  const loadedMtime = useRef<number | undefined>(undefined)
  useEffect(() => {
    loadedMtime.current = load.status === 'ready' ? load.mtimeMs : undefined
    // A reload has just made what is on screen current again, so any pending
    // notice is stale the moment new content lands.
    if (load.status === 'ready') setChangedOnDisk(false)
  }, [load])
  /** Read through a ref so the subscription below is not rebuilt per keystroke. */
  const draftDirty = useRef(false)
  useEffect(() => { draftDirty.current = toolbar?.dirty === true }, [toolbar?.dirty])
  // A saved (or untouched) draft makes the notice moot — the bytes on disk are
  // the ones in the editor.
  useEffect(() => { if (!draftDirty.current) setChangedOnDisk(false) }, [toolbar?.dirty, toolbar?.saveState])

  const openFileStatPaths = useCallback(
    () => (path === '' || isDir || scope.cwd === undefined ? [] : [path]),
    [path, isDir, scope.cwd],
  )
  useEffect(() => {
    if (scope.cwd === undefined || openFileStatPaths().length === 0) return
    return subscribeTreeWatch({ sessionId: scope.sessionId, cwd: scope.cwd }, {
      // The tree panel owns the directory subscriptions; this one only rides
      // along for the stat probe.
      dirs: () => [],
      statPaths: openFileStatPaths,
      onLevels: () => {},
      onStats: (rows) => {
        const row = rows.find(item => item.path === path)
        if (row === undefined) return
        const action = decideExternalChange(loadedMtime.current, row.mtimeMs, draftDirty.current)
        if (action === 'reload') {
          setReloadSeq(sequence => sequence + 1)
          return
        }
        if (action === 'notify') {
          setChangedOnDisk(true)
        }
      },
    })
  }, [path, scope.sessionId, scope.cwd, openFileStatPaths])

  const saveLabel = toolbar === null ? ''
    : toolbar.saveState === 'saving' ? t('loading')
      : toolbar.saveState === 'saved' ? t('saved')
        : toolbar.saveState === 'failed' ? t('saveFailed') : ''

  // The one file-tree surface. The path-less window in split mode IS the
  // standalone explorer and a folder window (`meta.dir`) roots the same tree
  // at that folder; both fill the whole tab (search + FileTree, full form)
  // with no editor chrome. A FILE tab docks the same surface beside its
  // content (the `full` prop is off there, so it renders as the companion
  // panel). File opens land in new per-path tabs through `openFile` above
  // (merged mode rewrites this very tab instead).
  // `full` fills the whole tab (the standalone explorer / folder window);
  // the docked panel passes it off so the tree settles into its column.
  const treePanel = (full: boolean) => (
    <TreePanel
      full={full}
      store={store}
      sessionId={scope.sessionId}
      cwd={folderRoot ?? scope.cwd}
      expanded={expanded}
      revealed={revealed}
      onToggle={onToggleDir}
      onOpenFile={openFile}
      onOpenFileNewTab={openFileNewTab}
      onOpenFileSide={openFileSide}
      openWithTargets={openWithTargets}
      openWithPinned={openWithConfig.pinned}
      openWithSsh={openWithSshActive(openWithConfig)}
      onOpenWith={openWith}
      onToggleOpenWithPin={toggleOpenWithPin}
      onReferenceFile={onReferenceFile}
      onFsCreate={createEntry}
      onFsRename={renameEntry}
      onFsDelete={deleteEntry}
    />
  )

  if (treeOnly || folderRoot !== undefined) {
    return (
      <div className={css.editor}>
        {externalError !== null && (
          <div
            className={clsx(css.editorSearchHint, css.editorError)}
            role="alert"
            onClick={() => { setExternalError(null) }}
            title={t('close')}
          >
            {externalError}
          </div>
        )}
        {treePanel(true)}
      </div>
    )
  }

  return (
    <div className={css.editor}>
      <div className={css.editorHeader}>
        <EditorPathInput key={path} path={path} cwd={scope.cwd} onOpen={openFile} />
        {toolbar?.modes === true && (
          <div className={css.editorModeToggle}>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'preview' && css.editorModeActive)}
              onClick={() => {
                // Issue #167 part B: returning from edit to preview reloads so
                // the preview renders the just-saved content. A dirty draft
                // (or a failed save) suppresses the reload — the draft only
                // lives in the editor instance and a remount would drop it.
                if (toolbar.mode === 'edit' && toolbar.dirty !== true && toolbar.saveState !== 'failed') {
                  setReloadSeq(sequence => sequence + 1)
                }
                controlsRef.current?.setMode('preview')
              }}
            >
              {t('preview')}
            </button>
            <button
              type="button"
              className={clsx(css.editorModeButton, toolbar.mode === 'edit' && css.editorModeActive)}
              onClick={() => { controlsRef.current?.setMode('edit') }}
            >
              {t('edit')}
            </button>
          </div>
        )}
        {toolbar?.dirty === true && <span className={css.dirtyDot} title={t('unsaved')} />}
        {changedOnDisk && (
          <span className={css.editorChangedOnDisk} role="status">
            <span className={css.editorChangedOnDiskText}>{t('fileChangedOnDisk')}</span>
            <button
              type="button"
              className={css.iconButton}
              aria-label={t('refresh')}
              title={t('refresh')}
              onClick={refreshFile}
            >
              <IconRefreshOutlineRegular size={12} />
            </button>
          </span>
        )}
        {toolbar?.editable === true && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('save')}
            title={`${t('save')} (Ctrl/Cmd+S)`}
            onClick={() => { controlsRef.current?.save() }}
          >
            <IconCheckOutlineRegular size={14} />
          </button>
        )}
        {saveLabel !== '' && (
          <span className={clsx(css.editorStatus, toolbar?.saveState === 'failed' && css.editorStatusError)}>{saveLabel}</span>
        )}
        {toolbar !== null && (
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            onClick={refreshFile}
          >
            <IconRefreshOutlineRegular size={14} />
          </button>
        )}
        {/*
          The docked explorer toggle: a VSCode-style "toggle sidebar" button
          in the editor's own toolbar. A chat file open turns it on for the
          tab it landed, which is how the file and its tree row appear
          together.
        */}
        <button
          type="button"
          className={clsx(css.iconButton, treeOpen && css.editorTreeToggleActive)}
          aria-label={t('editorTreeToggle')}
          title={t('editorTreeToggle')}
          aria-pressed={treeOpen}
          onClick={toggleTree}
        >
          <IconFolderOpenRegular size={14} />
        </button>
      </div>
      <div className={css.editorBody} ref={bodyRef}>
        <div className={css.editorMain}>
          {showEmpty && <div className={css.editorPlaceholder}>{t('editorEmptyHint')}</div>}
          {!showEmpty && load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
          {!showEmpty && load.status === 'error' && (isOutsideWorkspaceMessage(load.message)
            ? <FenceErrorNotice store={store} onDisabled={() => { setReloadSeq(sequence => sequence + 1) }} />
            : <div className={css.editorError}>{load.message}</div>)}
          {!showEmpty && load.status === 'binary' && (
            <BinaryDownload scope={scope} path={path} notice={externalError ?? undefined} />
          )}
          {/* A failed "open with" / file mutation is shown over whatever
              content is live — a one-shot notice, not a file-state error. The
              binary pane renders the SAME text as its own download notice, so
              this copy stays off there: one alert, not two siblings. */}
          {!showEmpty && load.status !== 'binary' && externalError !== null && (
            <div
              className={clsx(css.editorSearchHint, css.editorError)}
              role="alert"
              onClick={() => { setExternalError(null) }}
              title={t('close')}
            >
              {externalError}
            </div>
          )}
          {!showEmpty && load.status === 'ready' && createElement(load.viewer.component, {
            ctx, store, scope, path, title,
            viewerId: load.viewer.id,
            content: load.content,
            truncated: load.truncated,
            mediaUrl: load.mediaUrl,
            customData: load.customData,
            // The viewer's toolbar always hoists into this host's header.
            toolbar: 'host',
            onToolbarState,
            onToolbarControls,
          })}
        </div>
        {/*
          The docked explorer: the companion tree beside the file content
          (`full` off → it fills this column). The handle is an invisible
          strip on the dock's left edge; pointer capture keeps the drag alive
          off-handle. Mirrors the upstream workbench exactly.
        */}
        {treeOpen && (
          <div className={css.editorTreeDock} style={{ width: treeWidth }}>
            <div
              className={css.editorTreeResize}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('editorTreeToggle')}
              aria-valuenow={treeWidth}
              aria-valuemin={TREE_PANEL_MIN}
              aria-valuemax={treeWidthMax}
              // Focusable so the splitter is reachable and nudgeable from the
              // keyboard — the drag alone strands every keyboard-only user.
              // Arrow keys mirror the mouse: the panel docks right, so LEFT
              // widens it.
              tabIndex={0}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 64 : 16
                let next: number | null = null
                if (event.key === 'ArrowLeft') next = treeWidth + step
                else if (event.key === 'ArrowRight') next = treeWidth - step
                else if (event.key === 'Home') next = TREE_PANEL_MIN
                else if (event.key === 'End') next = treeWidthMax
                if (next === null) return
                event.preventDefault()
                commitTreeWidth(clampTreeWidth(next, treeWidthMax))
              }}
              onPointerDown={(event) => {
                // Primary button only: a right/middle press on the strip must
                // not start a resize (nor swallow the context-menu gesture).
                if (event.button !== 0) return
                event.preventDefault()
                // preventDefault suppresses the browser's own focus-on-press,
                // so a mouse grab would leave the handle unfocused and the
                // arrow-key nudge unreachable right after the drag.
                event.currentTarget.focus()
                // jsdom lacks setPointerCapture — the tests dispatch plain
                // MouseEvents (see the other drag specs).
                event.currentTarget.setPointerCapture?.(event.pointerId)
                dragRef.current = { startX: event.clientX, startWidth: treeWidth, moved: false }
                // Seed the pending width from the CURRENT one: a stray
                // pointermove after capture would otherwise schedule a 0 →
                // clamped to TREE_PANEL_MIN (a 160px snap on a bare click).
                pendingWidthRef.current = treeWidth
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current
                if (drag === null) return
                drag.moved = true
                pendingWidthRef.current = clampTreeWidth(
                  drag.startWidth + (drag.startX - event.clientX), treeWidthMax,
                )
                dragBatcher.schedule(() => { setDragWidth(pendingWidthRef.current) })
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current
                if (drag === null) return
                // Flush the last pending frame before committing, or a stray
                // frame would re-apply the drag width after the null below.
                dragBatcher.flushNow()
                dragRef.current = null
                setDragWidth(null)
                event.currentTarget.releasePointerCapture?.(event.pointerId)
                // A press that never moved is a CLICK, not a resize: without
                // this guard the recomputed width is committed even though the
                // user only wanted to focus the handle.
                if (!drag.moved) return
                // Recompute from the RELEASE pointer rather than trusting the
                // batched ref, and skip a no-op write.
                const finalWidth = clampTreeWidth(
                  drag.startWidth + (drag.startX - event.clientX), treeWidthMax,
                )
                if (finalWidth !== treeWidthOf(tab)) commitTreeWidth(finalWidth)
              }}
              onPointerCancel={abortTreeDrag}
              // A capture can be lost WITHOUT a pointerup (the pointer was
              // discarded, the window deactivated): drop the drag too, or the
              // next move keeps resizing from a stale seed.
              onLostPointerCapture={abortTreeDrag}
            />
            {treePanel(false)}
            {/* Only when `.editorMain` is not already showing the same text
                (a pathless tab): otherwise the notice would render twice as
                two sibling `role="alert"` blocks. */}
            {showEmpty && externalError !== null && (
              <div
                className={clsx(css.editorSearchHint, css.editorError)}
                role="alert"
                onClick={() => { setExternalError(null) }}
                title={t('close')}
              >
                {externalError}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The header's path input: shows the current file relative to the session
 * cwd (absolute when outside it). Enter resolves the typed path (relative
 * input joins onto the cwd — the same resolution `openSidebarFile` uses)
 * and opens it through the parent's mode-aware open (in-place switch or a
 * per-path dedupe tab); Escape/blur restores the current value. The parent
 * keys it by `path` so an in-place switch remounts and reseeds the draft.
 */
function EditorPathInput(props: { path: string; cwd: string | undefined; onOpen: (path: string) => void }) {
  const { path, cwd, onOpen } = props
  const display = path === '' ? '' : relativeTo(cwd ?? '', path)
  const [value, setValue] = useState(display)

  const commit = (): void => {
    const input = value.trim()
    if (input === '' || input === display) {
      setValue(display)
      return
    }
    onOpen(resolveSidebarPath(cwd, input))
    // Split mode: the open lands in a NEW/deduped editor tab — THIS tab's
    // path stays, so the input falls back to its own display value. (Merged
    // mode remounts this input on the new path; the reset is harmless.)
    setValue(display)
  }

  return (
    <input
      className={css.editorPathInput}
      value={value}
      placeholder={t('editorPathPlaceholder')}
      title={path}
      spellCheck={false}
      onChange={(event) => { setValue(event.target.value) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          setValue(display)
        }
      }}
      onBlur={() => { setValue(display) }}
    />
  )
}
