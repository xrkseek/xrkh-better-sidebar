# AGENTS.md — xrkh-better-sidebar

> **读者**：本插件仓库维护者 · Coding Agent（笔记，不是用户手册）。

独立 npm 包，**XRK-Harness 原生**侧栏插件。本机工作树可放在 Harness 的 `extensions/xrkh-better-sidebar/`（主仓 ignore，不进提交 / 不进 pnpm workspace），用 `XRK_PLUGINS_DIR=./extensions` 联调；远程仍是本仓 `origin`。

## 硬约束

- 身份与 `package.json` `name`、`src/identity.ts`、`SIDEBAR_PREFS_NS` 保持 `xrkh-better-sidebar`
- peer 只声明 `@xrkseek/*` + React；禁止再引入 DSH / `@deepseek-ai/*` 运行时依赖
- 无 Side Chat：子代理走 Host Face + `/sidebar/api` 的 `subagents.live` · `jobs.*`
- 市场约束：`dependencies` / `peerDependencies` 不得出现裸名 `cordis`；无 install lifecycle scripts

## 联调

```powershell
# 在 Harness 根
$env:XRK_PLUGINS_DIR = "./extensions"
pnpm xrk web --workspace .
```

本插件目录内：`pnpm install` → `pnpm build` → `pnpm test`。勿把本树改动提交进 XRK-harness。

## 常用命令

```bash
pnpm build && pnpm test
pnpm typecheck
```
