/**
 * WordprocessingML (.docx) paragraph extractor.
 *
 * Known simplifications:
 * - Text + heading level + list marker only. Runs, hyperlinks, tables, images,
 *   footnotes, headers/footers and comments are not surfaced.
 * - Ordered vs. bullet is decided from the paragraph's own `w:numPr` alone.
 *   The real distinction (decimal vs. bullet) lives in the numbering
 *   definition part (`word/numbering.xml`), which would mean cross-referencing
 *   `w:numId` → `w:abstractNumId` → level format. That is a deliberate ceiling:
 *   add it here if a preview ever needs accurate markers.
 * - Heading level comes from `w:pStyle` (`Heading1`..`Heading6` or the localized
 *   `berschrift1`..`berschrift6`). Any other style is body text.
 */
import { OfficeZip } from './zip.ts'
import { attr, childOf, findAll, parseXml } from './xml.ts'
import { assertOfficeZip, readText, type ZipLike } from './shared.ts'

export interface DocxParagraph {
  /** Plain text of the paragraph. */
  text: string
  /** 1..6 for Heading1..Heading6, undefined for body text. */
  level?: number
  /** Set when the paragraph carries a numbering property. */
  list?: 'bullet' | 'ordered'
}

export interface DocxDocument {
  paragraphs: DocxParagraph[]
}

/** Parse a .docx container. */
export async function parseDocx(bytes: Uint8Array): Promise<DocxDocument> {
  return parseDocxFromZip(await OfficeZip.open(bytes))
}

/** Parse an already-opened archive (see {@link parsePptxFromZip}). */
export async function parseDocxFromZip(zip: ZipLike): Promise<DocxDocument> {
  assertOfficeZip(zip, 'docx')
  const part = 'word/document.xml'
  if (!zip.has(part)) throw new Error('[office/docx] word/document.xml is missing: not a .docx file')

  const doc = parseXml(await readText(zip, part))
  const paragraphs: DocxParagraph[] = []
  for (const p of findAll(doc, 'p')) {
    const text = paragraphText(p)
    if (text.length === 0) continue
    const entry: DocxParagraph = { text }
    const level = headingLevel(p)
    if (level !== undefined) entry.level = level
    if (hasNumPr(p)) entry.list = 'bullet'
    paragraphs.push(entry)
  }
  return { paragraphs }
}

/**
 * Body text of one `<w:p>`, honouring tabs and line breaks. Walks the subtree
 * in document order because `<w:tab/>` and `<w:br/>` carry no text content of
 * their own — a `getElementsByTagName('w:t')` pass would silently drop them.
 */
function paragraphText(p: Element): string {
  let out = ''
  const walk = (el: Element): void => {
    for (const child of el.childNodes) {
      if (!child || child.nodeType !== 1) continue
      const kid = child as Element
      const tag = kid.tagName.slice(kid.tagName.indexOf(':') + 1)
      if (tag === 't') out += kid.textContent ?? ''
      else if (tag === 'tab') out += '\t'
      else if (tag === 'br' || tag === 'cr') out += '\n'
      else walk(kid)
    }
  }
  walk(p)
  return out
}

function headingLevel(p: Element): number | undefined {
  const pPr = childOf(p, 'pPr')
  const style = pPr ? childOf(pPr, 'pStyle') : undefined
  const val = attr(style, 'val')
  if (!val) return undefined
  const match = /^(?:Heading|Berschrift)(\d)$/i.exec(val)
  return match ? Number(match[1]) : undefined
}

function hasNumPr(p: Element): boolean {
  const pPr = childOf(p, 'pPr')
  if (!pPr) return false
  return childOf(pPr, 'numPr') !== undefined
}
