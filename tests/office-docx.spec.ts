/**
 * .docx parsing tests over synthetic `word/document.xml`, through the
 * `parseDocxFromZip` seam.
 *
 * `DOMParser` is not a Node global, so this spec runs in the jsdom
 * environment.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseDocxFromZip } from '../src/client/office/docx.ts'
import { fakeZip } from '../src/client/office/shared.ts'

function paragraph(inner: string): string {
  return `<w:p>${inner}</w:p>`
}

describe('parseDocxFromZip', () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
${paragraph('<w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Chapter title</w:t></w:r>')}
${paragraph('<w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r>')}
${paragraph('')}
${paragraph('<w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r>')}
${paragraph('<w:pPr><w:pStyle w:val="berschrift1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>List item</w:t></w:r>')}
${paragraph('<w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>Body text</w:t></w:r>')}
</w:body></w:document>`

  it('extracts paragraphs in order and skips empty ones', async () => {
    const { paragraphs } = await parseDocxFromZip(fakeZip({ 'word/document.xml': documentXml }))
    expect(paragraphs.map((p) => p.text)).toEqual([
      'Chapter title',
      'Hello world',
      'a\tb\nc',
      'List item',
      'Body text',
    ])
  })

  it('maps heading styles to levels and flags list paragraphs', async () => {
    const { paragraphs } = await parseDocxFromZip(fakeZip({ 'word/document.xml': documentXml }))
    expect(paragraphs[0]?.level).toBe(2)
    expect(paragraphs[0]?.list).toBeUndefined()
    expect(paragraphs[3]?.level).toBe(1)
    expect(paragraphs[3]?.list).toBe('bullet')
    expect(paragraphs[4]?.level).toBeUndefined()
    expect(paragraphs[4]?.list).toBeUndefined()
  })

  it('handles a document whose body is a table of runs', async () => {
    const zip = fakeZip({
      'word/document.xml': `<w:document xmlns:w="w"><w:body>
        <w:tbl><w:tr>${paragraph('<w:r><w:t>cell</w:t></w:r>')}</w:tr></w:tbl>
      </w:body></w:document>`,
    })
    const { paragraphs } = await parseDocxFromZip(zip)
    expect(paragraphs).toEqual([{ text: 'cell' }])
  })

  it('rejects a non-docx archive', async () => {
    await expect(parseDocxFromZip(fakeZip({ 'ppt/presentation.xml': '<p:presentation/>' }))).rejects.toThrow(
      /word\/document.xml is missing/,
    )
  })

  it('rejects malformed XML', async () => {
    await expect(parseDocxFromZip(fakeZip({ 'word/document.xml': '<w:document><oops>' }))).rejects.toThrow(
      /malformed XML part/,
    )
  })
})