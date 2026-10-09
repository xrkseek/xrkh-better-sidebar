/**
 * OfficePreview rendering spec: the panes, the pager, the sheet tabs and the
 * failure paths — driven end to end (view → parser → ZIP reader) over a
 * hand-built archive, so a wrong assumption anywhere in the chain fails here
 * rather than only in the real-file spec.
 *
 * The archive is assembled with a tiny ZIP writer (deflateRaw via node:zlib)
 * instead of a fake entry map: the point of this spec is precisely the byte
 * layer the fake-map specs skip.
 */
// @vitest-environment jsdom
import { deflateRawSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { OfficePreview, officeKindOf } from '../src/client/OfficePreview.tsx'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

/** CRC-32 (the ZIP checksum); the reader doesn't verify it, but keep it honest. */
function crc32(data: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < data.length; i += 1) {
    c ^= data[i]!
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** Assemble a deflate ZIP archive from name → text entries. */
function makeZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name)
    const raw = encoder.encode(text)
    const deflated = new Uint8Array(deflateRawSync(raw))
    const crc = crc32(raw)

    const local = new Uint8Array(30 + nameBytes.length + deflated.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0, true)
    lv.setUint16(8, 8, true) // deflate
    lv.setUint32(14, crc, true)
    lv.setUint32(18, deflated.length, true)
    lv.setUint32(22, raw.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    local.set(deflated, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, deflated.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** One slide whose `sldIdLst` order is the REVERSE of its file numbering. */
const PPTX = {
  'ppt/presentation.xml': `<?xml version="1.0"?><p:presentation xmlns:p="urn:p" xmlns:r="urn:r">
    <p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst>
  </p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<?xml version="1.0"?><Relationships xmlns="urn:rel">
    <Relationship Id="rId2" Type="urn:slide" Target="slides/slide2.xml"/>
    <Relationship Id="rId3" Type="urn:slide" Target="slides/slide1.xml"/>
  </Relationships>`,
  'ppt/slides/slide1.xml': `<?xml version="1.0"?><p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r">
    <p:cSld><p:spTree>
      <p:sp><p:txBody><a:p><a:r><a:t>First </a:t></a:r><a:r><a:t>slide title</a:t></a:r></a:p><a:p><a:r><a:t>body line</a:t></a:r></a:p></p:txBody></p:sp>
      <p:pic><p:blipFill><a:blip r:embed="rId5"/></p:blipFill></p:pic>
    </p:spTree></p:cSld>
  </p:sld>`,
  'ppt/slides/_rels/slide1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="urn:rel">
    <Relationship Id="rId5" Type="urn:image" Target="../media/image1.png"/>
    <Relationship Id="rId7" Type="urn:notesSlide" Target="../notesSlides/notesSlide1.xml"/>
  </Relationships>`,
  'ppt/media/image1.png': 'fake-png-bytes',
  'ppt/notesSlides/notesSlide1.xml': `<?xml version="1.0"?><p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>remember to wave</a:t></a:r></a:p></p:notes>`,
  'ppt/slides/slide2.xml': `<?xml version="1.0"?><p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`,
}

const DOCX = {
  'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Doc Title</w:t></w:r></w:p>
    <w:p><w:r><w:t>Body </w:t></w:r><w:r><w:t>text</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>list item</w:t></w:r></w:p>
  </w:body></w:document>`,
}

const XLSX = {
  'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="urn:r"><sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="urn:rel">
    <Relationship Id="rId1" Type="urn:worksheet" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Type="urn:worksheet" Target="worksheets/sheet2.xml"/>
  </Relationships>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
  </sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="str"><v>note</v></c></row></sheetData></worksheet>`,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst><si><t>Name</t></si><si><t>Age</t></si><si><t>Ada</t></si><si><t>36</t></si></sst>`,
}

let container: HTMLDivElement
let root: Root

/** Render OfficePreview with fetch answering the given archive's bytes, and
 *  wait past the async fetch → parse chain (one act() tick only covers the
 *  fetch, not the decompression that follows). */
async function render(path: string, entries: Record<string, string> = {}): Promise<void> {
  const bytes = makeZip(entries)
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(OfficePreview, { scope: { sessionId: 's1', cwd: '/tmp' }, path }))
  })
  // Parsing inflates through DecompressionStream, whose chunks resolve on later
  // macrotasks than the fetch mock — and later still under a loaded full-suite
  // run. Poll with real timer turns so the wait scales with the work instead of
  // a fixed tick count. Returning early on ANY non-loading state also covers
  // the failure panes, which must settle just as reliably as the happy path.
  for (let i = 0; i < 200; i += 1) {
    if (!container.textContent?.includes('Converting')) return
    await act(async () => {
      await new Promise(resolve => { setTimeout(resolve, 5) })
    })
  }
}

