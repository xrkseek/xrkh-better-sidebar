# xrkh-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

基于 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）的 **XRK-Harness / xrkh** 侧边栏工作台。  
源码仓独立：[`xrkseek/XRKH-better-sidebar`](https://github.com/xrkseek/XRKH-better-sidebar)。  
产品壳装 **client 半包**；Host `/sidebar/*` 由 XRK 内置 `dsh-compat` 接线。

## 安装

前置：`xrkh web` 或 `npx @xrkseek/harness-cli web`，Node ≥ 26。

```bash
xrkh plugin add xrkh-better-sidebar@latest
xrkh restart
```

源码（SSH）：

```bash
git clone git@github.com:xrkseek/XRKH-better-sidebar.git
xrkh plugin add ./XRKH-better-sidebar
xrkh restart
```

装完硬刷新浏览器（Ctrl+Shift+R）。

## 与上游差异

| 项 | 说明 |
|----|------|
| npm / 包名 | `xrkh-better-sidebar` |
| 仓库 | `xrkseek/XRKH-better-sidebar` |
| 清单 | `xrk.client`（兼 `dsh.client` remap） |
| 注入 | `@xrkseek/client-*` |
| Host | XRK `dsh-compat` `/sidebar/*` |

上游版权见 `LICENSE`。

## 开发

```bash
pnpm install
pnpm bundle
```
