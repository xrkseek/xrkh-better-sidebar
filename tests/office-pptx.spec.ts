/**
 * .pptx parsing tests. These drive the real parsing logic through the
 * `parsePptxFromZip` seam over synthetic XML parts — building a binary
 * presentation in a fixture would test zlib, not the parser.
 *
 * `DOMParser` is not a Node global, so this spec runs in the jsdom
 * environment; see tests/browser-globals.ts for why it is not installed
 * globally instead.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parsePptxFromZip } from '../src/client/office/pptx.ts'
import { fakeZip } from '../src/client/office/shared.ts'

const NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function rels(...entries: Array<[string, string, string]>): string {
  const body = entries
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

function slide(paragraphs: string[], blips: Array<[string, string]> = []): string {
  const body = paragraphs
    .map((text) => {
      const runs = text
        .split('|')
        .map((run) => `<a:r><a:t>${run}</a:t></a:r>`)
        .join('')
      return `<a:p>${runs}</a:p>`
    })
    .join('')
  const pics = blips
    .map(([rid, name]) => `<p:pic><p:blipFill><a:blip r:embed="${rid}"/></p:blipFill><p:nvPicPr><p:cNvPr name="${name}"/></p:nvPicPr></p:pic>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld ${NS}><p:cSld><p:spTree>${body}${pics}</p:spTree></p:cSld></p:sld>`
}

describe('parsePptxFromZip', () => {
  const deck = {
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels(['rId1', 'slide', 'slides/slide1.xml'], ['rId2', 'slide', 'slides/slide2.xml']),
    'ppt/slides/slide1.xml': slide(['First slide', '   ', 'Second| line'], [['rId1', 'Logo']]),
    'ppt/slides/_rels/slide1.xml.rels': rels(
      ['rId1', 'image', '../media/image1.png'],
      ['rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'],
    ),
    'ppt/slides/slide2.xml': slide(['Reordered first'], [['rId3', 'Photo']]),
    'ppt/slides/_rels/slide2.xml.rels': rels(['rId3', 'image', '../media/image2.jpeg']),
    'ppt/notesSlides/notesSlide1.xml': slide(['Remember to', 'wave hello']),
    'ppt/media/image1.png': 'PNG-1',
    'ppt/media/image2.jpeg': 'JPEG-2',
  }

  it('orders slides by sldIdLst, not by file number', async () => {
    const { slides } = await parsePptxFromZip(fakeZip(deck))
    expect(slides.map((s) => s.index)).toEqual([1, 2])
    // sldIdLst lists rId2 (slide2.xml) first, so slide 1 of the *deck* is
    // slide2.xml. Sorting by file number would swap these two.
    expect(slides[0]?.texts[0]).toBe('Reordered first')
    expect(slides[1]?.texts[0]).toBe('First slide')
  })

  it('extracts paragraph text and joins runs within a paragraph', async () => {
    const { slides } = await parsePptxFromZip(fakeZip(deck))
    expect(slides[1]?.texts).toEqual(['First slide', 'Second line'])
  })

  it('resolves images through the slide rels with mime by extension', async () => {
    const { slides } = await parsePptxFromZip(fakeZip(deck))
    const images = slides[0]?.images ?? []
    expect(images).toHaveLength(1)
    // slide2.xml is deck slide 1 (per sldIdLst) and holds the jpeg.
    expect(images[0]?.name).toBe('image2.jpeg')
    expect(images[0]?.mime).toBe('image/jpeg')
    const png = slides[1]?.images[0]
    expect(png?.name).toBe('image1.png')
    expect(png?.mime).toBe('image/png')
    expect(new TextDecoder().decode(png!.bytes)).toBe('PNG-1')
  })

  it('reads speaker notes when the slide has a notes part', async () => {
    const { slides } = await parsePptxFromZip(fakeZip(deck))
    // The notes part hangs off slide1.xml, which is deck slide 2.
    expect(slides[1]?.notes).toBe('Remember to\nwave hello')
    expect(slides[0]?.notes).toBeUndefined()
  })

  it('handles a document without a presentation rels part', async () => {
    const { slides } = await parsePptxFromZip(fakeZip({ 'ppt/presentation.xml': deck['ppt/presentation.xml']! }))
    expect(slides).toEqual([])
  })

  it('rejects a non-pptx archive', async () => {
    await expect(parsePptxFromZip(fakeZip({ 'word/document.xml': '<w:document/>' }))).rejects.toThrow(
      /ppt\/presentation.xml is missing/,
    )
  })

  it('rejects malformed slide XML with a parse error', async () => {
    await expect(
      parsePptxFromZip(fakeZip({ ...deck, 'ppt/slides/slide1.xml': '<p:sld><unclosed></p:sld>' })),
    ).rejects.toThrow(/malformed XML part/)
  })

  it('matches unprefixed tags too', async () => {
    const zip = fakeZip({
      'ppt/presentation.xml': `<presentation xmlns:r="r"><sldIdLst><sldId r:id="rId1"/></sldIdLst></presentation>`,
      'ppt/_rels/presentation.xml.rels': rels(['rId1', 'slide', 'slides/slide1.xml']),
      'ppt/slides/slide1.xml': `<sld><p><r><t>No prefixes here</t></r></p></sld>`,
    })
    const { slides } = await parsePptxFromZip(zip)
    expect(slides[0]?.texts).toEqual(['No prefixes here'])
  })
})
