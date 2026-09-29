# xrkh-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

XRK-Harness（`xrkh`）标准侧边栏插件：资源管理器 · 编辑器 · 终端 · Git · 浏览器等工作台，按会话隔离。  
Host 侧 `/sidebar/*` 由产品 Host 原生挂载（`createSidebarPublicHandler`）；本包提供 **client 半包**。`src/index.ts` 的 Cordis host 半包仅供非 XRKH 的 Cordis profile；**不要**在 XRKH 上再挂 host 抢同一前缀。

## 安装

前置：`xrkh web` 或 `npx @xrkseek/harness-cli web`，Node ≥ 26。建议 Host **≥ 0.3.4**。推荐从 **npmjs** 安装：

```bash
xrkh plugin add xrkh-better-sidebar@0.18.17
xrkh restart
```

装完硬刷新浏览器（Ctrl+Shift+R）。

源码路径仍可用（非推荐）：`git clone git@github.com:xrkseek/xrkh-better-sidebar.git` 后 `xrkh plugin add ./xrkh-better-sidebar`。

## 0.18.17

- 右侧面板顶距改为单一 `top`（`--dsh-title-bar-strip` → `--xrk-desktop-chrome-height`），去掉 `padding-top` 叠 chrome，修复 Desktop 页签上方空带

## 0.18.16

- Desktop 终端 SSE 改走 `xrk-app://stream`（与 Face mux/host 同池），不再占 `xrk-app://app` 长连接，避免开终端后 Face 掉线重试

## 0.18.15

- `title-bar-compat`：右侧面板 `top: 0` + `padding-top: strip`，不再叠加 `--xrk-desktop-chrome-height`（页签紧贴窗控下方，去掉空带）

## 0.18.14

- `title-bar-compat`：`--dsh-title-bar-strip` 已含 Desktop chrome，不再叠加 `--xrk-desktop-chrome-height`（侧栏轨图标不再比标题栏矮一截）
- toggle cluster：与会话标题行垂直对齐（`+14px` · `align-items: center`）
- 启动期 panel/FAB 隐藏：去掉插件侧重复 CSS，统一由内核 `data-xrk-booting` 负责

## 0.18.12

- 启动 splash（`data-xrk-booting`）：隐藏 panel-host / FAB，避免与 HARNESS 启动页叠层
- 会话头「Session log」：有 toggle cluster 时始终右缩，展开动画中不再被按钮挡住
- 动效：主题 token 冷启动回退 380ms / cubic-bezier，展开收起不再僵硬跳切
- Desktop chrome：右侧面板与 FAB 避开 `--xrk-desktop-chrome-height`

## 0.18.11

- 文件页：`openTab({ type: 'editor' })` 聚焦已种子的 files-home，不再并排冒出第二个「文件」标签
- `applyDedupe`：`dedupeKey` 返回 `undefined` 时仍按同 cohort 去重（与 pathless 编辑器一致）
- 底栏首次展开：若已有 UI 终端则跳过自动再开一个

## 0.18.10

- Desktop（`xrk-app://`）：终端改走 Host HTTP SSE + POST（`/sidebar/api/pty/*`），不再对无 listen 的私有 Host 死循环 WebSocket 重连
- 无边框窗口：右侧面板留 2px 边缘，便于 Electron 命中缩放

## 0.18.9

- `openTab`：当前会话下任意打开（含仅 `type` 的 Files / +菜单）都会展开已折叠侧栏，调用方无需再自行 `togglePanel`

## 0.18.3

- Client fiber 注入 `layout`（与 `ui-sidebar` 同序）：等 `ui-layout` 声明中心栏后再挂侧栏拦截，避免 Host ≥0.3.4 上 `conversation` slot 竞态
- `xrk.client.inject` 补 `@xrkseek/client-ui-layout`；文档 Host 基线改为 **≥ 0.3.4**

## 0.18.2

- Files 主页签随 locale；轻量媒体预览；默认打开侧栏

## 0.18.1

- `subagents.live`：兼容嵌套 `tool` 与旧版扁平 `tool` wire，避免子代理活动预览崩溃
- 与 Host 原生 `/sidebar/*`（嵌套 live 形状）对齐

## 0.18.0

- XRKH 原生：去掉第三方双轨（旧 manifest · better-locale · 旧安装脚本 · 市场目录）
- peer 仅 `@xrkseek/*` + React；工具类型走 `@xrkseek/xrk-tools` / `xrk-settings`
- 无 Side Chat；子代理走 Host Face + `subagents.live` / `jobs.*`
- 空 curated 插件目录（社区扩展不随包捆绑）

## 契约

| 项 | 说明 |
|----|------|
| npm | `xrkh-better-sidebar` |
| 仓库 | `xrkseek/xrkh-better-sidebar` |
| 形态 | **仅 client 半包**（`package.json` → `xrk.client` → `lib/client.js`） |
| 注入 | `client-runtime` · `client-locale` · `client-ui-slots` · `client-ui-layout` · `client-ui-conversation` · `client-modules` |
| Host | **产品 Host 拥有** `/sidebar/api` · `/sidebar/file|upload|html|bundle` · `/sidebar/ws/terminal` 等；本包不在 XRK 上挂 Cordis host 半包抢同一前缀 |
| 子代理 / 任务 | 走 Host Face + `/sidebar/api` 的 `subagents.live` · `jobs.*`（勿再实现 Side Chat） |

契约细则见 Harness 教科书 [community-plugins.md](https://github.com/xrkseek/XRK-harness/blob/main/docs/community-plugins.md)「侧栏插件契约」。

## 开发

```bash
pnpm install
pnpm bundle
```
