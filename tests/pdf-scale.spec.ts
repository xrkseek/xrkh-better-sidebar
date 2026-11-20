import { describe, expect, it } from 'vitest'
import {
  PDF_DEFAULT_ZOOM,
  clampPdfZoom,
  fitScale,
  nextPdfZoom,
} from '../src/client/pdf-scale.ts'

describe('pdf-scale', () => {
  it('clamps and steps zoom relative to fit-width', () => {
    expect(clampPdfZoom(Number.NaN)).toBe(PDF_DEFAULT_ZOOM)
    expect(clampPdfZoom(0.1)).toBe(0.5)
    expect(clampPdfZoom(9)).toBe(3)
    expect(nextPdfZoom(1, 1)).toBe(1.25)
    expect(nextPdfZoom(1, -1)).toBe(0.75)
  })

  it('fits page width into the stage (minus horizontal pad)', () => {
    // stage 816 → usable 800; page width 800 at scale 1 → fit scale 1 * zoom
    expect(fitScale(800, 816, 1)).toBeCloseTo(1, 5)
    expect(fitScale(800, 816, 2)).toBeCloseTo(2, 5)
    expect(fitScale(1600, 816, 1)).toBeCloseTo(0.5, 5)
    expect(fitScale(0, 400, 1)).toBe(1)
  })
})
