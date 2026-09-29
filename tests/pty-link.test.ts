/** Unit tests for Desktop vs Web terminal carrier selection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildTerminalHttpStreamUrl,
  buildTerminalWsUrl,
  resolvePtyOrigin,
  usesHttpPtyCarrier,
} from '../src/client/pty-link.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pty-link carrier', () => {
  it('selects HTTP SSE on xrk-app stream origin (not unary app pool)', () => {
    vi.stubGlobal('location', { protocol: 'xrk-app:', origin: 'xrk-app://app' })
    expect(usesHttpPtyCarrier()).toBe(true)
    expect(resolvePtyOrigin()).toBe('xrk-app://app')
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1' })
    expect(buildTerminalHttpStreamUrl(params)).toBe(
      'xrk-app://stream/sidebar/api/pty/stream?sessionId=s1&tab=t1',
    )
  })

  it('keeps Web on Host WebSocket', () => {
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1:3921' })
    expect(usesHttpPtyCarrier()).toBe(false)
    expect(resolvePtyOrigin()).toBe('http://127.0.0.1:3921')
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1', cwd: '/tmp' })
    expect(buildTerminalWsUrl(params)).toBe(
      'ws://127.0.0.1:3921/sidebar/ws/terminal?sessionId=s1&tab=t1&cwd=%2Ftmp',
    )
  })

  it('keeps https Web on wss:// Host origin', () => {
    vi.stubGlobal('location', { protocol: 'https:', origin: 'https://example.test' })
    expect(usesHttpPtyCarrier()).toBe(false)
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1' })
    expect(buildTerminalWsUrl(params)).toBe(
      'wss://example.test/sidebar/ws/terminal?sessionId=s1&tab=t1',
    )
  })
})
