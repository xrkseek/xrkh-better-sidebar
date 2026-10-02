# xrkh-better-sidebar

> **读者**：XRK-Harness 终端用户 · 集成者

XRK-Harness（`xrkh`）标准侧边栏插件：资源管理器 · 编辑器 · 终端 · Git · 浏览器等工作台，按会话隔离。  
Host 侧 `/sidebar/*` 由产品 Host 原生挂载（`createSidebarPublicHandler`）；本包提供 **client 半包**。`src/index.ts` 的 Cordis host 半包仅供非 XRKH 的 Cordis profile；**不要**在 XRKH 上再挂 host 抢同一前缀。

## 安装

前置：`xrkh web` 或 `npx @xrkseek/harness-cli web`，Node ≥ 26。建议 Host **≥ 0.3.4**。推荐从 **npmjs** 安装：

```bash
xrkh plugin add xrkh-better-sidebar@0.19.2
xrkh restart
```

装完硬刷新浏览器（Ctrl+Shift+R）。

源码路径仍可用（非推荐）：`git clone git@github.com:xrkseek/xrkh-better-sidebar.git` 后 `xrkh plugin add ./xrkh-better-sidebar`。

## 0.19.2

- 重新发布：npm 上 0.19.1 卡在 staged 未公开（E409），内容与 0.19.1 相同

## 0.19.1

- 修复内部 SIDEBAR_SERVICE_VERSION 仍报 0.18.32 的疏漏（功能与 0.19.0 相同；npm 0.19.0 包内版本串未对齐）

## 0.19.0

- 完善右侧工作台与 Host **概况（Overview）** 共存：toggle 集群始终按 `details inset + workbench width` 停在**主对话列右缘**，不再叠在概况顶栏
- 完善展开/收起过渡：与 Host shell 共用 motion 时长与缓动；会话顶栏为 toggle 预留的 padding 跟随概况开合
- 建议搭配 **XRK-Harness ≥ 0.5.9**（LayoutInsets / 概况 inset 契约）

## 0.18.30

（相对未落地的 0.18.29：同批修复。npm 上 0.18.29 卡在 staged 未公开，以本号为准。）

- 修复对话尾部文件行整个 slot 渲染崩溃（`Cannot read properties of undefined (reading 'modified')`）。**0.18.27 回归**：三条 lane 改造时把组件 prop 从宿主契约名 `matched` 改成了 `lanes`；ui-slots chain 始终把 selector 返回值注入为 `matched`（`ChainEntryProps`），同槽的 `@xrkseek/client-ui-deliverables` 也按 `matched` 读。改名后组件拿到 `undefined`
- 组件侧：只认 `matched`；用 `isFileLanes` 校验形状；缺失/坏形状时从宿主一并展开的 owner 字段重算 lanes，不再直接读 `.modified`
- 与宿主 Diff 卡共存：本轮已有 `workspace/changes` 卡时（按 closing `seq`，对齐宿主 `changesForClosing`）主动放弃 takeover，避免盖住 ChangedFiles；文件打开仍走 `workspaces.openPath` 拦截
- 测例钉住「select 输出 → 宿主 prop 名 `matched` → 组件消费」整条边界（此前只断言注册元数据，改错名字也会绿灯）
- 文件树：活动页心跳 1.2s→4s、隐藏 6s→12s；保存后 `nudgeTreeWatch` 立即拉一轮，少无感狂刷

## 0.18.28

