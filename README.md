# xrk-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

基于 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）的 **XRK-Harness** 侧边栏工作台 fork。  
产品壳装 **client 半包**；Host 的 `/sidebar/*` 由 XRK 内置 `dsh-compat` 接线（无需在 Host 里 apply 上游 Cordis host 半包）。

## 安装

前置：已能跑 `xrkh web` / `npx @xrkseek/harness-cli web`，Node ≥ 26。

```bash
# 本地仓（本机已 clone）
xrkh plugin add /path/to/XRK-better-sidebar

# 或直接从 GitHub
xrkh plugin add github:xrkseek/XRK-better-sidebar

xrkh restart
```

npm 名 `xrk-better-sidebar` 发版后再用 `xrkh plugin add xrk-better-sidebar@latest`。

装完硬刷新浏览器。终端等 lazy chunk 由 `xrkh plugin add` 拷到 `plugins/web/`；Host `/sidebar/*` 走 XRK `dsh-compat`。

## 与上游差异

| 项 | 说明 |
|----|------|
| 包名 | `xrk-better-sidebar` |
| 清单 | `xrk.client`（兼保留 `dsh.client` 供 remap） |
| 注入 | `@xrkseek/client-*` |
| Host | 走 XRK `dsh-compat` 的 `/sidebar/api` · `/sidebar/bundle` · PTY 等 |

上游版权与许可证见 `LICENSE`；本 fork 仅为适配 XRK-Harness，不对 deepseek-ai / 上游提 PR。

## 开发

```bash
pnpm install
pnpm bundle
```