/** The Next/Previous pager button by its label. */
function pagerButton(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.textContent?.trim() === label)
}

afterEach(() => {
  // The `officeKindOf` unit block renders nothing, so `root` may be unset.
  if (root !== undefined) act(() => { root.unmount() })
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('officeKindOf', () => {
  it('maps only the OOXML extensions', () => {
    expect(officeKindOf('/a/b.pptx')).toBe('pptx')
    expect(officeKindOf('/a/b.DOCX')).toBe('docx')
    expect(officeKindOf('/a/b.xlsx')).toBe('xlsx')
    expect(officeKindOf('/a/b.doc')).toBeUndefined()
    expect(officeKindOf('/a/b.pdf')).toBeUndefined()
  })
})

describe('OfficePreview', () => {
  it('refuses a non-OOXML path', async () => {
    await render('/tmp/a.doc')
    expect(container.textContent).toContain('no preview')
  })

  it('renders a deck in presentation order and pages through it', async () => {
    await render('/tmp/a.pptx', PPTX)
    // sldIdLst says slide2 first, so the file numbers must NOT drive order.
    expect(container.textContent).toContain('Second slide')
    const before = container.textContent
    const next = pagerButton('Next')
    expect(next).toBeDefined()
    act(() => { next!.click() })
    expect(container.textContent).not.toBe(before)
    expect(container.textContent).toContain('First slide title')
  })

  it('joins runs inside one paragraph and shows speaker notes', async () => {
    await render('/tmp/a.pptx', PPTX)
    const next = pagerButton('Next')
    expect(next).toBeDefined()
    act(() => { next!.click() })
    // Runs "First " + "slide title" are one paragraph, not two.
    expect(container.textContent).toContain('First slide title')
    expect(container.textContent).toContain('body line')
    expect(container.textContent).toContain('remember to wave')
  })

  it('renders a docx with a heading and a list item', async () => {
    await render('/tmp/a.docx', DOCX)
    expect(container.querySelector('h1')?.textContent).toBe('Doc Title')
    expect(container.textContent).toContain('Body text')
    expect(container.textContent).toContain('list item')
  })

  it('renders a workbook with sheet tabs that switch the grid', async () => {
    await render('/tmp/a.xlsx', XLSX)
    expect(container.textContent).toContain('Name')
    expect(container.textContent).toContain('Ada')
    const notes = pagerButton('Notes')
    expect(notes).toBeDefined()
    act(() => { notes!.click() })
    expect(container.textContent).toContain('note')
  })

  it('reports a parse failure instead of rendering an empty pane', async () => {
    await render('/tmp/a.pptx', { 'junk.txt': 'not a deck' })
    expect(container.textContent).toMatch(/Preview failed/)
  })

  it('reports a host refusal', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404 }))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root.render(createElement(OfficePreview, { scope: { sessionId: 's1', cwd: '/tmp' }, path: '/tmp/a.docx' }))
    })
    expect(container.textContent).toContain('HTTP 404')
  })
})
