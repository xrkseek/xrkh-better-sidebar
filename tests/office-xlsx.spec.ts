/**
 * .xlsx parsing tests over synthetic workbook parts, through the
 * `parseXlsxFromZip` seam. The interesting cases are sparse columns, shared
 * vs. inline strings and the 200-row ceiling.
 *
 * `DOMParser` is not a Node global, so this spec runs in the jsdom
 * environment.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { parseXlsxFromZip, MAX_ROWS, MAX_COLS } from '../src/client/office/xlsx.ts'
import { fakeZip } from '../src/client/office/shared.ts'

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function rels(...entries: Array<[string, string]>): string {
  const body = entries
    .map(([id, target]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`)
    .join('')
  return `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

describe('parseXlsxFromZip', () => {
  const book = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels(['rId1', 'worksheets/sheet1.xml'], ['rId2', 'worksheets/sheet2.xml']),
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst ${NS}><si><t>Name</t></si><si><r><t>Rich</t></r><r><t> text</t></r></si><si><t>中文</t></si></sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="3"><c r="C3"><v>42</v></c><c r="D3" t="inlineStr"><is><t>inline</t></is></c></row>
      <row r="4"><c t="s"><v>2</v></c><c t="b"><v>1</v></c></row>
    </sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="s"><v>99</v></c></row></sheetData></worksheet>`,
  }

  it('lists sheets in workbook order', async () => {
    const { sheets } = await parseXlsxFromZip(fakeZip(book))
    expect(sheets.map((s) => s.name)).toEqual(['Data', 'Notes'])
  })

  it('resolves shared strings, including rich-text runs and UTF-8', async () => {
    const { sheets } = await parseXlsxFromZip(fakeZip(book))
    expect(sheets[0]?.rows[0]).toEqual(['Name', 'Rich text'])
    expect(sheets[0]?.rows[2]).toEqual(['中文', '1'])
  })

  it('pads sparse columns so cells stay aligned', async () => {
    const { sheets } = await parseXlsxFromZip(fakeZip(book))
    // Row 3 starts at C3: A and B must be empty placeholders.
    expect(sheets[0]?.rows[1]).toEqual(['', '', '42', 'inline'])
  })

  it('appends cells in order when the row has no r attributes', async () => {
    const { sheets } = await parseXlsxFromZip(fakeZip(book))
    // Row 4 has no cell references, so both cells land by document order with
    // no padding: the Chinese shared string, then the boolean's raw <v>.
    expect(sheets[0]?.rows.at(-1)).toEqual(['中文', '1'])
  })

  it('does not fail on a shared-string index past the end', async () => {
    const { sheets } = await parseXlsxFromZip(fakeZip(book))
    expect(sheets[1]?.rows[0]).toEqual([''])
  })

  it('works without a sharedStrings part', async () => {
    const zip = fakeZip({
      'xl/workbook.xml': book['xl/workbook.xml']!,
      'xl/_rels/workbook.xml.rels': rels(['rId1', 'worksheets/sheet1.xml'], ['rId2', 'worksheets/sheet2.xml']),
      'xl/worksheets/sheet1.xml': `<worksheet ${NS}><sheetData><row r="1"><c r="A1"><v>7</v></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet ${NS}><sheetData/></worksheet>`,
    })
    const { sheets } = await parseXlsxFromZip(zip)
    expect(sheets[0]?.rows).toEqual([['7']])
    expect(sheets[1]?.rows).toEqual([])
  })

  it('caps rows and columns at the documented ceilings', async () => {
    const rows: string[] = []
    for (let i = 1; i <= MAX_ROWS + 25; i++) {
      const cells: string[] = []
      for (let c = 0; c < MAX_COLS + 10; c++) cells.push(`<c r="${colName(c)}${i}" t="inlineStr"><is><t>r${i}c${c}</t></is></c>`)
      rows.push(`<row r="${i}">${cells.join('')}</row>`)
    }
    const zip = fakeZip({
      'xl/workbook.xml': book['xl/workbook.xml']!,
      'xl/_rels/workbook.xml.rels': rels(['rId1', 'worksheets/sheet1.xml'], ['rId2', 'worksheets/sheet2.xml']),
      'xl/worksheets/sheet1.xml': `<worksheet ${NS}><sheetData>${rows.join('')}</sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet ${NS}><sheetData/></worksheet>`,
    })
    const { sheets } = await parseXlsxFromZip(zip)
    expect(sheets[0]?.rows).toHaveLength(MAX_ROWS)
    expect(sheets[0]?.rows[0]).toHaveLength(MAX_COLS)
  })

  it('rejects a non-xlsx archive', async () => {
    await expect(parseXlsxFromZip(fakeZip({ 'word/document.xml': '<w:document/>' }))).rejects.toThrow(
      /xl\/workbook.xml is missing/,
    )
  })
})

/** 0 → A, 25 → Z, 26 → AA. */
function colName(index: number): string {
  let n = index
  let out = ''
  do {
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}
