/**
 * Real-file verification for the OOXML parsers — the guard that keeps the
 * unit specs honest. The unit specs feed synthetic XML through `fakeZip`, so
 * a wrong assumption about the real OOXML layout would stay green; this spec
 * runs the same code paths over actual .pptx/.docx/.xlsx bytes.
 *
 * Fixtures are generated, not committed: LibreOffice converts a tiny
 * HTML/CSV source, and the pptx files come from the python-pptx test corpus.
 * When a fixture is missing the specs SKIP rather than fail — the office
 * preview must not break the build on a machine without LibreOffice. Set
 * `XRK_OFFICE_FIXTURES=<dir>` (containing sample.docx / sample.xlsx /
 * test.pptx / test_slides.pptx) to run them.
 */
// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocx } from '../src/client/office/docx.ts'
import { parsePptx } from '../src/client/office/pptx.ts'
import { parseXlsx } from '../src/client/office/xlsx.ts'

const DIR = process.env.XRK_OFFICE_FIXTURES ?? ''

function fixture(name: string): Uint8Array | null {
  if (DIR === '') return null
  const path = join(DIR, name)
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null
}

function bytes(name: string): Uint8Array {
  const found = fixture(name)
  if (found === null) throw new Error(`fixture missing: ${name} (set XRK_OFFICE_FIXTURES)`)
  return found
}

const has = (name: string): boolean => fixture(name) !== null

describe('office parsers against real Office files', () => {
  it('reads slide order, text, images and notes from a real pptx', async () => {
    if (!has('test.pptx')) return
    const deck = await parsePptx(bytes('test.pptx'))
    expect(deck.slides.length).toBeGreaterThan(0)
    // Every slide carries at least the deck's own title text.
    expect(deck.slides.every(slide => slide.texts.length > 0)).toBe(true)
    // Indices are 1-based and dense (a dropped rel would leave a hole).
    expect(deck.slides.map(s => s.index)).toEqual(deck.slides.map((_, i) => i + 1))
  })

  it('collects images from a real pptx that embeds them', async () => {
    if (!has('test_slides.pptx')) return
    const deck = await parsePptx(bytes('test_slides.pptx'))
    expect(deck.slides.length).toBeGreaterThan(0)
    expect(deck.slides.reduce((n, s) => n + s.images.length, 0)).toBeGreaterThan(0)
    expect(deck.slides.flatMap(s => s.images).every(img => img.bytes.byteLength > 0)).toBe(true)
  })

  it('reads paragraphs, heading levels and lists from a real docx', async () => {
    if (!has('sample.docx')) return
    const doc = await parseDocx(bytes('sample.docx'))
    const texts = doc.paragraphs.map(p => p.text)
    expect(texts.some(t => t.includes('Heading One'))).toBe(true)
    expect(doc.paragraphs.some(p => p.level === 1)).toBe(true)
    expect(doc.paragraphs.some(p => p.list !== undefined)).toBe(true)
    // Chinese survives the UTF-8 round-trip.
    expect(texts.some(t => t.includes('中文段落测试'))).toBe(true)
  })

  it('reads sheet names and cells from a real xlsx', async () => {
    if (!has('sample.xlsx')) return
    const book = await parseXlsx(bytes('sample.xlsx'))
    expect(book.sheets.length).toBeGreaterThan(0)
    const flat = book.sheets.flatMap(s => s.rows.map(r => r.join(' '))).join('\n')
    expect(flat).toContain('alpha')
    expect(flat).toContain('中文')
  })
})
