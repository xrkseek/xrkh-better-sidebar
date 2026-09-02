# xrkh-better-sidebar

> **Audience**: XRK-Harness end users · integrators

Standard sidebar plugin for XRK-Harness (`xrkh`): explorer · editor · terminal · git · browser, isolated per session.  
Host serves `/sidebar/*` via the product adapter; this package ships the **client** half (and optional process manifest).

## Install

Requires `xrkh web` or `npx @xrkseek/harness-cli web`, Node ≥ 26.

```bash
xrkh plugin add xrkh-better-sidebar@latest
xrkh restart
```

From source (SSH):

```bash
git clone git@github.com:xrkseek/xrkh-better-sidebar.git
xrkh plugin add ./xrkh-better-sidebar
xrkh restart
```

Hard-refresh the browser after install (Ctrl+Shift+R).

## Contract

| Item | Notes |
|------|--------|
| npm | `xrkh-better-sidebar` |
| Repo | `xrkseek/xrkh-better-sidebar` |
| Manifest | `package.json` → `xrk.client` (client half) |
| Inject | `@xrkseek/client-*` (runtime, locale, slots, conversation, modules) |
| Host | Product adapter: `/sidebar/api` · `/sidebar/bundle` · PTY |

## Develop

```bash
pnpm install
pnpm bundle
```
