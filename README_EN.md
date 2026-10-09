# xrkh-better-sidebar

> **Audience**: XRK-Harness end users · integrators

Standard sidebar plugin for XRK-Harness (`xrkh`): explorer · editor · terminal · git · browser, isolated per session.  
Host mounts `/sidebar/*` natively (`createSidebarPublicHandler`); this package ships the **client** half. The Cordis host half in `src/index.ts` is only for non-XRKH Cordis profiles — **do not** mount it on XRKH against the same `/sidebar/*` prefix.

## Install

Requires `xrkh web` or `npx @xrkseek/harness-cli web`, Node ≥ 26. Prefer Host **≥ 0.3.4**. Install from **npmjs**:

```bash
xrkh plugin add xrkh-better-sidebar@0.20.0
xrkh restart
```

Hard-refresh the browser after install (Ctrl+Shift+R).

Source path still works (not preferred): `git clone git@github.com:xrkseek/xrkh-better-sidebar.git` then `xrkh plugin add ./xrkh-better-sidebar`.

## 0.20.0

### Office preview (.docx / .xlsx / .pptx)

Office files can now actually be opened instead of offering only a download button.

- **Zero new dependencies**: a new `src/client/office/` pure-logic module reads ZIP through
  the browser-native `DecompressionStream('deflate-raw')` (`zip.ts`) and XML through the
  native `DOMParser` (`xml.ts`), then parses OOXML for pptx / docx / xlsx. No third-party
  package, no LibreOffice, works offline.
- **The fidelity boundary, stated honestly**: this is a **structured preview**, not
  pixel-level reproduction —
  - pptx: real slide order from `presentation.xml`, text, images and speaker notes, arrow keys to page.
  - docx: heading levels, paragraphs, list items.
  - xlsx: multiple sheets, a table grid (capped at 200 rows × 60 columns per sheet, noted in code).

  High-fidelity slide/document rendering has no usable open-source option on the client: the
  closest reference, `vue-office` (5.7k stars), previews pptx through its own closed-source
  library (its README notes the source is sold separately) and uses `docx-preview` / `exceljs`
  for the rest. So we chose structured over canvas-level fidelity — promise less rather than
  pretend. Legacy `.doc/.xls/.ppt` binaries, ODF and `.rtf` have no client parser and keep the
  download fallback.
- **ZIP robustness**: ZIP64 (EOCD sentinel + locator + per-entry extra field), store and
  deflate methods, UTF-8 filenames; truncated / corrupt / encrypted / oversized entries throw
  with an explicit message instead of silently returning empty. Per-entry decompression is
  capped at 512MB (zip-bomb guard).
- Fixes a real bug: extraction went through `Blob.stream()` + `Response.arrayBuffer()`, which
  throws outright where `Blob.stream()` is missing (jsdom); it now uses a manual
  `ReadableStream` + reader loop, so it runs in browsers, jsdom and partial polyfills alike.

### Image preview zoom

- The image pane zooms around the cursor with **Ctrl/⌘ + wheel**, pans by drag, and toggles
  between fit and 2x on double click; the toolbar has fit / 100% / download and a live
  percentage, with `+` `-` `0` shortcuts.
- Fix: React 17+ registers `wheel` as a passive listener, so `preventDefault()` inside the
  synthetic `onWheel` was a no-op and Ctrl+wheel zoomed the whole app. A native
  `{ passive: false }` listener now suppresses page-level zoom.
- Zoom rides a CSS `transform` (no layout), and panning uses a 3px threshold so a click never
  drags the image away.

### File tree: visible feedback for "reveal in folder"

- Fixes "nothing happens": the context menu opens correctly (verified live), but reveal/open
  failures were caught into `console.error` with zero on-screen feedback, and the host side
  (`explorer.exe /select` on Windows) can fail silently too. Failures now surface as a
  dismissible notice on the tree instead of being swallowed.

### File tree: file operations (new / rename / delete)

- The host already offered `fs.mkdir` / `fs.delete`, but the client never called them — the
  context menu had no such entries, so files could be viewed but not managed. This release
  wires them up:
  - Directory context menu: new file / new folder; file context menu: rename / delete (delete
    is the dangerous one and asks for the name to confirm).
  - A cancelled or empty prompt is a no-op and never creates `dir/`; renaming to the same name
    is a no-op too.
  - Every failure (permission / out of fence / in use) goes through the same visible notice,
    never silent.
  - `fs.rename` is implemented as read bytes → write to the new path → delete the source,
    reusing the routes that already carry the workspace fence rather than adding a host verb
    for this one feature.

