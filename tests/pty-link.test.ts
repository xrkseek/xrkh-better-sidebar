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

  it('keeps Web on Host WebSocket (no xrk-app://stream, no HTTP PTY carrier)', () => {
    vi.stubGlobal('location', { protocol: 'http:', origin: 'http://127.0.0.1:3921' })
    expect(usesHttpPtyCarrier()).toBe(false)
    // HTTP helpers must not invent a Desktop stream host on web.
    expect(resolvePtyStreamOrigin()).toBe('http://127.0.0.1:3921')
    expect(resolvePtyUnaryOrigin()).toBe('http://127.0.0.1:3921')
    const params = new URLSearchParams({ sessionId: 's1', tab: 't1', cwd: '/tmp' })
    const ws = buildTerminalWsUrl(params)
    expect(ws).toBe(
      'ws://127.0.0.1:3921/sidebar/ws/terminal?sessionId=s1&tab=t1&cwd=%2Ftmp',
    )
    expect(ws.startsWith('ws:')).toBe(true)
    expect(ws.includes('xrk-app://')).toBe(false)
    expect(buildTerminalHttpStreamUrl(params).includes('xrk-app://stream')).toBe(false)
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
