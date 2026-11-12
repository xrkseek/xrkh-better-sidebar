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
    expect(source).toContain('viewport.width, layoutViewportHeight, effectiveKeyboardInset, measureCenter]')
  })

  it('measures center edges synchronously after the layout push (blank-bottom fix)', () => {
    // Prefer AppFrame's data-pane column (not the display:contents slot).
    expect(source).toContain('[data-pane="conversation"]')
    expect(source).toContain('findCenterColumn')
    // Sync measure in the same useLayoutEffect as writeGeometry — RO alone
    // is post-paint and left the first open frame on a zero-width strip.
    expect(source).toMatch(/writeGeometry\(width, bottomPush\)[\s\S]{0,400}?measureCenter\(\)/)
    // Refuse degenerate center boxes so we never stamp left+right ≈ viewport.
    expect(source).toContain('width >= 40')
    // Do not tear down the ResizeObserver when bottomOpen flips.
    expect(source).not.toMatch(/\}, \[measureCenter, state\?\.bottomOpen\]\)/)
  })

  it('adds the keyboard inset to the conversation push, not the panel height', () => {
    // Desktop gates the inset to 0 via effectiveKeyboardInset; the push still
    // adds the (narrow-only) inset beside height, never into panel height.
    expect(source.match(/height \+ effectiveKeyboardInset/g)).toHaveLength(2)
    expect(source).toContain('height: bottomPanelHeight')
    expect(source).not.toContain('height: bottomPanelHeight + keyboardInset')
    expect(source).not.toContain('height: bottomPanelHeight + effectiveKeyboardInset')
  })

  // The push must be written synchronously before paint: expand/collapse
  // flips the panel class at commit time, so a passive effect would start the
  // conversation's margin transition one frame late and paint the sliding
  // panel over the still-unsqueezed main content (double-image flicker).
  it('writes the layout push before paint (useLayoutEffect)', () => {
    // Bound the match to the hook name alone: the file also has passive
    // effects that merely CALL layoutPushSize (drag abort paths), which are
    // not the layout push itself.
    expect(source).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]{0,600}?writeGeometry\(width, bottomPush\)/)
    expect(source).not.toMatch(/(?<!Layout)useEffect\(\(\) => \{[\s\S]{0,600}?writeGeometry\(width, bottomPush\)/)
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