### Other

- New `IconOfficeOutline16` file-preview icon; the office viewer is split into `office`
  (in-app OOXML preview) and `office-legacy` (legacy download fallback) descriptors, each
  toggleable in settings.
- i18n: all 20 locale dictionaries gained this round's keys (image* / office* /
  openExternalFailed / newFolder / rename / delete, …).
- New/updated tests: 10 image-zoom cases, 8 office component cases, 10 file-operation cases,
  34 OOXML parsing cases (including real LibreOffice/pptx files, auto-skipped when the fixture
  is missing). No regressions against the existing suite baseline.

## 0.19.5

- Fix occasional blank bottom panel (only appeared after resizing the side workbench): unmeasured center column collapsed `left+right` to zero width; edges now use `--xrkh-center-*`, with a workbench + Overview-inset fallback until measured

## 0.19.4

- Republish: npm left 0.19.3 staged/unpublished (E409); same contents as 0.19.3

## 0.19.3

- Fix workbench toggle cluster lag while dragging Host **Overview**: track `details inset + workbench width` on the main-column seam; disable `right` easing during drag
- Remove unused `data-*-sidebar-collapsed` body stamps and the fixed viewport-corner path

## 0.19.2

- Republish: npm left 0.19.1 staged/unpublished (E409); same contents as 0.19.1

## 0.19.1

- Fix internal SIDEBAR_SERVICE_VERSION still reporting 0.18.32 (same features as 0.19.0; npm 0.19.0 tarball left the string stale)

## 0.19.0

- Improve coexistence with Host **Overview**: toggle cluster always uses `details inset + workbench width` and stays on the **main conversation column** seam (not on the Overview tab strip)
- Improve expand/collapse motion: shared duration/easing with the Host shell; session-header padding tracks Overview open/close
- Prefer **XRK-Harness ≥ 0.5.9** (LayoutInsets / Overview inset contract)

## 0.18.30

(Same fix as the unpublished 0.18.29 draft; npm left 0.18.29 staged/unpublished — use this version.)

- Fix turn-tail slot crash (`Cannot read properties of undefined (reading 'modified')`). **0.18.27 regression**: the three-lane refactor renamed the component prop from the host contract name `matched` to `lanes`; ui-slots chain always injects the selector result as `matched` (`ChainEntryProps`), and `@xrkseek/client-ui-deliverables` reads `matched` too
- Component: accept only `matched`; validate with `isFileLanes`; if missing/bad shape, re-derive lanes from owner fields the host also spreads onto the seat — never read `.modified` on undefined
- Coexist with the host Diff card: decline takeover when this closing `seq` already has a `workspace/changes` card (same bound as host `changesForClosing`); file opens still use `workspaces.openPath` interception
- Tests pin the full edge `select output → host prop name matched → component`
- File tree: active heartbeat 1.2s→4s, hidden 6s→12s; `nudgeTreeWatch` after save so the tree updates without silent churn

## 0.18.27

- Conversation tail file rows: render three lanes (modified / deleted / created); before, one flat "Produced" row swallowed edits and deletions
- Root cause: the `conversation.chat.turnTail` takeover kept only `path` and dropped the Turn data's `op`, flattening the host's existing lanes; deleted chips render struck through and inert (the file is gone)
- Sessions without `op` fall back to the `workspace/changes` line-count heuristic (0 added + deletes → deleted, 0 deleted + adds → created, else modified)

## 0.18.26

- Terminal: after OS sleep/wake, fit/refresh a blank xterm canvas; remount + reattach PTY if the grid stays dead; disable `allowTransparency` to reduce GPU-sleep blanking
- Desktop: ignore collapsed `visualViewport` as a keyboard inset (stops a blank layout-push strip and panels clipped by `overflow: clip`)
- Pref defaults match Host: `openByDefault` / `bottomPanelAutoTerminal` off
- Layout: dual-write `data-xrkh-sidebar-*` and `--xrkh-workbench-*`; storage key `xrkh-sidebar:v1` (migrates legacy `dsh-sidebar:v1`)

## 0.18.21

