/**
 * Narrow-viewport download / drawer contract in sidebar.module.css.
 * Keeps the phone tap targets and full-bleed drawer from regressing.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync('src/client/sidebar.module.css', 'utf8')

/** Body of the first `@media (max-width: 767px)` block (phone / NARROW_MAX). */
function narrowMediaBody(): string {
  const match = css.match(/@media\s*\(\s*max-width:\s*767px\s*\)\s*\{([\s\S]*)/)
  expect(match).not.toBeNull()
  // Brace-balance from the opening of that media query.
  let depth = 1
  let i = match![1].length > 0 ? 0 : -1
  const body = match![1]
  for (; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return body.slice(0, i)
    }
  }
  return body
}

describe('sidebar.module.css mobile download / drawer', () => {
  it('full-bleeds the drawer and pads safe-area insets on narrow screens', () => {
    const body = narrowMediaBody()
    expect(body).toMatch(/\.panel\s*\{/)
    expect(body).toMatch(/width:\s*100%\s*!important/)
    expect(body).toMatch(/safe-area-inset-left/)
    expect(body).toMatch(/safe-area-inset-right/)
  })

  it('gives the download link a ≥44px tap target on narrow screens', () => {
    const body = narrowMediaBody()
    expect(body).toMatch(/\.editorDownloadLink\s*\{/)
    expect(body).toMatch(/min-height:\s*44px/)
  })

  it('enlarges the drawer toggle hit target on narrow screens', () => {
    const body = narrowMediaBody()
    expect(body).toMatch(/\.toggleButton\s*\{/)
    expect(body).toMatch(/width:\s*44px/)
    expect(body).toMatch(/height:\s*44px/)
  })
})
