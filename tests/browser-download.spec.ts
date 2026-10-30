/**
 * Mobile-safe download helpers: basename hints + fetch→blob→`<a download>`,
 * with a classic-anchor fallback when fetch fails (offline host, 4xx, etc.).
 */
import './browser-globals.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  downloadBasename, downloadUrl, triggerBrowserDownload,
} from '../src/client/api.ts'

describe('downloadBasename', () => {
  it('takes the last path segment on POSIX and Win', () => {
    expect(downloadBasename('/home/u/a.png')).toBe('a.png')
    expect(downloadBasename('C:\\Users\\u\\b.docx')).toBe('b.docx')
    expect(downloadBasename('plain.txt')).toBe('plain.txt')
  })

  it('strips a trailing separator then takes the segment', () => {
    expect(downloadBasename('/tmp/')).toBe('tmp')
    expect(downloadBasename('/')).toBe('download')
    // Drive root trims to `C:` — not empty — so it stays as the leaf hint.
    expect(downloadBasename('C:\\')).toBe('C:')
  })

  it('keeps unicode and spaces in the leaf name', () => {
    expect(downloadBasename('/ws/报告 终稿.pdf')).toBe('报告 终稿.pdf')
    expect(downloadBasename('C:\\Users\\u\\photo (1).png')).toBe('photo (1).png')
  })

  it('does not treat query-like suffixes as a separate segment', () => {
    // Basename is path-only; download=1 lives on the URL, not the path.
    expect(downloadBasename('/ws/a.b.c.tar.gz')).toBe('a.b.c.tar.gz')
  })
})

describe('downloadUrl', () => {
  it('marks the route as an attachment download with session scope', () => {
    const url = downloadUrl({ sessionId: 's1', cwd: '/home/u/ws' }, '/home/u/ws/a.bin')
    expect(url.startsWith('/sidebar/file?')).toBe(true)
    const params = new URLSearchParams(url.slice(url.indexOf('?')))
    expect(params.get('sessionId')).toBe('s1')
    expect(params.get('cwd')).toBe('/home/u/ws')
    expect(params.get('path')).toBe('/home/u/ws/a.bin')
    expect(params.get('download')).toBe('1')
  })

  it('omits cwd when unset and still encodes the path', () => {
    const url = downloadUrl({ sessionId: 's2' }, '/tmp/有 空格.png')
    const params = new URLSearchParams(url.slice(url.indexOf('?')))
    expect(params.get('cwd')).toBeNull()
    expect(params.get('path')).toBe('/tmp/有 空格.png')
    expect(params.get('download')).toBe('1')
  })
})

type AnchorStub = {
  href: string
  download: string
  rel: string
  style: { display: string }
  click: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
}

function installAnchorCapture(): { anchors: AnchorStub[]; appendChild: ReturnType<typeof vi.fn> } {
  const anchors: AnchorStub[] = []
  const appendChild = vi.fn()
  ;(document.body as { appendChild: typeof appendChild }).appendChild = appendChild
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'a') {
      const anchor: AnchorStub = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn(),
      }
      anchors.push(anchor)
      return anchor as unknown as HTMLAnchorElement
    }
    // browser-globals stub — avoid recursing into the spy.
    return {
      style: {},
      dataset: {},
      classList: { add: () => {}, remove: () => {}, contains: () => false },
      setAttribute: () => {},
      getAttribute: () => null,
      appendChild: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
      getContext: () => null,
    } as unknown as HTMLElement
  }) as typeof document.createElement)
  return { anchors, appendChild }
}

describe('triggerBrowserDownload', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetches bytes with credentials and clicks a blob download anchor', async () => {
    const blob = new Blob(['hi'], { type: 'text/plain' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(blob, { status: 200 })))
    const createObjectURL = vi.fn(() => 'blob:mock-url')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })
    // Capture the deferred revoke (window.setTimeout) without depending on
    // fake-timer ↔ browser-globals wiring.
    const deferred: Array<() => void> = []
    vi.spyOn(window, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') deferred.push(fn as () => void)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
    const { anchors, appendChild } = installAnchorCapture()

    await triggerBrowserDownload('/sidebar/file?download=1', 'note.txt')

    expect(fetch).toHaveBeenCalledWith('/sidebar/file?download=1', { credentials: 'same-origin' })
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.href).toBe('blob:mock-url')
    expect(anchors[0]!.download).toBe('note.txt')
    expect(anchors[0]!.rel).toBe('noopener')
    expect(anchors[0]!.click).toHaveBeenCalledTimes(1)
    expect(appendChild).toHaveBeenCalled()
    expect(anchors[0]!.remove).toHaveBeenCalled()

    // WebKit needs the blob URL alive briefly; revoke only after the deferral.
    expect(revokeObjectURL).not.toHaveBeenCalled()
    expect(deferred).toHaveLength(1)
    deferred[0]!()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url')
  })

  it('defaults the filename hint when omitted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['x']), { status: 200 })))
    vi.stubGlobal('URL', { ...URL, createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    const { anchors } = installAnchorCapture()

    await triggerBrowserDownload('/sidebar/file?download=1')

    expect(anchors[0]!.download).toBe('download')
  })

  it('falls back to a classic anchor when the host returns a non-OK status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    const createObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL: () => {} })
    const { anchors } = installAnchorCapture()

    await triggerBrowserDownload('/sidebar/file?path=a&download=1', 'a.bin')

    expect(createObjectURL).not.toHaveBeenCalled()
    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.href).toBe('/sidebar/file?path=a&download=1')
    expect(anchors[0]!.download).toBe('a.bin')
    expect(anchors[0]!.click).toHaveBeenCalledTimes(1)
  })

  it('falls back when fetch itself rejects (network / CORS)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    const { anchors } = installAnchorCapture()

    await triggerBrowserDownload('/sidebar/file?download=1', 'offline.bin')

    expect(anchors).toHaveLength(1)
    expect(anchors[0]!.href).toBe('/sidebar/file?download=1')
    expect(anchors[0]!.download).toBe('offline.bin')
    expect(anchors[0]!.click).toHaveBeenCalledTimes(1)
  })
})
