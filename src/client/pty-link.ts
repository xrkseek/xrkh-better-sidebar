/**
 * Terminal downlink carrier. Web uses WebSocket upgrades; Desktop
 * `xrk-app://` has no upgrade path (Host listen disabled + custom protocol),
 * so it rides Host HTTP SSE + POST (`/sidebar/api/pty/*`).
 */

export interface PtyLink {
  readonly url: string
  send(data: string): void
  close(): void
}

export interface PtyLinkHandlers {
  onOpen(): void
  onData(data: string): void
  onClose(event: { code: number; reason: string }): void
}

/** True when the shell cannot open `ws:` to Host (Desktop private Host). */
export function usesHttpPtyCarrier(): boolean {
  try {
    return location.protocol === 'xrk-app:'
  } catch {
    return false
  }
}

/**
 * Long-lived Desktop SSE must use the sibling `xrk-app://stream` host —
 * same split as Face mux/host — so Chromium's custom-protocol pool on
 * `xrk-app://app` stays free for unary RPC. A PTY stream on `app` starved
 * describe and forced Face reconnect loops ("等待重试").
 */
export function resolvePtyStreamOrigin(): string {
  try {
    if (location.protocol === 'xrk-app:') return 'xrk-app://stream'
  } catch {
    /* fall through */
  }
  try {
    return location.origin
  } catch {
    return 'http://127.0.0.1'
  }
}

/** Unary POST origin (`input` / `control`) — stays on `xrk-app://app`. */
export function resolvePtyUnaryOrigin(): string {
  try {
    return location.origin
  } catch {
    return 'http://127.0.0.1'
  }
}

function attachQuery(url: URL, params: URLSearchParams): void {
  url.search = params.toString()
}

/** Build the WebSocket URL for `/sidebar/ws/terminal`. */
export function buildTerminalWsUrl(params: URLSearchParams): string {
  const url = new URL('/sidebar/ws/terminal', location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  attachQuery(url, params)
  return url.toString()
}

/** Build the SSE stream URL for Desktop HTTP PTY. */
export function buildTerminalHttpStreamUrl(params: URLSearchParams): string {
  const url = new URL('/sidebar/api/pty/stream', resolvePtyStreamOrigin())
  attachQuery(url, params)
  return url.toString()
}

/**
 * Open a WebSocket PTY link (product `xrkh web` / any Host that listens).
 */
export function openWsPtyLink(
  params: URLSearchParams,
  handlers: PtyLinkHandlers,
): PtyLink {
  const url = buildTerminalWsUrl(params)
  const socket = new WebSocket(url)
  socket.onopen = () => { handlers.onOpen() }
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') handlers.onData(event.data)
  }
  socket.onclose = (event) => {
    handlers.onClose({ code: event.code, reason: event.reason })
  }
  socket.onerror = () => { socket.close() }
  return {
    url,
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    },
    close() { socket.close() },
  }
}

type SseEvent = { type: 'data'; data: string }
  | { type: 'exit' }
  | { type: 'error'; code: number; reason: string }

/**
 * Open an HTTP SSE + POST PTY link (Desktop `xrk-app://`).
 *
 * Prefer `xrk-app://stream` (same split as Face mux/host). No `Accept`
 * header — Face SSE omits it; a custom Accept can trip CORS preflight on
 * the sibling host and surface as "stream failed". If the stream host
 * fetch throws before open (old Desktop without stream routing), retry
 * once on `xrk-app://app` so the terminal still connects.
 */
export function openHttpPtyLink(
  params: URLSearchParams,
  handlers: PtyLinkHandlers,
): PtyLink {
  const preferredUrl = buildTerminalHttpStreamUrl(params)
  const ac = new AbortController()
  let opened = false
  let closed = false
  let activeUrl = preferredUrl

  const unaryOrigin = resolvePtyUnaryOrigin()
  const postJson = (path: string, body: unknown): void => {
    void fetch(new URL(path, unaryOrigin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    }).catch(() => { /* drop while tearing down */ })
  }

  const identity = (): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const [key, value] of params.entries()) out[key] = value
    return out
  }

  const finish = (code: number, reason: string): void => {
    if (closed) return
    closed = true
    ac.abort()
    handlers.onClose({ code, reason })
  }

  const openStream = async (streamUrl: string): Promise<Response> => {
    // Match Face SSE: GET + signal only (no Accept → no CORS preflight).
    return fetch(streamUrl, { method: 'GET', signal: ac.signal })
  }

  void (async () => {
    try {
      let response: Response
      try {
        response = await openStream(preferredUrl)
      } catch (first) {
        if (closed || ac.signal.aborted) throw first
        // Stream host unreachable (old package / Chromium reject) → app origin.
        if (preferredUrl.startsWith('xrk-app://stream')) {
          const fallback = new URL('/sidebar/api/pty/stream', unaryOrigin)
          fallback.search = params.toString()
          activeUrl = fallback.toString()
          response = await openStream(activeUrl)
        } else {
          throw first
        }
      }
      if (!response.ok || response.body === null) {
        finish(1011, `HTTP ${String(response.status)}`)
        return
      }
      opened = true
      handlers.onOpen()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!closed) {
        const { done, value } = await reader.read()
        if (done) {
          finish(1006, '')
          return
        }
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const dataLine = chunk
            .split('\n')
            .filter(line => line.startsWith('data: '))
            .map(line => line.slice(6))
            .join('')
          if (dataLine === '') continue
          let event: SseEvent
          try {
            event = JSON.parse(dataLine) as SseEvent
          } catch {
            continue
          }
          if (event.type === 'data') handlers.onData(event.data)
          else if (event.type === 'exit') finish(1000, 'exit')
          else if (event.type === 'error') finish(event.code, event.reason)
        }
      }
    } catch (error) {
      if (!closed) {
        const detail = error instanceof Error && error.message.trim()
          ? error.message.trim()
          : 'stream failed'
        finish(opened ? 1006 : 1011, opened ? '' : detail)
      }
    }
  })()

  return {
    get url() { return activeUrl },
    send(data) {
      if (closed) return
      if (data.startsWith('{')) {
        try {
          const msg = JSON.parse(data) as { type?: string; cols?: number; rows?: number }
          if (msg.type === 'resize' || msg.type === 'close' || msg.type === 'park') {
            postJson('/sidebar/api/pty/control', { ...identity(), ...msg })
            return
          }
        } catch {
          /* fall through as raw input */
        }
      }
      postJson('/sidebar/api/pty/input', { ...identity(), data })
    },
    close() {
      if (closed) return
      closed = true
      ac.abort()
    },
  }
}

/**
 * Pick carrier by page protocol — keep the split hard:
 * - Web (`http:` / `https:`): WebSocket → Host `/sidebar/ws/terminal`
 * - Desktop (`xrk-app:`): HTTP SSE on `xrk-app://stream` + POST unary on `app`
 * Never route web through the Desktop stream host.
 */
export function openPtyLink(
  params: URLSearchParams,
  handlers: PtyLinkHandlers,
): PtyLink {
  return usesHttpPtyCarrier()
    ? openHttpPtyLink(params, handlers)
    : openWsPtyLink(params, handlers)
}
