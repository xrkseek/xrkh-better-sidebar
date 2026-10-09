/**
 * Real-ZIP tests for office/zip.ts. The archives here are built byte by byte
 * (local header + central directory + EOCD) with `node:zlib`, so the reader is
 * exercised against genuine deflate streams rather than a stub.
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { OfficeZip } from '../src/client/office/zip.ts'

interface EntrySpec {
  name: string
  /** Store the entry uncompressed instead of deflating it. */
  store?: boolean
  data?: Uint8Array | string
}

function bytesOf(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  // Views into a pooled ArrayBuffer must never be mutated in place below.
  return new Uint8Array(bytes)
}

/**
 * Build a ZIP archive. Deliberately minimal: no data descriptors, no ZIP64,
 * no comments — exactly what a small OOXML part directory looks like.
 */
function buildZip(entries: EntrySpec[]): Uint8Array {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = bytesOf(entry.data ?? '')
    const method = entry.store ? 0 : 8
    const payload = entry.store ? raw : new Uint8Array(deflateRawSync(raw))
    const nameBytes = encoder.encode(entry.name)

    const local = new Uint8Array(30 + nameBytes.length + payload.length)
    const lv = new DataView(local.buffer, local.byteOffset, local.byteLength)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(8, method, true)
    lv.setUint32(18, payload.length, true) // compressed size
    lv.setUint32(22, raw.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(payload, 30 + nameBytes.length)
    locals.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer, central.byteOffset, central.byteLength)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(10, method, true)
    cv.setUint32(20, payload.length, true)
    cv.setUint32(24, raw.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centrals.push(central)

    offset += local.length
  }

  const dirSize = centrals.reduce((n, c) => n + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, dirSize, true)
  ev.setUint32(16, offset, true)

  const all = [...locals, ...centrals, eocd]
  const total = all.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of all) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

describe('OfficeZip', () => {
  it('reads deflate and stored entries in one archive', async () => {
    const zip = await OfficeZip.open(
      buildZip([
        { name: 'ppt/presentation.xml', data: '<p:presentation>hello</p:presentation>' },
        { name: 'ppt/media/image1.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), store: true },
        { name: 'ppt/media/image2.png', data: 'x'.repeat(4096) },
      ]),
    )

    expect(zip.names()).toEqual(['ppt/presentation.xml', 'ppt/media/image1.png', 'ppt/media/image2.png'])
    expect(zip.has('ppt/presentation.xml')).toBe(true)
    expect(zip.has('ppt/nope.xml')).toBe(false)

    const xml = new TextDecoder().decode(await zip.read('ppt/presentation.xml'))
    expect(xml).toBe('<p:presentation>hello</p:presentation>')
    expect(await zip.read('ppt/media/image1.png')).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    expect((await zip.read('ppt/media/image2.png')).length).toBe(4096)
  })

  it('round-trips UTF-8 entry names and text', async () => {
    const zip = await OfficeZip.open(buildZip([{ name: 'ppt/幻灯片.xml', data: '<a:t>你好，世界</a:t>' }]))
    expect(zip.has('ppt/幻灯片.xml')).toBe(true)
    expect(await zip.readText('ppt/幻灯片.xml')).toBe('<a:t>你好，世界</a:t>')
  })

  it('normalises backslash separators in lookups', async () => {
    const zip = await OfficeZip.open(buildZip([{ name: 'xl/worksheets/sheet1.xml', data: '<x/>' }]))
    expect(zip.has('xl\\worksheets\\sheet1.xml')).toBe(true)
    expect(await zip.readText('xl/worksheets/sheet1.xml')).toBe('<x/>')
  })

  it('caches reads but re-reads after a failure', async () => {
    const zip = await OfficeZip.open(buildZip([{ name: 'a.txt', data: 'abc' }]))
    await expect(zip.read('missing.txt')).rejects.toThrow(/no such entry/)
    await expect(zip.read('missing.txt')).rejects.toThrow(/no such entry/)
    expect(await zip.readText('a.txt')).toBe('abc')
  })

  it('rejects input that is not a ZIP archive', async () => {
    await expect(OfficeZip.open(new TextEncoder().encode('not a zip at all'))).rejects.toThrow(
      /end-of-central-directory/,
    )
  })

  it('rejects a truncated archive', async () => {
    const full = buildZip([{ name: 'a.txt', data: 'x'.repeat(2000) }])
    await expect(OfficeZip.open(full.subarray(0, full.length - 30))).rejects.toThrow(/ZIP|no entry/i)
  })

  it('rejects a declared size that runs past the end of the file', async () => {
    const full = buildZip([{ name: 'a.txt', data: 'x'.repeat(500) }])
    // Chop the EOCD off so the directory is found but entry data is gone.
    await expect(OfficeZip.open(full.subarray(0, full.length - 30))).rejects.toThrow(/ZIP|no entry/i)
  })

  it('surfaces an error when deflate data is corrupt', async () => {
    // Claim method 8 but write garbage as the payload.
    const archive = buildZip([{ name: 'a.txt', store: true, data: 'abcdefgh' }])
    const view = new DataView(archive.buffer)
    view.setUint16(8, 8, true)
    view.setUint16(archive.length - 22 - (46 + 5) + 10, 8, true)
    for (let i = 35; i < 43; i++) archive[i] = 0xff
    const zip = await OfficeZip.open(archive)
    await expect(zip.read('a.txt')).rejects.toThrow()
  })

  it('rejects unsupported compression methods', async () => {
    const archive = buildZip([{ name: 'a.txt', store: true, data: 'abc' }])
    // Method lives at offset 8 of the local header and 10 of the central one.
    const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
    view.setUint16(8, 12, true)
    const centralOffset = archive.length - 22 - (46 + 'a.txt'.length)
    view.setUint16(centralOffset + 10, 12, true)
    await expect(OfficeZip.open(archive)).rejects.toThrow(/unsupported compression method 12/)
  })
})
