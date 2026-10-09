/**
 * Zero-dependency ZIP reader for OOXML containers (.pptx/.docx/.xlsx are ZIP
 * archives). Everything is built on browser-native APIs only:
 * `DecompressionStream('deflate-raw')` for method 8, a plain slice for method 0
 * (store), and `TextDecoder` for entry names.
 *
 * Known simplifications (deliberate ceilings):
 * - ZIP64 is supported for the *directory* only (sentinel 0xFFFFFFFF/0xFFFF in
 *   the EOCD is resolved through the ZIP64 locator + ZIP64 EOCD record) and for
 *   the per-entry sizes/offsets (ZIP64 extended information extra field). A
 *   genuinely >4 GiB single entry is not the use case here.
 * - Encryption (flag bit 0), spanned/multi-disk archives and non-deflate
 *   compression methods (bzip2, lzma, zstd) are rejected with a clear error
 *   rather than silently returning garbage.
 * - Entry names are compared byte-for-byte after normalising `\` to `/`; some
 *   third-party producers emit CP437 names, but OOXML mandates UTF-8/ASCII.
 * - `DecompressionStream` absence throws (callers degrade to "no preview");
 *   there is no inflate fallback because that would need a dependency.
 */

/** Central Directory File Header. */
const SIG_CENTRAL = 0x02014b50
/** Local File Header. */
const SIG_LOCAL = 0x04034b50
/** End of Central Directory. */
const SIG_EOCD = 0x06054b50
/** ZIP64 End of Central Directory record. */
const SIG_ZIP64_EOCD = 0x06064b50
/** ZIP64 End of Central Directory locator. */
const SIG_ZIP64_LOCATOR = 0x07064b50
/** ZIP64 extended information extra field header id. */
const EXTRA_ZIP64 = 0x0001

const U32_MAX = 0xffffffff
const U16_MAX = 0xffff
/** EOCD is at most 22 bytes + a 65535-byte comment. */
const EOCD_SCAN_LIMIT = 22 + U16_MAX

/**
 * Upper bound for a single decompressed entry. Guards against a zip bomb in a
 * file the user merely opened; raise deliberately, do not remove silently.
 */
const MAX_ENTRY_BYTES = 512 * 1024 * 1024

const utf8 = new TextDecoder('utf-8')

function fail(message: string): never {
  throw new Error(`[office/zip] ${message}`)
}

