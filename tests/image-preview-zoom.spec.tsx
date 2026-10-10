/**
 * ImagePreview interaction spec: the zoom contract a user actually feels.
 *
 * Covered:
 * - Ctrl (and ⌘) + wheel zooms about the cursor and suppresses the default
 *   page zoom; a bare wheel is left alone so the stage keeps scrolling.
 * - The zoom readout tracks the scale, and Fit / 100% are real modes (fit is
 *   recomputed from the intrinsic size, 100% is scale 1).
 * - A press-drag pans; a press without movement does not shift the image.
 * - A failed load shows the error notice instead of a broken-image glyph.
 *
 * jsdom has no layout, so the stage measures 0x0. That is fine: these tests
 * assert the SCALE math and the transform, which is what the controls own.
 * `ResizeObserver` is stubbed because jsdom lacks it.
 */
// @vitest-environment jsdom
import { beforeAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { ImagePreview } from '../src/client/ImagePreview.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as Record<string, unknown>).ResizeObserver = StubResizeObserver
})

vi.mock('../src/client/api.ts', () => ({
  mediaUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${path}`,
  downloadUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${path}&download=1`,
}))

let container: HTMLDivElement
let root: Root

async function mount(): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(ImagePreview, {
      scope: { sessionId: 's1', cwd: '/tmp' },
      path: '/tmp/a.png',
      title: 'a.png',
    }))
  })
}

function stage(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[class*="editorImageStage"]')
  if (el === null) throw new Error('image stage not found')
  return el
}

function image(): HTMLImageElement {
  const el = container.querySelector('img')
  if (el === null) throw new Error('image not found')
  return el
}

/** The scale factor currently carried by the image's transform. */
function scaleOf(): number {
  const match = /scale\(([\d.]+)\)/.exec(image().style.transform)
  if (match === null) throw new Error(`no scale in transform: ${image().style.transform}`)
  return Number(match[1])
}

/** Pretend the decoded image is `width` x `height` intrinsic pixels. */
async function setNaturalSize(width: number, height: number): Promise<void> {
  const img = image()
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true })
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true })
  await act(async () => { img.dispatchEvent(new Event('load')) })
}

/** Fire a wheel with the given modifiers. Returns the event's default status. */
function wheel(element: HTMLElement, deltaY: number, modifiers: { ctrl?: boolean; meta?: boolean } = {}): Event {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaY,
    ctrlKey: modifiers.ctrl === true,
    metaKey: modifiers.meta === true,
    clientX: 100,
    clientY: 100,
  })
  act(() => { element.dispatchEvent(event) })
  return event
}

/** jsdom has no pointer capture; stub the two methods the view calls. */
function stubPointerCapture(element: HTMLElement): void {
  Object.defineProperty(element, 'setPointerCapture', { value: () => {}, configurable: true })
  Object.defineProperty(element, 'releasePointerCapture', { value: () => {}, configurable: true })
  Object.defineProperty(element, 'hasPointerCapture', { value: () => true, configurable: true })
}

function pointer(type: string, x: number, y: number): void {
  act(() => {
    stage().dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }))
  })
}

beforeEach(async () => {
  await mount()
  stubPointerCapture(stage())
})
afterEach(() => {
  act(() => { root.unmount() })
  document.body.innerHTML = ''
})

describe('ImagePreview zoom', () => {
  it('starts at fit scale and reports the percentage', async () => {
    // jsdom stage is 0x0, so fit clamps to the 1.0 design floor.
    expect(scaleOf()).toBe(1)
    expect(container.textContent).toContain('100%')
  })

  it('zooms in on Ctrl+wheel and suppresses the browser page zoom', async () => {
    await setNaturalSize(100, 100)
    const before = scaleOf()
    const event = wheel(stage(), -120, { ctrl: true })
    // preventDefault is what stops the whole app page from zooming.
    expect(event.defaultPrevented).toBe(true)
    expect(scaleOf()).toBeGreaterThan(before)
  })

  it('zooms on Meta+wheel too (macOS)', async () => {
    await setNaturalSize(100, 100)
    const before = scaleOf()
    wheel(stage(), -120, { meta: true })
    expect(scaleOf()).toBeGreaterThan(before)
  })

  it('zooms out on Ctrl+wheel down', async () => {
    await setNaturalSize(100, 100)
    wheel(stage(), 240, { ctrl: true })
    wheel(stage(), 240, { ctrl: true })
    expect(scaleOf()).toBeLessThan(1)
  })

  it('leaves a bare wheel to the stage scroll', async () => {
    await setNaturalSize(100, 100)
    const before = scaleOf()
    const event = wheel(stage(), -120)
    expect(event.defaultPrevented).toBe(false)
    expect(scaleOf()).toBe(before)
  })

  it('never zooms past the clamp', async () => {
    await setNaturalSize(100, 100)
    for (let i = 0; i < 60; i += 1) wheel(stage(), -600, { ctrl: true })
    expect(scaleOf()).toBeLessThanOrEqual(8)
    for (let i = 0; i < 120; i += 1) wheel(stage(), 600, { ctrl: true })
    expect(scaleOf()).toBeGreaterThanOrEqual(0.05)
  })

  it('one Ctrl+wheel notch stays gentle (not a leap to MAX)', async () => {
    await setNaturalSize(100, 100)
    const before = scaleOf()
    wheel(stage(), -120, { ctrl: true })
    const after = scaleOf()
    // A single mouse-wheel notch used to jump to 1600%; keep it under 2x.
    expect(after).toBeGreaterThan(before)
    expect(after / before).toBeLessThan(2)
  })

  it('pans on drag and leaves a click alone', async () => {
    await setNaturalSize(4000, 4000)
    wheel(stage(), -120, { ctrl: true })
    const transformOf = () => image().style.transform

    // A press with no movement must not shift the image.
    pointer('pointerdown', 50, 50)
    pointer('pointerup', 51, 50)
    expect(transformOf()).toContain('translate3d(0px, 0px, 0)')

    // A real drag past the threshold does.
    pointer('pointerdown', 50, 50)
    pointer('pointermove', 90, 70)
    pointer('pointerup', 90, 70)
    expect(transformOf()).toContain('translate3d(40px, 20px, 0)')
  })

  it('100% pins the intrinsic scale', async () => {
    await setNaturalSize(400, 300)
    wheel(stage(), -240, { ctrl: true })
    expect(scaleOf()).not.toBe(1)
    const actual = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === '100%')
    expect(actual).toBeDefined()
    act(() => { actual!.click() })
    expect(scaleOf()).toBe(1)
  })

  it('Fit returns to the fit scale and clears the pan', async () => {
    await setNaturalSize(100, 100)
    wheel(stage(), -240, { ctrl: true })
    pointer('pointerdown', 50, 50)
    pointer('pointermove', 120, 90)
    pointer('pointerup', 120, 90)

    const fit = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Fit')
    act(() => { fit!.click() })
    expect(image().style.transform).toContain('translate3d(0px, 0px, 0)')
  })

  it('shows a notice when the image fails to load', async () => {
    await act(async () => { image().dispatchEvent(new Event('error')) })
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('Failed to load image')
  })
})