/**
 * SpreadsheetML (.xlsx) reader. Produces a plain string grid per sheet — no
 * type coercion, no formatting, no formulas evaluated.
 *
 * Known simplifications (deliberate ceilings):
 * - Every sheet is truncated to the first {@link MAX_ROWS} rows and
 *   {@link MAX_COLS} columns. A preview pane must stay interactive; the
 *   upgrade path is a windowed reader that re-runs the same parse against a
 *   byte range of the sheet part, not a bigger buffer.
 * - Numbers, booleans, errors and dates are returned as the raw `<v>` string.
 *   Excel's serial-date numbers are *not* converted, because that requires
 *   the workbook's date-1904 flag and a format table to be meaningful.
 * - Shared formulas, merged cells, column widths and styles are ignored;
 *   sparse columns are padded with empty strings so the grid stays aligned.
 */
import { OfficeZip } from './zip.ts'
import { attrPrefixed, attrsOf, childOf, childrenOf, dirOf, findAll, parseXml, relsMap, resolveRelTarget } from './xml.ts'
import { assertOfficeZip, readText, type ZipLike } from './shared.ts'

/** Rows parsed per sheet. Ceiling: preview interactivity, not fidelity. */
export const MAX_ROWS = 200
/** Columns parsed per sheet. */
export const MAX_COLS = 60

export interface XlsxSheet {
  name: string
  /**
   * Rows of raw cell strings. Whether the first row is a header cannot be
   * determined from the file alone, so it is left undefined for the caller.
   */
  rows: string[][]
}

export interface XlsxBook {
  sheets: XlsxSheet[]
}

/** Parse an .xlsx container. */
export async function parseXlsx(bytes: Uint8Array): Promise<XlsxBook> {
  return parseXlsxFromZip(await OfficeZip.open(bytes))
}

/** Parse an already-opened archive (see {@link parsePptxFromZip}). */
export async function parseXlsxFromZip(zip: ZipLike): Promise<XlsxBook> {
  assertOfficeZip(zip, 'xlsx')
  const workbookPart = 'xl/workbook.xml'
  if (!zip.has(workbookPart)) throw new Error('[office/xlsx] xl/workbook.xml is missing: not an .xlsx file')

  const relsPart = 'xl/_rels/workbook.xml.rels'
  if (!zip.has(relsPart)) throw new Error('[office/xlsx] xl/_rels/workbook.xml.rels is missing: unreadable workbook')
  const rels = relsMap(parseXml(await readText(zip, relsPart)))

  const shared = zip.has('xl/sharedStrings.xml')
    ? readSharedStrings(parseXml(await readText(zip, 'xl/sharedStrings.xml')))
    : []

  const workbook = parseXml(await readText(zip, workbookPart))
  const sheets: XlsxSheet[] = []
  for (const sheetEl of findAll(workbook, 'sheet')) {
    const attrs = attrsOf(sheetEl)
    // `<sheet name="Data" sheetId="1" r:id="rId1"/>` — the prefixed one is the rel.
    const rid = attrPrefixed(sheetEl, 'id')
    if (!rid) continue
    const rel = rels.get(rid)
    if (!rel) continue
    const part = resolveRelTarget(dirOf(workbookPart), rel.target)
    if (!zip.has(part)) continue
    const doc = parseXml(await readText(zip, part))
    sheets.push({ name: attrs.name ?? `Sheet${sheets.length + 1}`, rows: readSheetRows(doc, shared) })
  }
  return { sheets }
}

/** `<si>` entries, each one `<t>` or a run sequence, concatenated. */
function readSharedStrings(doc: Document): string[] {
  const out: string[] = []
  for (const si of findAll(doc, 'si')) {
    let text = ''
    for (const t of findAll(si, 't')) text += t.textContent ?? ''
    out.push(text)
  }
  return out
}

function readSheetRows(doc: Document, shared: string[]): string[][] {
  const rows: string[][] = []
  for (const rowEl of findAll(doc, 'row')) {
    if (rows.length >= MAX_ROWS) break
    const row: string[] = []
    let cursor = 0
    for (const cell of childrenOf(rowEl, 'c')) {
      const attrs = attrsOf(cell)
      const ref = attrs.r
      // A cell reference carries its column, so sparse cells must be padded to
      // stay aligned. Without `r` the document order is the only signal.
      // Malformed refs (including multi-thousand-column ones from corrupted
      // XML) clamp to the ceiling: a crafted `r="ZZZ999999"` must not
      // allocate a million placeholders.
      if (ref) {
        const col = columnIndex(ref)
        if (col !== undefined && col < MAX_COLS) {
          const target = Math.max(col, cursor)
          while (cursor < target) {
            row.push('')
            cursor += 1
          }
        }
      }
      row.push(cellValue(cell, attrs.t ?? '', shared))
      cursor += 1
      if (row.length >= MAX_COLS) break
    }
    rows.push(row)
  }
  return rows
}

function cellValue(cell: Element, type: string, shared: string[]): string {
  if (type === 'inlineStr') {
    const is = childOf(cell, 'is')
    if (!is) return ''
    let text = ''
    for (const t of findAll(is, 't')) text += t.textContent ?? ''
    return text
  }
  const v = childOf(cell, 'v')
  const raw = v?.textContent ?? ''
  if (type !== 's') return raw
  const index = Number.parseInt(raw, 10)
  // A dangling index would otherwise surface as "undefined" in the grid.
  return Number.isFinite(index) ? (shared[index] ?? '') : ''
}

/** `B7` → 1. Returns undefined for malformed references. */
function columnIndex(ref: string): number | undefined {
  let col = 0
  let seen = false
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i)
    if (code >= 65 && code <= 90) col = col * 26 + (code - 64)
    else if (code >= 97 && code <= 122) col = col * 26 + (code - 96)
    else break
    seen = true
  }
  if (!seen || col < 1) return undefined
  return col - 1
}