- 文件树增量自动刷新：AI 建/改/删文件后，已展开的树无感更新。Host 侧新增按 `sessionId` + 目录管理的非递归 `fs.watch` registry（per-subscriber 引用计数、单调 sequence + 有界 replay、watcher 失效自动重开），配 `fs.watch.sync`（只回「哪几层变了」+ 游标）与 `fs.tree.batch`（批量 listing + 可选 `statPaths`）
- 客户端共享 watch broker：同一会话/cwd 的文件树与多个编辑器合并成一份订阅与一轮请求；活动页 ~1.2s、隐藏页 ~6s、失败退避 4s；健康时每 20 轮全量 sweep，有不可监听目录时 5 轮
- 刷新语义：只替换真正变化的已加载层（`levelSignature` 比对，相同则跳过 setState），不显示 loading、不调 `refreshTick`、不物化未展开目录、不动展开/搜索/滚动/拖拽状态
- 打开中文件的外部修改：`mtimeMs` 贯穿 `fs.read` → 渲染 → baseline；内容 clean 时静默重载，dirty 时绝不覆盖草稿，显示「文件已被外部修改，草稿未覆盖」提示条与刷新按钮；无 baseline 的 viewer 不循环重载
- 修复：`fs.tree.batch` 的 listing/stat 回显改为调用方传入的原始路径（此前回显 Host 解析后的 realpath——symlink workspace root、Windows 大小写或分隔符规范化下，客户端的层级 key 与 stat 行会永久匹配不上，树看起来「不再刷新」）
- 点击卡顿（静态定位）：`TreePanel` 加 memo 渲染边界、树回调 `useCallback` 稳定化、`FileTree` 单次 `setData` 批量提交（原为逐层提交）、CodeMirror 语言包按语言 key 缓存
- 测试环境：`vitest.config.ts` 加 `resolve.dedupe: ['react', 'react-dom']`（插件与宿主根各装一份 React，经 `client-ui-primitives` 跨界渲染时全部 UI 测试死于 `Invalid hook call`）
- i18n：19 个语言字典补齐 7 个漏键（`fileChangedOnDisk` / `laneModified` / `laneDeleted` / 四个 `viewer*`）
- 冗余清理：删除无消费者的 `onDegraded` 钩子、`mergeLevel` 导出与重复的 `messageOf`；`locales.spec.ts` 里测 0.18.0 已删除的 `attachBetterLocale` 覆盖层协议的残留一并清掉

## 0.18.27

- 对话尾部文件行：按「本次改动 / 本次删除 / 本次产出」三条 lane 渲染（此前只有一条「本次产出」，改动与删除被丢弃）
- 修复根因：接管 `conversation.chat.turnTail` 时只挑 `path`、丢掉 Turn 数据里的 `op`，等于把内核已有的 lane 压平；删除的 chip 置灰划线、不可点（文件已不存在）
- 无 `op` 的旧会话回落：`workspace/changes` 行数启发式（0 增有删 → 删除，0 删有增 → 产出，其余 → 改动）

## 0.18.26

- 终端：挂起唤醒后画布空白时 fit/refresh；网格仍死则 remount 并重挂 PTY；关闭 `allowTransparency` 减轻 GPU 挂起后整页空白
- Desktop：忽略塌缩的 `visualViewport` 当键盘 inset（避免布局推挤空白条与 `overflow: clip` 裁切面板）
- 偏好默认与 Host 对齐：`openByDefault` / `bottomPanelAutoTerminal` 默认关
- 布局：双写 `data-xrkh-sidebar-*` 与 `--xrkh-workbench-*`；存储键 `xrkh-sidebar:v1`（迁移旧 `dsh-sidebar:v1`）

## 0.18.21

- `openTab({ type: 'editor' })` 固定落到侧栏分栏（`splits`），不因 `activePane` 在底栏而撑开底部面板（避免聊天开文件先出空白底栏 / 自动终端）

## 0.18.20

- 拖拽分栏时合并 resize（一帧一次、跳过无变化），避免 Windows ConPTY 反复重打「版本」MOTD
- Host 短暂不可用（5xx / 空 1006）时软重连更久，不把已绘出的 MOTD 盖上致命横幅
- SSE 与 input/resize POST 不再共用 AbortController，关流时不误取消在途控制请求
- 载波仍同 0.18.19：页面同源 `xrk-app://app`（池隔离归 Desktop/Face，不在本插件翻）

## 0.18.19

- Desktop 终端：SSE/POST 回到页面同源 `xrk-app://app`（去掉会 `Failed to fetch` 的 `xrk-app://stream` 分裂与回退冗余）

## 0.18.18

- 轨图标：面板展开时贴齐 34px 页签条（`+3`），收起时仍对齐会话标题行（`+14`），不再下偏
- Desktop 终端：SSE 不再带 `Accept`；`stream` 主机打不开时曾回退 `app`（已由 0.18.19 去掉回退）

## 0.18.17

- 右侧面板顶距改为单一 `top`（`--dsh-title-bar-strip` → `--xrk-desktop-chrome-height`），去掉 `padding-top` 叠 chrome，修复 Desktop 页签上方空带

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
