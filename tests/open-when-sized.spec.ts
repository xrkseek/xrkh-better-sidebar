/**
 * openWhenSized tests: deferred one-shot open for zero-size hosts
 * (xterm / WKWebView bottom-panel issue #25).
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MIN_OPEN_SIZE, OPEN_STABLE_FRAMES, openWhenSized } from '../src/client/open-when-sized.ts'

function makeScheduler(): {
  raf: (cb: FrameRequestCallback) => number
  caf: (id: number) => void
  tick: () => void
  pending: () => number
} {
  let nextId = 0
  const frames = new Map<number, FrameRequestCallback>()
  return {
    raf: (cb) => { const id = ++nextId; frames.set(id, cb); return id },
    caf: (id) => { frames.delete(id) },
    tick: () => {
      const cbs = [...frames.values()]
      frames.clear()
      for (const cb of cbs) cb(0)
    },
    pending: () => frames.size,
  }
}

function makeHost(width: number, height: number): {
  el: HTMLElement
  setSize: (w: number, h: number) => void
} {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const setSize = (w: number, h: number): void => {
    Object.defineProperty(el, 'clientWidth', { value: w, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: h, configurable: true })
  }
  setSize(width, height)
  return { el, setSize }
}

function tickUntilOpen(tick: () => void, count = OPEN_STABLE_FRAMES): void {
  for (let i = 0; i < count; i += 1) tick()
}

describe('openWhenSized', () => {
  it('opens after two sized ticks when the host already has a size, then stops', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(320, 200)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    expect(opened).toBe(0)
    expect(pending()).toBe(1)
    tick()
    expect(opened).toBe(1)
    expect(pending()).toBe(0)
    tick()
    expect(opened).toBe(1)
    cancel()
  })

  it('defers while the host is zero-sized and opens exactly once once sized', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    tick()
    tick()
    expect(opened).toBe(0)
    expect(pending()).toBe(1)
    host.setSize(320, 200)
    tickUntilOpen(tick)
    expect(opened).toBe(1)
    expect(pending()).toBe(0)
    tick()
    expect(opened).toBe(1)
    cancel()
  })

  it('defers while the host is only a mid-slide few-px tall', () => {
    const { raf, caf, tick } = makeScheduler()
    const host = makeHost(320, MIN_OPEN_SIZE - 1)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tickUntilOpen(tick)
    expect(opened).toBe(0)
    host.setSize(320, MIN_OPEN_SIZE)
    tickUntilOpen(tick)
    expect(opened).toBe(1)
    cancel()
  })

  it('resets the stable-frame count if size drops mid-wait', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    host.setSize(320, 200)
    tick()
    expect(opened).toBe(0)
    host.setSize(320, 0)
    tick()
    expect(opened).toBe(0)
    host.setSize(320, 200)
    tickUntilOpen(tick)
    expect(opened).toBe(1)
    expect(pending()).toBe(0)
    cancel()
  })

  it('opens when only one dimension was missing', () => {
    const { raf, caf, tick } = makeScheduler()
    const host = makeHost(320, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    expect(opened).toBe(0)
    host.setSize(320, 120)
    tickUntilOpen(tick)
    expect(opened).toBe(1)
    cancel()
  })

  it('cancels a pending open and leaves no scheduled frames', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    cancel()
    expect(pending()).toBe(0)
    host.setSize(320, 200)
    tickUntilOpen(tick)
    expect(opened).toBe(0)
    cancel()
  })

  it('stops polling when the host leaves the document', () => {
    const { raf, caf, tick, pending } = makeScheduler()
    const host = makeHost(0, 0)
    let opened = 0
    const cancel = openWhenSized(host.el, () => { opened += 1 }, raf, caf)
    tick()
    host.el.remove()
    tick()
    expect(opened).toBe(0)
    expect(pending()).toBe(0)
    host.setSize(320, 200)
    tickUntilOpen(tick)
    expect(opened).toBe(0)
    cancel()
  })

  it('does not swallow exceptions from open (the caller owns error handling)', () => {
    const { raf, caf, tick } = makeScheduler()
    const host = makeHost(320, 200)
    let calls = 0
    const cancel = openWhenSized(host.el, () => {
      calls += 1
      throw new Error('boom')
    }, raf, caf)
    tick()
    expect(() => tick()).toThrow('boom')
    expect(calls).toBe(1)
    cancel()
  })
})
