/**
 * layout.css must let the DSH conversation column shrink below its content
 * size. Without min-height:0 a long unbreakable URL grows the grid item
 * past the viewport and clips the composer.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/layout.css', 'utf8')

/** Rule body of the conversation-column selector block. */
function conversationRule(): string | undefined {
  return css.match(/#root \[data-dsh-frame\][\s\S]*?\{([\s\S]*?)\n\}/)?.[1]
}

describe('layout.css conversation column', () => {
  it('targets the AppFrame center column', () => {
    expect(css).toContain('[data-pane="conversation"]')
    expect(css).toContain('[data-slot="conversation"]')
  })

  it('allows the center column to shrink and wrap long tokens', () => {
    expect(css).toMatch(/min-height:\s*0/)
    expect(css).toMatch(/overflow-wrap:\s*anywhere/)
  })

  it('leaves overflow ownership to the host conversation descendants', () => {
    const body = conversationRule()
    expect(body).toBeDefined()
    expect(body).not.toMatch(/(?:^|[;\s])overflow\s*:/)
  })

  // The Host shell (ui-layout's AppFrame) yields the bottom panel through the
  // column's own padding-bottom, reading this plugin's --xrkh-workbench-height
  // as its fallback. A margin-bottom here charged the panel height TWICE: the
  // composer lifted an extra full panel height and a blank band opened between
  // it and the panel. The inset must stay single-counted.
  it('does not squeeze the column a second time with a margin', () => {
    const body = conversationRule()
    expect(body).toBeDefined()
    expect(body).not.toMatch(/margin-bottom/)
  })
})
