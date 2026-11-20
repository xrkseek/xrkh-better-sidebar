/** PDF zoom helpers — no pdf.js import, safe for the core client bundle. */

export const PDF_MIN_ZOOM = 0.5
export const PDF_MAX_ZOOM = 3
export const PDF_ZOOM_STEP = 0.25
/** 1 = fit-to-width of the preview stage (not a fixed CSS pixel scale). */
export const PDF_DEFAULT_ZOOM = 1

/** Horizontal padding around pages inside the stage (must match CSS). */
export const PDF_STAGE_PAD_X = 16

/** Clamp the user zoom multiplier (relative to fit-width). */
export function clampPdfZoom(value: number): number {
  if (!Number.isFinite(value)) return PDF_DEFAULT_ZOOM
  const stepped = Math.round(value / PDF_ZOOM_STEP) * PDF_ZOOM_STEP
  return Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, Number(stepped.toFixed(2))))
}

export function nextPdfZoom(current: number, direction: 1 | -1): number {
  return clampPdfZoom(current + direction * PDF_ZOOM_STEP)
}

/**
 * Convert fit-relative zoom into a pdf.js viewport scale.
 * `pageWidthAt1` is `page.getViewport({ scale: 1 }).width`.
 */
export function fitScale(pageWidthAt1: number, stageWidth: number, zoom: number): number {
  if (!(pageWidthAt1 > 0) || !(stageWidth > 0)) return zoom
  const usable = Math.max(32, stageWidth - PDF_STAGE_PAD_X)
  return (usable / pageWidthAt1) * zoom
}