/** Normalise separators so lookups are always forward-slash based. */
function normaliseName(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Collapse `.`/`..` segments in an archive-relative path. */
function normalisePath(path: string): string {
  const out: string[] = []
  for (const seg of normaliseName(path).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

interface ZipEntry {
  /** Forward-slash normalised entry name. */
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8)
}

function u32(bytes: Uint8Array, at: number): number {
  // `>>> 0` keeps the value unsigned: `<< 24` alone would make it negative.
  return ((bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0)
}

/** 64-bit little-endian read. Values above 2^53 are not representable; we
 *  saturate to `Number.MAX_SAFE_INTEGER`, which then fails a bounds check. */
function u64(bytes: Uint8Array, at: number): number {
  let lo = u32(bytes, at)
  let hi = u32(bytes, at + 4)
  if (hi > 0x1fffff) return Number.MAX_SAFE_INTEGER
  return hi * 0x100000000 + lo
}

export class OfficeZip {
  private readonly bytes: Uint8Array
  private readonly entries: Map<string, ZipEntry>
  private readonly cache: Map<string, Promise<Uint8Array>>

  private constructor(
    bytes: Uint8Array,
    entries: Map<string, ZipEntry>,
    cache: Map<string, Promise<Uint8Array>>,
  ) {
    this.bytes = bytes
    this.entries = entries
    this.cache = cache
  }

  /** Parse the central directory of an in-memory ZIP archive. */
  static async open(bytes: Uint8Array): Promise<OfficeZip> {
    return new OfficeZip(bytes, readCentralDirectory(bytes), new Map())
  }

  has(name: string): boolean {
    return this.entries.has(normalisePath(name))
  }

  names(): string[] {
    return [...this.entries.keys()]
  }

  /** Decompress (or slice out) one entry. Repeat calls hit an internal cache. */
  read(name: string): Promise<Uint8Array> {
    const key = normalisePath(name)
    const hit = this.cache.get(key)
    if (hit) return hit
    const promise = this.readUncached(key)
    this.cache.set(key, promise)
    // A failed read must not poison the cache for a later retry.
    void promise.catch(() => this.cache.delete(key))
    return promise
  }

  /** Read + UTF-8 decode one entry, stripping a leading BOM. */
  async readText(name: string): Promise<string> {
    return utf8.decode(await this.read(name)).replace(/^﻿/, '')
  }

  private async readUncached(name: string): Promise<Uint8Array> {
    const entry = this.entries.get(name)
    if (!entry) return fail(`no such entry: ${name}`)
    const { bytes } = this

    // The local header repeats the name/extra lengths; they may differ from the
    // central ones (that is the whole point of storing them separately), so the
    // data offset can only be computed from the local header.
    if (entry.localOffset + 30 > bytes.length) return fail(`truncated archive: local header of ${name} is out of range`)
    if (u32(bytes, entry.localOffset) !== SIG_LOCAL) return fail(`corrupt archive: bad local header signature for ${name}`)
    const nameLen = u16(bytes, entry.localOffset + 26)
    const extraLen = u16(bytes, entry.localOffset + 28)
    const start = entry.localOffset + 30 + nameLen + extraLen
    const end = start + entry.compressedSize
    if (start > bytes.length || end > bytes.length || end < start) {
      return fail(`truncated archive: data of ${name} runs past the end of the file`)
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      return fail(`entry ${name} is ${entry.uncompressedSize} bytes, over the ${MAX_ENTRY_BYTES} byte preview limit`)
    }

    const raw = bytes.subarray(start, end)
    if (entry.method === 0) return raw.slice()
    if (entry.method !== 8) return fail(`unsupported compression method ${entry.method} for ${name}`)
    return inflateRaw(raw, name)
  }
}

/**
 * Inflate one raw-deflate entry.
 *
 * The source stream is built by hand rather than from `new Blob([bytes])
 * .stream()`: jsdom's Blob has no `.stream()`, and so does any runtime that
 * ships a partial Blob polyfill. A manually-enqueued `ReadableStream` plus the
 * read loop below depend on nothing beyond `ReadableStream` /
 * `DecompressionStream`, which is the widest common denominator (and the only
 * one Electron's renderer actually guarantees).
 */
async function inflateRaw(compressed: Uint8Array, name: string): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    return fail(`DecompressionStream is unavailable in this runtime, cannot inflate ${name}`)
  }
  if (compressed.byteLength > MAX_ENTRY_BYTES) {
    return fail(`entry ${name} is ${compressed.byteLength} bytes, over the ${MAX_ENTRY_BYTES} byte preview limit`)
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(compressed)
      controller.close()
    },
  })
  let stream: ReadableStream<Uint8Array>
  try {
    // The DOM lib types DecompressionStream's pair as ArrayBufferView-based,
    // which TS will not unify with Uint8Array without a cast; the runtime
    // contract is exactly this (raw bytes in, raw bytes out).
    stream = source.pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  } catch (err) {
    return fail(`cannot inflate ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Drain manually instead of `new Response(stream).arrayBuffer()`: jsdom has no
  // fetch Response either, and reading the reader directly is the one shape
  // every host implements.
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > MAX_ENTRY_BYTES) {
        await reader.cancel().catch(() => {})
        return fail(`entry ${name} inflated past the ${MAX_ENTRY_BYTES} byte preview limit`)
      }
      chunks.push(value)
    }
  } catch (err) {
    return fail(`cannot inflate ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

/** Locate the End of Central Directory record (scan backwards from the tail). */
function findEocd(bytes: Uint8Array): number {
  const from = Math.max(0, bytes.length - EOCD_SCAN_LIMIT)
  for (let at = bytes.length - 22; at >= from; at--) {
    if (u32(bytes, at) === SIG_EOCD) return at
  }
  return fail('not a ZIP archive: no end-of-central-directory record found')
}

function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const eocd = findEocd(bytes)
  let count = u16(bytes, eocd + 10)
  let dirOffset = u32(bytes, eocd + 16)

  if (count === U16_MAX || dirOffset === U32_MAX) {
    const locator = eocd - 20
    if (locator < 0 || u32(bytes, locator) !== SIG_ZIP64_LOCATOR) {
      fail('ZIP64 directory expected but the ZIP64 locator is missing (truncated or unsupported archive)')
    }
    const z64 = u64(bytes, locator + 8)
    if (z64 + 56 > bytes.length || u32(bytes, z64) !== SIG_ZIP64_EOCD) {
      fail('ZIP64 end-of-central-directory record is missing or truncated')
    }
    count = u64(bytes, z64 + 32)
    dirOffset = u64(bytes, z64 + 48)
  }

  const entries = new Map<string, ZipEntry>()
  let at = dirOffset
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length) fail(`truncated archive: central directory entry ${i} is out of range`)
    if (u32(bytes, at) !== SIG_CENTRAL) fail(`corrupt archive: bad central directory signature at entry ${i}`)
    const flags = u16(bytes, at + 8)
    if (flags & 0x0001) fail('encrypted ZIP entries are not supported')
    const method = u16(bytes, at + 10)
    const nameLen = u16(bytes, at + 28)
    const extraLen = u16(bytes, at + 30)
    const commentLen = u16(bytes, at + 32)
    let compressedSize = u32(bytes, at + 20)
    let uncompressedSize = u32(bytes, at + 24)
    let localOffset = u32(bytes, at + 42)
    const nameStart = at + 46
    if (nameStart + nameLen > bytes.length) fail(`truncated archive: file name of entry ${i} is out of range`)
    const name = normaliseName(utf8.decode(bytes.subarray(nameStart, nameStart + nameLen)))

    if (compressedSize === U32_MAX || uncompressedSize === U32_MAX || localOffset === U32_MAX) {
      // ZIP64 extra fields are positional: only the sentinel 0xFFFFFFFF fields
      // have a slot, in the order uncompressed / compressed / local offset.
      const big = readZip64Extra(bytes, nameStart + nameLen, extraLen, {
        uncompressed: uncompressedSize === U32_MAX,
        compressed: compressedSize === U32_MAX,
        offset: localOffset === U32_MAX,
      })
      if (big.uncompressed !== undefined) uncompressedSize = big.uncompressed
      if (big.compressed !== undefined) compressedSize = big.compressed
      if (big.offset !== undefined) localOffset = big.offset
    }
    // First definition wins, matching most unzip implementations.
    if (!entries.has(name)) {
      // Fail fast on the entry we can never decompress rather than at preview
      // time, so the caller never renders a half-parsed document.
      if (method !== 0 && method !== 8) fail(`unsupported compression method ${method} for ${name}`)
      entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
    }
    at = nameStart + nameLen + extraLen + commentLen
  }
  return entries
}

function readZip64Extra(
  bytes: Uint8Array,
  extraStart: number,
  extraLen: number,
  want: { uncompressed: boolean; compressed: boolean; offset: boolean },
): { uncompressed?: number; compressed?: number; offset?: number } {
  const extraEnd = extraStart + extraLen
  let at = extraStart
  while (at + 4 <= extraEnd) {
    const id = u16(bytes, at)
    const size = u16(bytes, at + 2)
    if (id === EXTRA_ZIP64) {
      let cursor = at + 4
      const out: { uncompressed?: number; compressed?: number; offset?: number } = {}
      if (want.uncompressed) out.uncompressed = u64(bytes, cursor), (cursor += 8)
      if (want.compressed) out.compressed = u64(bytes, cursor), (cursor += 8)
      if (want.offset) out.offset = u64(bytes, cursor)
      return out
    }
    at += 4 + size
  }
  fail('ZIP64 entry is missing its extended information extra field')
}
