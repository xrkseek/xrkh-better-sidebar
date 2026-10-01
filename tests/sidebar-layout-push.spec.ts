import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/client/Sidebar.tsx', 'utf8')

describe('Sidebar layout-push integration', () => {
  it('does not bypass the shared bottom-height cap during width drags', () => {
    expect(source).not.toContain('Math.min(state.bottomHeight, window.innerHeight)')
    expect(source.match(/pushedBottomHeight\(/g)).toHaveLength(9)
  })

  it('caps panel geometry against the viewport visible above the keyboard', () => {
    expect(source).toContain('setVisualViewportHeight(Math.max(0, Math.round(vv.height)))')
    // Desktop uses the layout viewport; narrow (touch) may use visualViewport.
    expect(source).toContain('visualViewportHeight ?? viewport.height')
    expect(source).toContain('layoutViewportHeight = narrow')
    expect(source.match(/viewportHeight: layoutViewportHeight/g)).toHaveLength(4)
    expect(source).toContain('viewport.width, layoutViewportHeight, effectiveKeyboardInset]')
  })

  it('adds the keyboard inset to the conversation push, not the panel height', () => {
    // Desktop gates the inset to 0 via effectiveKeyboardInset; the push still
    // adds the (narrow-only) inset beside height, never into panel height.
    expect(source.match(/height \+ effectiveKeyboardInset/g)).toHaveLength(2)
    expect(source).toContain('height: bottomPanelHeight')
    expect(source).not.toContain('height: bottomPanelHeight + keyboardInset')
    expect(source).not.toContain('height: bottomPanelHeight + effectiveKeyboardInset')
  })

  it('ignores desktop visualViewport keyboard inset after sleep/wake', () => {
    expect(source).toContain('effectiveKeyboardInset = narrow ? keyboardInset : 0')
    expect(source).toContain("document.addEventListener('visibilitychange', onWake)")
    expect(source).toContain('raw <= window.innerHeight * 0.4')
  })

  it('reapplies the visible-height cap to every vertical drag result', () => {
    expect(source).not.toMatch(/const height = clampHeight\(/)
    expect(source).not.toMatch(/height = clampHeight\(/)
    expect(source.match(/pushedBottomHeight\(true, clampHeight\(/g)).toHaveLength(6)
  })
})
