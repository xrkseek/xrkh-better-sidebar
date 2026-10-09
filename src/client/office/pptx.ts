/**
 * PresentationML (.pptx) text/image extractor. Slides are ordered by the
 * `<p:sldIdLst>` sequence in `presentation.xml`, not by file name — the file
 * numbers are just allocation order and real decks reorder slides all the time.
 *
 * Known simplifications:
 * - Text only: run/paragraph/character formatting, tables, charts and SmartArt
 *   are flattened to plain strings. Layout/master placeholder text is not
 *   merged into the slide (spec-correct rendering needs the layout tree).
 * - Images come from the slide's own `.rels`; those inherited from the layout
 *   or master are not collected (they are decoration, and pulling them in
 *   duplicates every logo on every page).
 * - Speaker notes are read from `<a:t>` only; notes formatting is dropped.
 */
import { OfficeZip } from './zip.ts'
import { assertOfficeZip, imageMime, readText, type ZipLike } from './shared.ts'
import { attr, attrPrefixed, dirOf, findAll, parseXml, relsMap, resolveRelTarget } from './xml.ts'

export interface PptxImage {
  name: string
  mime: string
  bytes: Uint8Array
}

export interface PptxSlide {
  /** 1-based slide number, in presentation order. */
  index: number
  /** Paragraph text, in XML document order. */
  texts: string[]
  /** Images referenced by this slide, resolved through its rels part. */
  images: PptxImage[]
  /** Speaker notes, when the slide has a notes part. */
  notes?: string
}

export interface PptxDeck {
  slides: PptxSlide[]
}

/** Parse a .pptx container. */
export async function parsePptx(bytes: Uint8Array): Promise<PptxDeck> {
  return parsePptxFromZip(await OfficeZip.open(bytes))
}

/**
 * Parse an already-opened archive. Exported so specs can drive the real
 * parsing logic through {@link ZipLike} without building a binary .pptx.
 */
export async function parsePptxFromZip(zip: ZipLike): Promise<PptxDeck> {
  assertOfficeZip(zip, 'pptx')
  const slidesPart = 'ppt/presentation.xml'
  if (!zip.has(slidesPart)) throw new Error('[office/pptx] ppt/presentation.xml is missing: not a .pptx file')

  const presentation = parseXml(await readText(zip, slidesPart))
  const presRels = zip.has('ppt/_rels/presentation.xml.rels')
    ? relsMap(parseXml(await readText(zip, 'ppt/_rels/presentation.xml.rels')))
    : new Map<string, { type: string; target: string }>()

  const order: string[] = []
  for (const id of findAll(presentation, 'sldId')) {
    // The prefixed `r:id` is the relationship; the plain `id` is numeric noise.
    const rid = attrPrefixed(id, 'id')
    if (!rid) continue
    const rel = presRels.get(rid)
    if (!rel) continue
    order.push(resolveRelTarget('ppt', rel.target))
  }

  const slides: PptxSlide[] = []
  for (const part of order) {
    if (!zip.has(part)) continue
    slides.push(await readSlide(zip, part, slides.length + 1))
  }
  return { slides }
}

async function readSlide(zip: ZipLike, part: string, index: number): Promise<PptxSlide> {
  const doc = parseXml(await readText(zip, part))
  const relsPart = `${dirOf(part)}/_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`
  const rels = zip.has(relsPart)
    ? relsMap(parseXml(await readText(zip, relsPart)))
    : new Map<string, { type: string; target: string; targetMode?: string }>()

  const texts: string[] = []
  for (const para of findAll(doc, 'p')) {
    // `findAll` walks the whole tree, so a paragraph can surface as a
    // descendant of another matching node; the DrawingML body only nests
    // `<a:p>` inside `<a:txBody>`, so a direct pass is safe.
    let line = ''
    for (const run of findAll(para, 't')) line += run.textContent ?? ''
    if (line.trim().length > 0) texts.push(line)
  }

  const images: PptxImage[] = []
  const seen = new Set<string>()
  for (const blip of findAll(doc, 'blip')) {
    const embed = attrPrefixed(blip, 'embed')
    if (!embed) continue
    const rel = rels.get(embed)
    if (!rel || rel.targetMode === 'External' || !/image$/.test(rel.type)) continue
    const target = resolveRelTarget(dirOf(part), rel.target)
    if (seen.has(target) || !zip.has(target)) continue
    seen.add(target)
    images.push({ name: target.slice(target.lastIndexOf('/') + 1), mime: imageMime(target), bytes: await zip.read(target) })
  }

  const notes = await readNotes(zip, rels)
  const slide: PptxSlide = { index, texts, images }
  if (notes) slide.notes = notes
  return slide
}

async function readNotes(zip: ZipLike, rels: Map<string, { type: string; target: string; targetMode?: string }>): Promise<string | undefined> {
  for (const rel of rels.values()) {
    // Real relationship types are absolute URLs ending in `notesSlide`, but a
    // producer may emit a bare or namespace-qualified form, so match on the
    // last path segment rather than requiring a leading slash.
    if (!/notesSlide$/.test(rel.type)) continue
    const part = resolveRelTarget('ppt/slides', rel.target)
    if (!zip.has(part)) continue
    const doc = parseXml(await readText(zip, part))
    const paragraphs: string[] = []
    for (const para of findAll(doc, 'p')) {
      let line = ''
      for (const run of findAll(para, 't')) line += run.textContent ?? ''
      if (line.trim().length > 0) paragraphs.push(line)
    }
    if (paragraphs.length > 0) return paragraphs.join('\n')
  }
  return undefined
}
