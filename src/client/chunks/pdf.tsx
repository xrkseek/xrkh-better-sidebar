/**
 * Lazy chunk entry: PDF.js canvas preview. Built as lib/client-pdf.js and
 * registered under the `pdf` global chunk slot — fetched only when a .pdf
 * tab opens (Android WebView has no native PDF iframe viewer).
 * Never import this module from the core bundle.
 */
export { PdfCanvasView } from '../PdfCanvasView.tsx'
