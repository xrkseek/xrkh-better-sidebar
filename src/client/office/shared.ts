/**
 * Shared plumbing for the OOXML parsers: a `ZipLike` seam so tests can feed a
 * fake archive of XML strings instead of real .pptx binaries, plus content-type
 * sniffing and image mime mapping.
 *
 * Known simplifications:
 * - `ZipLike` is structurally `OfficeZip`, but kept as its own minimal
 *   interface so a spec can supply a plain map of entries without inflating a
 *   real ZIP.
 * - Only the parts the previews actually need are read; layout, theme,
 *   chart and embedded-object parts are ignored on purpose.
 */

/** The slice of {@link OfficeZip} the parsers depend on. */
export interface ZipLike {
  has(name: string): boolean
  names(): string[]
  read(name: string): Promise<Uint8Array>
}

/** Decode a ZIP entry as UTF-8 text. */
export async function readText(zip: ZipLike, name: string): Promise<string> {
  return new TextDecoder('utf-8').decode(await zip.read(name))
}

/**
 * Image mime by media file extension. `emf`/`wmf`/`svg` are reported so the
 * caller can decide; browsers cannot rasterise the first two.
 */
export function imageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'bmp': return 'image/bmp'
    case 'webp': return 'image/webp'
    case 'tif':
    case 'tiff': return 'image/tiff'
    case 'svg': return 'image/svg+xml'
    case 'emf': return 'image/emf'
    case 'wmf': return 'image/wmf'
    default: return 'application/octet-stream'
  }
}

/**
 * A ZIP that yields fixed strings. Test-only seam, exported so the pptx/docx/
 * xlsx specs can exercise the real parsing logic over synthetic parts.
 */
export function fakeZip(entries: Record<string, string>): ZipLike {
  const encoder = new TextEncoder()
  const bytes = new Map<string, Uint8Array>()
  for (const [name, text] of Object.entries(entries)) bytes.set(name.replace(/\\/g, '/'), encoder.encode(text))
  return {
    has: (name) => bytes.has(name.replace(/\\/g, '/')),
    names: () => [...bytes.keys()],
    read: async (name) => {
      const hit = bytes.get(name.replace(/\\/g, '/'))
      if (!hit) throw new Error(`fake zip: no entry ${name}`)
      return hit
    },
  }
}

/** Reject a file that is not an OOXML container at all. */
export function assertOfficeZip(zip: ZipLike, kind: string): void {
  if (zip.names().length === 0) {
    throw new Error(`[office/${kind}] the file is not a valid Office document (empty archive)`)
  }
}