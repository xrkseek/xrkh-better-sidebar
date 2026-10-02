# xrkh-better-sidebar

> **Audience**: XRK-Harness end users · integrators

Standard sidebar plugin for XRK-Harness (`xrkh`): explorer · editor · terminal · git · browser, isolated per session.  
Host mounts `/sidebar/*` natively (`createSidebarPublicHandler`); this package ships the **client** half. The Cordis host half in `src/index.ts` is only for non-XRKH Cordis profiles — **do not** mount it on XRKH against the same `/sidebar/*` prefix.

## Install

Requires `xrkh web` or `npx @xrkseek/harness-cli web`, Node ≥ 26. Prefer Host **≥ 0.3.4**. Install from **npmjs**:

```bash
xrkh plugin add xrkh-better-sidebar@0.18.27
xrkh restart
```

Hard-refresh the browser after install (Ctrl+Shift+R).

Source path still works (not preferred): `git clone git@github.com:xrkseek/xrkh-better-sidebar.git` then `xrkh plugin add ./xrkh-better-sidebar`.

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
