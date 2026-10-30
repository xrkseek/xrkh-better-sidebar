/**
 * BinaryDownload pane: the no-preview fallback must call the mobile-safe
 * download helper (preventDefault + fetch→blob), not rely on bare navigation.
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
  downloadUrl: (_scope: unknown, path: string) => `/sidebar/file?path=${encodeURIComponent(path)}&download=1`,
  downloadBasename: (path: string) => {
    const trimmed = path.replace(/[/\\]+$/, '')
    const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    const name = slash === -1 ? trimmed : trimmed.slice(slash + 1)
    return name === '' ? 'download' : name
  },
  triggerBrowserDownload: (...args: unknown[]) => triggerBrowserDownload(...args),
}))

import { BinaryDownload } from '../src/client/binary-download.tsx'

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
})

afterEach(() => {
  act(() => { root.unmount() })
  document.body.innerHTML = ''
})

describe('BinaryDownload', () => {
  it('renders an attachment link with a basename download hint', async () => {
    await act(async () => {
      root.render(createElement(BinaryDownload, {
        scope: { sessionId: 's1', cwd: '/ws' },
        path: '/ws/report.pdf',
      }))
    })
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toContain('download=1')
    expect(link!.getAttribute('download')).toBe('report.pdf')
    expect(container.textContent).toMatch(/download|Download|下载/i)
  })

  it('prevents navigation and delegates to triggerBrowserDownload', async () => {
    await act(async () => {
      root.render(createElement(BinaryDownload, {
        scope: { sessionId: 's1' },
        path: 'C:\\Users\\u\\photo.png',
      }))
    })
    const link = container.querySelector('a')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => { link.dispatchEvent(event) })

    expect(event.defaultPrevented).toBe(true)
    expect(triggerBrowserDownload).toHaveBeenCalledTimes(1)
    const [url, name] = triggerBrowserDownload.mock.calls[0]!
    expect(String(url)).toContain('download=1')
    expect(name).toBe('photo.png')
  })

  it('surfaces an open-with notice when provided', async () => {
    await act(async () => {
      root.render(createElement(BinaryDownload, {
        scope: { sessionId: 's1' },
        path: '/ws/a.bin',
        notice: 'Editor not found',
      }))
    })
    expect(container.textContent).toContain('Editor not found')
  })
})