- `openTab({ type: 'editor' })` always lands on the side split tree (`splits`), never expands the bottom panel because `activePane` is a bottom leaf (chat file-open no longer opens a blank bottom pane / auto-terminal)

## 0.18.20

- Coalesce split-drag resize to one frame / skip no-ops so Windows ConPTY does not reprint the version MOTD
- Soft-reconnect longer on transient Host loss (5xx / empty 1006) instead of covering a painted MOTD with a fatal banner
- Do not share AbortController between SSE and input/resize POST so tearing down the stream cannot cancel in-flight control
- Carrier unchanged from 0.18.19: page-origin `xrk-app://app` (pool isolation belongs in Desktop/Face, not this plugin)

## 0.18.19

- Desktop terminal: SSE/POST back on page-origin `xrk-app://app` (drop the `xrk-app://stream` split that failed with `Failed to fetch`)

## 0.18.18

- Rail toggles: `+3` inside the open 34px tab strip; `+14` when collapsed (conversation title row) — no more bottom drift
- Desktop terminal: omit SSE `Accept`; optional stream→app fallback (removed in 0.18.19)

## 0.18.17

- Right panel top inset is a single `top` chain (`--dsh-title-bar-strip` → `--xrk-desktop-chrome-height`); drop stacked `padding-top` that left an empty band above Desktop tabs

## 0.18.14

- `title-bar-compat`: `--dsh-title-bar-strip` already includes Desktop chrome — do not add `--xrk-desktop-chrome-height` again (rail toggles no longer sit a band lower than the tab icons)
- Toggle cluster: vertical align with the conversation title row (`+14px` · `align-items: center`)
- Boot-time panel/FAB hide: drop duplicate plugin CSS; kernel `data-xrk-booting` owns it

## 0.18.12

- Boot splash (`data-xrk-booting`): hide panel-host / FABs so they do not stack on the HARNESS splash
- Session-log capsule: always right-pad while the toggle cluster is mounted (including mid-open animation)
- Motion: cold-theme fallbacks (380ms / cubic-bezier) so expand/collapse never jumps
- Desktop chrome: right panel + FABs clear `--xrk-desktop-chrome-height`

## 0.18.11

- Files tab: `openTab({ type: 'editor' })` focuses the seeded files-home instead of minting a twin Files tab
- `applyDedupe`: still dedupes when `dedupeKey` returns `undefined` (pathless editor cohort)
- Bottom-panel first expand: skip auto-terminal when a UI terminal already exists

## 0.18.10

- Desktop (`xrk-app://`): terminal rides Host HTTP SSE + POST (`/sidebar/api/pty/*`) instead of looping WebSocket reconnects against a non-listening private Host
- Frameless window: right panel leaves a 2px edge so Electron can hit-test resize

## 0.18.9

- `openTab`: any open on the active session (including type-only Files / +menu) expands a collapsed side card — callers no longer need a separate `togglePanel`

## 0.18.3

- Client fiber injects `layout` (same order as `ui-sidebar`): wait until `ui-layout` declares the center column before sidebar interception — avoids a `conversation` slot race on Host ≥ 0.3.4
- `xrk.client.inject` adds `@xrkseek/client-ui-layout`; docs Host baseline **≥ 0.3.4**

## 0.18.2

- Files home tab follows locale; light media viewers; open by default

## 0.18.1

- `subagents.live`: accept nested `tool` and legacy flat `tool` wire so subagent activity previews do not crash
- Align with Host native `/sidebar/*` (nested live shape)

## 0.18.0

- XRKH-native: drop third-party dual-track (legacy manifest · better-locale · legacy install scripts · marketplace catalogs)
- Peers are `@xrkseek/*` + React only; tools/settings types via `@xrkseek/xrk-tools` / `xrk-settings`
- No Side Chat; subagents use Host Face + `subagents.live` / `jobs.*`
- Empty curated plugin catalogs (community entries are not bundled)

## Contract

| Item | Notes |
|------|--------|
| npm | `xrkh-better-sidebar` |
| Repo | `xrkseek/xrkh-better-sidebar` |
| Manifest | `package.json` → `xrk.client` (client half) |
| Inject | `client-runtime` · `locale` · `ui-slots` · `ui-layout` · `ui-conversation` · `modules` |
| Host | Native Host owns `/sidebar/api` · `/sidebar/bundle` · PTY — do not remount Cordis host half on XRKH |

## Develop

```bash
pnpm install
pnpm bundle
```
