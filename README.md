# xrkh-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

XRK-Harness（`xrkh`）标准侧边栏插件：资源管理器 · 编辑器 · 终端 · Git · 浏览器等工作台，按会话隔离。  
Host 侧 `/sidebar/*` 由产品 Host 原生挂载（`createSidebarPublicHandler`）；本包提供 **client 半包**。

## 安装

前置：`xrkh web` 或 `npx @xrkseek/harness-cli web`，Node ≥ 26。建议 Host **≥ 0.2.3**。

```bash
xrkh plugin add xrkh-better-sidebar@0.18.1
xrkh restart
```

从源码（SSH）：

```bash
git clone git@github.com:xrkseek/xrkh-better-sidebar.git
xrkh plugin add ./xrkh-better-sidebar
xrkh restart
```

本机与 XRK-Harness 源码仓联调时，可将本仓放在 Harness 的 `extensions/xrkh-better-sidebar/`（主仓 gitignore，不进提交），然后：

```powershell
$env:XRK_PLUGINS_DIR = "./extensions"
pnpm xrk web --workspace .
```

装完硬刷新浏览器（Ctrl+Shift+R）。

## 0.18.1

- `subagents.live`：兼容嵌套 `tool` 与旧版扁平 `tool` wire，避免子代理活动预览崩溃
- 与 Host **0.2.3** 原生 `/sidebar/*`（嵌套 live 形状）对齐

## 0.18.0

- XRKH 原生：去掉 DSH 双轨（`dsh` manifest · better-locale · DSH 安装脚本 · 市场目录）
- peer 仅 `@xrkseek/*` + React；工具类型走 `@xrkseek/xrk-tools` / `xrk-settings`
- 无 Side Chat；子代理走 Host Face + `subagents.live` / `jobs.*`
- 空 curated 插件目录（社区扩展不随包捆绑）

## 契约

| 项 | 说明 |
|----|------|
| npm | `xrkh-better-sidebar` |
| 仓库 | `xrkseek/xrkh-better-sidebar` |
| 形态 | **仅 client 半包**（`package.json` → `xrk.client` → `lib/client.js`） |
| 注入 | `@xrkseek/client-runtime` · `client-locale` · `client-ui-slots` · `client-ui-conversation` · `client-modules` |
| Host | **产品 Host 拥有** `/sidebar/api` · `/sidebar/file|upload|html|bundle` · `/sidebar/ws/terminal` 等；本包不在 XRK 上挂 Cordis host 半包抢同一前缀 |
| 子代理 / 任务 | 走 Host Face + `/sidebar/api` 的 `subagents.live` · `jobs.*`（勿再实现 Side Chat） |

契约细则见 Harness 教科书 [community-plugins.md](https://github.com/xrkseek/XRK-harness/blob/main/docs/community-plugins.md)「侧栏插件契约」。

## 开发

```bash
pnpm install
pnpm bundle
```
