# xrkh-better-sidebar

> **Audience**: XRK-Harness end users · integrators

Standard sidebar plugin for XRK-Harness (`xrkh`): explorer · editor · terminal · git · browser, isolated per session.  
Host mounts `/sidebar/*` natively (`createSidebarPublicHandler`); this package ships the **client** half. The Cordis host half in `src/index.ts` is only for non-XRKH Cordis profiles — **do not** mount it on XRKH against the same `/sidebar/*` prefix.

## Install

Requires `xrkh web` or `npx @xrkseek/harness-cli web`, Node ≥ 26. Prefer Host **≥ 0.3.4**. Install from **npmjs**:

```bash
xrkh plugin add xrkh-better-sidebar@0.18.12
xrkh restart
```

Hard-refresh the browser after install (Ctrl+Shift+R).

Source path still works (not preferred): `git clone git@github.com:xrkseek/xrkh-better-sidebar.git` then `xrkh plugin add ./xrkh-better-sidebar`.

## 0.18.12

- Boot splash (`data-xrk-booting`): hide panel-host / FABs so they do not sit under the HARNESS gate
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
