/** Unit tests for Desktop vs Web terminal carrier selection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTerminalHttpStreamUrl,
  buildTerminalWsUrl,
  resolvePtyStreamOrigin,
  resolvePtyUnaryOrigin,
  usesHttpPtyCarrier,
} from '../src/client/pty-link.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pty-link carrier', () => {
  it('selects HTTP on xrk-app and puts SSE on the stream host', () => {
    vi.stubGlobal('location', { protocol: 'xrk-app:', origin: 'xrk-app://app' })
    expect(usesHttpPtyCarrier()).toBe(true)
    expect(resolvePtyStreamOrigin()).toBe('xrk-app://stream')
    expect(resolvePtyUnaryOrigin()).toBe('xrk-app://app')
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1' })
    expect(buildTerminalHttpStreamUrl(params)).toBe(
      'xrk-app://stream/sidebar/api/pty/stream?sessionId=s1&tab=t1',
    )
  })

  it('builds ws URL on http(s)', () => {
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1:3921' })
    expect(usesHttpPtyCarrier()).toBe(false)
    expect(resolvePtyStreamOrigin()).toBe('http://127.0.0.1:3921')
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1', cwd: '/tmp' })
    expect(buildTerminalWsUrl(params)).toBe(
      'ws://127.0.0.1:3921/sidebar/ws/terminal?sessionId=s1&tab=t1&cwd=%2Ftmp',
    )
  })
})
