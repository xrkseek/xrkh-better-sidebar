/**
 * Post-sleep blank-terminal detector: host sized but xterm grid dead.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { terminalPaintBroken } from '../src/client/terminal-paint.ts'

function host(size: { width: number; height: number }): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: size.width })
  Object.defineProperty(el, 'clientHeight', { value: size.height })
  return el
}

describe('terminalPaintBroken', () => {
  it('is false while the host itself is still zero-sized', () => {
    expect(terminalPaintBroken(host({ width: 0, height: 200 }), {
      rows: 0, cols: 0, element: document.createElement('div'),
    })).toBe(false)
  })

  it('is false when the terminal has not opened yet', () => {
    expect(terminalPaintBroken(host({ width: 800, height: 200 }), {
      rows: 24, cols: 80,
    })).toBe(false)
  })

  it('is true when the host is sized but the grid collapsed', () => {
    expect(terminalPaintBroken(host({ width: 800, height: 200 }), {
      rows: 0, cols: 80, element: document.createElement('div'),
    })).toBe(true)
  })

  it('is true when .xterm-screen collapsed under a live grid', () => {
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    Object.defineProperty(screen, 'clientWidth', { value: 0 })
    Object.defineProperty(screen, 'clientHeight', { value: 0 })
    element.appendChild(screen)
    expect(terminalPaintBroken(host({ width: 800, height: 200 }), {
      rows: 24, cols: 80, element,
    })).toBe(true)
  })

  it('is false for a healthy open terminal', () => {
    const element = document.createElement('div')
    const screen = document.createElement('div')
    screen.className = 'xterm-screen'
    Object.defineProperty(screen, 'clientWidth', { value: 780 })
    Object.defineProperty(screen, 'clientHeight', { value: 180 })
    element.appendChild(screen)
    expect(terminalPaintBroken(host({ width: 800, height: 200 }), {
      rows: 24, cols: 80, element,
    })).toBe(false)
  })
})
