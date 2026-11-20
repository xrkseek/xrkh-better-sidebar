# PDF 预览设计

> 日期: 2026-08-10 · 修订: 2026-11-20  
> 状态: 已实现（PDF.js canvas，多端）  
> 范围: `xrkh-better-sidebar` 文件预览

## 目标

为 `.pdf` 提供侧栏内预览，在 Desktop、手机 WebView、移动浏览器上都能看，而不是依赖浏览器内置 PDF 插件。

## 方案

- Client 按扩展名识别 `.pdf`，`fetchStrategy: mediaUrl`。
- `PdfView` 拉取字节；缩放以**适应舞台宽度**为 1.0，工具栏 ± 调整相对倍率。
- 实际绘制在懒加载 chunk `pdf`（`lib/client-pdf.js`）里，用 PDF.js 把页面画到 canvas；可见页 IntersectionObserver 懒渲染。
- Worker 同源：`/sidebar/bundle/pdf.worker.mjs` ← `lib/client-pdf.worker.mjs`（构建时从 `pdfjs-dist` 拷贝）。禁止 CDN。
- 工具条始终提供下载（手机短文案「下载」）；加载失败时舞台内也可下载。
- 窄屏（≤767）：更大触控、粘性工具条、safe-area 底边距。

## 与 office 插件的关系

- `.docx` / `.xlsx` / `.pptx` 由 `xrkh-better-sidebar-plugin-office` 注册。
- PDF **不在** office 插件里；手机 APK 源码也不需要为 PDF 预览改壳——问题出在 WebView 无原生 PDF iframe。

## 错误与限制

- 仍受 `mediaLimit` 限制。
- 未嵌入字体的旧版 CID 文档可能缺字（`useSystemFonts: true` 尽力而为）。
- 超大 PDF 靠可见区懒渲染；首次打开仍会整文件 fetch。

## 测试

- `.pdf` 扩展名识别。
- media type → `application/pdf`。
- `pdf-scale` fit / clamp。
- PdfView 下载走 `triggerBrowserDownload`。
- bundle 路由允许 `pdf` chunk 与 `pdf.worker.mjs`。
