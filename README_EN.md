# xrkh-better-sidebar

> **Audience**: XRK-Harness end users · integrators

Standard sidebar plugin for XRK-Harness (`xrkh`): explorer · editor · terminal · git · browser, isolated per session.  
Host mounts `/sidebar/*` natively (`createSidebarPublicHandler`); this package ships the **client** half.

## Install

Requires `xrkh web` or `npx @xrkseek/harness-cli web`, Node ≥ 26. Prefer Host **≥ 0.2.3**.

```bash
xrkh plugin add xrkh-better-sidebar@0.18.1
xrkh restart
```

From source (SSH):

```bash
git clone git@github.com:xrkseek/xrkh-better-sidebar.git
xrkh plugin add ./xrkh-better-sidebar
xrkh restart
```

For local monorepo smoke tests, place this tree under Harness `extensions/xrkh-better-sidebar/` (gitignored by the main repo), then:

```powershell
$env:XRK_PLUGINS_DIR = "./extensions"
pnpm xrk web --workspace .
```

Hard-refresh the browser after install (Ctrl+Shift+R).

## 0.18.1

- `subagents.live`: accept nested `tool` and legacy flat `tool` wire so subagent activity previews do not crash
- Align with Host **0.2.3** native `/sidebar/*` (nested live shape)

## 0.18.0

- XRKH-native: drop DSH dual-track (`dsh` manifest · better-locale · DSH install scripts · marketplace catalogs)
- Peers are `@xrkseek/*` + React only; tools/settings types via `@xrkseek/xrk-tools` / `xrk-settings`
- No Side Chat; subagents use Host Face + `subagents.live` / `jobs.*`
- Empty curated plugin catalogs (community entries are not bundled)

## Contract

| Item | Notes |
|------|--------|
| npm | `xrkh-better-sidebar` |
| Repo | `xrkseek/xrkh-better-sidebar` |
| Manifest | `package.json` → `xrk.client` (client half) |
| Inject | `@xrkseek/client-*` (runtime, locale, slots, conversation, modules) |
| Host | Native Host: `/sidebar/api` · `/sidebar/bundle` · PTY |

## Develop

```bash
pnpm install
pnpm bundle
```
