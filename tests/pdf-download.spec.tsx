/**
 * PdfView toolbar download: same mobile-safe helper as BinaryDownload /
 * ImagePreview — click must not navigate away from the preview iframe.
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const { triggerBrowserDownload } = vi.hoisted(() => ({
  triggerBrowserDownload: vi.fn(async () => {}),
}))

vi.mock('../src/client/api.ts', () => ({
  mediaUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${encodeURIComponent(path)}`,
  downloadUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${encodeURIComponent(path)}&download=1`,
  downloadBasename: (path: string) => path.split(/[/\\]/).pop() || 'download',
  triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args),
}))

import { PdfView } from '../src/client/PdfView.tsx'

beforeAll(() => {
  Object.defineProperty(window.navigator, 'language', { value: 'en-US', configurable: true })
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  triggerBrowserDownload.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['%PDF']), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' },
  })))
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:pdf-preview',
    revokeObjectURL: () => {},
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('PdfView download', () => {
  it('wires the toolbar link through triggerBrowserDownload', async () => {
    await act(async () => {
      root.render(createElement(PdfView, {
        scope: { sessionId: 's1', cwd: '/ws' },
        path: '/ws/spec.pdf',
        title: 'spec.pdf',
      }))
    })
    // Allow the preview fetch to settle.
    await act(async () => { await Promise.resolve() })

    const link = [...container.querySelectorAll('a')]
      .find(a => (a.getAttribute('download') ?? '') !== '' || (a.getAttribute('href') ?? '').includes('download=1'))
    expect(link).toBeDefined()
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link!.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
    expect(triggerBrowserDownload).toHaveBeenCalledWith(
      expect.stringContaining('download=1'),
      'spec.pdf',
    )
  })
})
