/**
 * Terminal downlink carrier. Web uses WebSocket upgrades; Desktop
 * `xrk-app://` has no WS upgrade (Host listen disabled), so it rides
 * Host HTTP SSE + POST (`/sidebar/api/pty/*`): SSE on `xrk-app://stream`,
 * unary POST on the page origin (`xrk-app://app`).
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

/** Page origin for unary PTY POST (input/control) and Web URL building. */
export function resolvePtyOrigin(): string {
  try {
    return location.origin
  } catch {
    return 'http://127.0.0.1'
  }
}

/**
 * Origin for the long-lived PTY SSE downlink.
 * Desktop mirrors Face mux/host: streams on `xrk-app://stream` so they do not
 * share Chromium's unary `xrk-app://app` connection pool (docs/host-face).
 */
export function resolvePtyStreamOrigin(): string {
  try {
    if (location.protocol === 'xrk-app:') return 'xrk-app://stream'
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
  const url = new URL('/sidebar/ws/terminal', resolvePtyOrigin())
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
 */
export function openHttpPtyLink(
  params: URLSearchParams,
  handlers: PtyLinkHandlers,
): PtyLink {
  const streamUrl = buildTerminalHttpStreamUrl(params)
  const ac = new AbortController()
  let opened = false
  let closed = false
  const origin = resolvePtyOrigin()

  // Unary POST must NOT share the SSE AbortController: aborting the stream
  // would otherwise cancel in-flight resize/input, and some protocol carriers
  // couple abort across sibling fetches when they share one signal.
  const postJson = (path: string, body: unknown): void => {
    if (closed) return
    void fetch(new URL(path, origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
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

  void (async () => {
    try {
      const response = await fetch(streamUrl, { method: 'GET', signal: ac.signal })
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
    url: streamUrl,
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
 * Pick carrier by page protocol:
 * - Web (`http:` / `https:`): WebSocket → Host `/sidebar/ws/terminal`
 * - Desktop (`xrk-app:`): HTTP SSE on `xrk-app://stream` + POST on page origin
 */
export function openPtyLink(
  params: URLSearchParams,
  handlers: PtyLinkHandlers,
): PtyLink {
  return usesHttpPtyCarrier()
    ? openHttpPtyLink(params, handlers)
    : openWsPtyLink(params, handlers)
}
