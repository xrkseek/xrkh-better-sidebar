# xrkh-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

XRK-Harness（`xrkh`）标准侧边栏插件：资源管理器 · 编辑器 · 终端 · Git · 浏览器等工作台，按会话隔离。  
Host 侧 `/sidebar/*` 由产品内置兼容器接线；本包提供 **client 半包**（及可选进程清单）。

## 安装

前置：`xrkh web` 或 `npx @xrkseek/harness-cli web`，Node ≥ 26。

```bash
xrkh plugin add xrkh-better-sidebar@latest
xrkh restart
```

从源码（SSH）：

```bash
git clone git@github.com:xrkseek/xrkh-better-sidebar.git
xrkh plugin add ./xrkh-better-sidebar
xrkh restart
```

装完硬刷新浏览器（Ctrl+Shift+R）。

## 契约

| 项 | 说明 |
|----|------|
| npm | `xrkh-better-sidebar` |
| 仓库 | `xrkseek/xrkh-better-sidebar` |
| 清单 | `package.json` → `xrk.client`（client 半包） |
| 注入 | `@xrkseek/client-runtime` · `client-locale` · `client-ui-slots` · `client-ui-conversation` · `client-modules` |
| Host | 产品 `dsh-compat` 提供 `/sidebar/api` · `/sidebar/bundle` · PTY 等 |

## 开发

```bash
pnpm install
pnpm bundle
```
