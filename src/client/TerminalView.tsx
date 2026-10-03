/**
 * The interactive terminal: xterm.js over a Host pty carrier.
 * Web uses WebSocket upgrades; Desktop `xrk-app://` uses HTTP SSE + POST
 * (`pty-link.ts`) because the private Host does not listen and cannot upgrade.
 * The host replays the session's transcript on connect, then streams live
 * output; input frames are raw text, resize frames are JSON with
 * type:"resize". Transient disconnects (page refresh, host restart) reconnect
 * automatically; a server-side refusal (close code 1011 with a reason, e.g.
 * a failed pty spawn) stops the loop and shows the reason with a manual
 * retry, and repeated unreasoned failures surface the close code after three
 * attempts, so the banner never spins forever.
 *
 * Three control frames shape the pty lifecycle on unmount:
 * - `{type:'close'}` — the user closed the tab. The host kills the pty
 *   immediately (quota released).
 * - `{type:'park'}` — the user switched to another conversation. The tab is
 *   still open in its session's persisted state but its view unmounted; the
 *   host keeps the pty alive indefinitely (no grace countdown), so switching
 *   back reattaches the same shell instead of respawning one.
 * - bare socket drop (no frame) — page refresh, crash, plugin teardown, or a
 *   same-session re-render. The host's reconnect grace keeps the shell alive
 *   for a quick reconnect.
 *
 * Two attach modes share one upgrade endpoint:
 * - `tabId` starting with `agent:` is an agent-owned terminal (created by
 *   the `terminal_create` tool). The uuid is the suffix after `agent:`; the
 *   view connects with `?uuid=...`. A close frame kills the pty (the agent's
 *   terminal closes when the user closes the tab); a bare socket drop
 *   leaves the pty alive (the agent owns the lifetime) — agent terminals
 *   never send park (their lifetime is already indefinite on bare drop).
 * - Any other `tabId` is a UI-tab terminal (the user created it from the +
 *   menu). The view connects with `?tab=...&sessionId=...&cwd=...`. A close
 *   frame schedules a 0-ms close; a park frame marks the pty as parked; a
 *   bare socket drop gets the host's reconnect grace.
 */
import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { writeClipboard } from '@xrkseek/client-ui-primitives'
import '@xterm/xterm/css/xterm.css'
import { t } from './locales.ts'
import { MIN_OPEN_SIZE, openWhenSized } from './open-when-sized.ts'
import { api, type SessionScope, type TerminalDepsStatus } from './api.ts'
import { agentUuidOf, isAgentTabId, type SidebarStore } from './state.ts'
import { isDarkScheme, subscribeColorScheme, effectiveTokenValue, tokenValue } from './theme.ts'
import { resolveTerminalFont } from './terminal-font.ts'
import {
  buildTerminalLinks,
  shouldActivateTerminalLink,
  openTerminalUrl,
} from './terminal-links.ts'
import { openPtyLink, type PtyLink } from './pty-link.ts'
import { terminalPaintBroken } from './terminal-paint.ts'
import css from './sidebar.module.css'

/** How many consecutive unreasoned failures before showing the error banner. */
const FAILURE_LIMIT = 3
/**
 * Desktop Host restart (pipe 503 / mid-stream drop) can take longer than three
 * 2s retries. Keep soft-reconnecting instead of pinning a fatal banner over an
 * already-painted MOTD while Host is coming back.
 */
const HOST_RESTART_LIMIT = 45

/**
 * The WS close-code-1011 reason the host sends when node-pty is unavailable
 * (mirror of the host's PTY_DEPS_MISSING; the value is a wire contract, so
 * the two sides keep the literal in lockstep). The view then fetches the
 * full repair details from /sidebar/api/terminal.deps.
 */
const PTY_DEPS_MISSING = 'pty-deps-missing'

/** The degraded-mode payload rendered by {@link TerminalDepsBanner}. */
type TerminalDepsInfo = Extract<TerminalDepsStatus, { ok: false }>

/**
 * Curated ANSI palettes for the terminal. The surface colors (background,
 * foreground, cursor, selection) ride the theme tokens so the terminal
 * blends with the panel in both schemes; the 16 ANSI colors are the same
 * designed palettes the app's code surfaces use (one-dark family for dark,
 * one-light family for light), read live so a scheme flip re-themes in
 * place.
 */
const ANSI_DARK: Record<string, string> = {
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
}

const ANSI_LIGHT: Record<string, string> = {
  black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401',
  blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#a0a1a7',
  brightBlack: '#4f525e', brightRed: '#e45649', brightGreen: '#50a14f',
  brightYellow: '#c18401', brightBlue: '#0184bc', brightMagenta: '#a626a4',
  brightCyan: '#0997b3', brightWhite: '#fafafa',
}

/** The xterm theme for the current scheme (surface from tokens, ANSI curated). */
function xtermTheme(): ITheme {
  const dark = isDarkScheme()
  // Skin systems set --dsw-alias-bg-base to `transparent` or translucent
  // glass values (the dsh-web-ui skins use rgba 0.16–0.7); effectiveTokenValue
  // treats those as unset below the opacity floor, so the opaque fallback
  // engages and the terminal never renders see-through over the skin's
  // backdrop (issue #90). Effectively opaque scoped surfaces (e.g. a skin's
  // 0.96 porcelain) pass through — the skin still controls the terminal.
  const background = effectiveTokenValue('--dsw-alias-bg-base') || (dark ? '#111114' : '#ffffff')
  const foreground = effectiveTokenValue('--dsw-alias-label-primary') || (dark ? '#e6e6e6' : '#1a1a1a')
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)',
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

/**
 * Host has a real box but xterm's paint grid is dead — the post-sleep blank
 * terminal: fit left rows/cols at 0, or the `.xterm-screen` layer collapsed
 * while the panel chrome still looks open.
 * @see terminal-paint.ts
 */
export { terminalPaintBroken } from './terminal-paint.ts'

export function TerminalView(props: { scope: SessionScope; tabId: string; store: SidebarStore; visible?: boolean }) {
  const { scope, tabId, store } = props
  const visible = props.visible !== false
  const hostRef = useRef<HTMLDivElement>(null)
  const [connected, setConnected] = useState(false)
  const [fatal, setFatal] = useState<string | null>(null)
  const [depsFatal, setDepsFatal] = useState<TerminalDepsInfo | null>(null)
  const [lastUrl, setLastUrl] = useState<string | null>(null)
  // Bumped on wake when fit/refresh cannot revive a blank xterm canvas
  // (GPU compositor reset after OS sleep) — remounts the effect so open+pty
  // reattach cleanly. Alt-tab alone does not bump: only a detected dead grid.
  const [remountToken, setRemountToken] = useState(0)
  // One hard remount per hide→show cycle so a persistently broken host
  // cannot spin remountToken on every visibility tick.
  const wakeRemountedRef = useRef(false)
  const connectRef = useRef<(() => void) | null>(null)
  const storeRef = useRef(store)
  storeRef.current = store

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    if (!visible) {
      setConnected(false)
      return
    }
    // A successful mount after a wake remount clears the one-shot latch.
    wakeRemountedRef.current = false
    const liveStore = storeRef.current
    // The custom font prefs (side card settings, terminal card) resolve at
    // mount; store changes re-apply them live below.
    const font = resolveTerminalFont(liveStore.getPrefs(), tokenValue('--ds-font-family-code'))
    const term = new Terminal({
      cursorBlink: true,
      fontSize: font.fontSize,
      fontFamily: font.fontFamily,
      // Transparent backgrounds go blank after Chromium/Electron GPU sleep
      // more often than opaque ones; the panel already paints an opaque
      // surface behind the host.
      allowTransparency: false,
      convertEol: false,
      scrollback: 4000,
      theme: xtermTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // Ctrl+Click (Cmd+Click on mac) opens http(s) URLs printed in the
    // pty stream — a plain click is left for xterm's text-selection
    // gesture. Only http(s) is dispatched; file:// / mailto: / etc. are
    // underlined for visibility but rejected at activation. See
    // terminal-links.ts for the line scanner, modifier gate and scheme
    // guard.
    const linkProvider = term.registerLinkProvider({
      provideLinks: (lineNumber, callback) => {
        // xterm's `provideLinks` hands us a 1-based buffer line number
        // (its own built-in ILinkProvider does `buffer.lines.get(e - 1)`,
        // i.e. the public `bufferLineNumber` is 1-based while `getLine`
        // takes a 0-based index). Passing `lineNumber` straight through
        // would fetch the row *below* the one xterm asked us to scan, so
        // the URL text would come from the wrong row while `range.y` still
        // pointed at the requested row — links landed one line too high.
        const line = term.buffer.active.getLine(lineNumber - 1)
        if (line === undefined) {
          callback(undefined)
          return
        }
        const descriptors = buildTerminalLinks(line.translateToString(true), lineNumber)
        if (descriptors.length === 0) {
          callback(undefined)
          return
        }
        callback(descriptors.map(descriptor => ({
          range: descriptor.range,
          text: descriptor.text,
          activate: (event) => {
            if (!shouldActivateTerminalLink(event)) return
            openTerminalUrl(descriptor.text)
          },
        })))
      },
    })
    // Re-theme in place when the app's scheme flips (tokens + palette).
    const applyTheme = (): void => {
      term.options.theme = xtermTheme()
      term.refresh(0, term.rows - 1)
    }
    const schemeSub = subscribeColorScheme(applyTheme)

    let link: PtyLink | null = null
    let linkOpen = false
    let closed = false
    let retry: number | undefined
    let failures = 0

    // Agent terminals attach by uuid; UI-tab terminals by sessionId+tab(+cwd).
    const attachParams = (): URLSearchParams => {
      if (isAgentTabId(tabId)) {
        return new URLSearchParams({ uuid: agentUuidOf(tabId) })
      }
      const params = new URLSearchParams({ sessionId: scope.sessionId, tab: tabId })
      if (scope.cwd !== undefined && scope.cwd !== '') params.set('cwd', scope.cwd)
      return params
    }

    // FitAddon + ResizeObserver fire every layout frame while the user drags
    // a split. Unfiltered ConPTY resize thrash on Windows restarts cmd.exe
    // (repeats the 「Microsoft Windows [版本 …]」 MOTD). Coalesce to one
    // frame and skip no-op / zero-size fits.
    let lastSentCols = 0
    let lastSentRows = 0
    let resizeRaf = 0
    const sendResize = (): void => {
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        if (link === null || !linkOpen) return
        if (host.clientWidth < 2 || host.clientHeight < 2) return
        const cols = term.cols
        const rows = term.rows
        if (cols < 2 || rows < 2) return
        if (cols === lastSentCols && rows === lastSentRows) return
        lastSentCols = cols
        lastSentRows = rows
        link.send(JSON.stringify({ type: 'resize', cols, rows }))
      })
    }

    const connect = (): void => {
      if (closed) return
      link?.close()
      linkOpen = false
      const params = attachParams()
      link = openPtyLink(params, {
        onOpen: () => {
          failures = 0
          linkOpen = true
          lastSentCols = 0
          lastSentRows = 0
          setConnected(true)
          setFatal(null)
          sendResize()
        },
        onData: (data) => { term.write(data) },
        onClose: (event) => {
          linkOpen = false
          setConnected(false)
          // node-pty dependency missing/broken (issue #140): the host closed
          // with the short marker. Fetch the full repair details over HTTP —
          // a WS close reason is capped at 123 bytes, too small for the
          // pasteable command. A failed fetch falls back to the plain banner.
          if (event.code === 1011 && event.reason === PTY_DEPS_MISSING) {
            void api.terminalDeps().then((status) => {
              if (status.ok) {
                setFatal(t('terminalDepsFailed'))
                return
              }
              setFatal(null)
              setDepsFatal(status)
            }).catch(() => {
              setFatal(t('terminalDepsFailed'))
            })
            return
          }
          // Process exit on the HTTP carrier uses code 1000 + reason "exit" —
          // do not soft-reconnect (same rule as WS: never treat exit as drop).
          if (event.code === 1000 && event.reason === 'exit') return
          // Desktop Host restart / pipe 503 / mid-stream drop: soft-reconnect.
          // Do not pin a fatal banner over an already-painted MOTD.
          const hostTransient =
            (event.code === 1011 &&
              (/^HTTP 5\d\d$/u.test(event.reason) || /unavailable/iu.test(event.reason))) ||
            (event.code === 1006 && event.reason === '')
          if (event.code === 1011 && event.reason !== '' && !hostTransient) {
            setFatal(event.reason)
            return
          }
          failures += 1
          const limit = hostTransient ? HOST_RESTART_LIMIT : FAILURE_LIMIT
          if (failures >= limit) {
            const detail = event.reason !== '' ? ` (${event.code}: ${event.reason})` : ` (${event.code})`
            console.error('[xrkh-better-sidebar] terminal connection failed:', event.code, event.reason, link?.url)
            setFatal(`${t('terminalConnectFailed')}${detail}`)
            return
          }
          if (!closed) {
            const delay = hostTransient ? Math.min(2000 * failures, 8000) : 2000
            retry = window.setTimeout(connect, delay)
          }
        },
      })
      setLastUrl(link.url)
    }
    connectRef.current = connect

    const inputSub = term.onData((data) => {
      if (link !== null && linkOpen) link.send(data)
    })
    let opened = false
    let wakeFrame = 0
    let lastHostArea = 0

    /** Soft fit/refresh; hard remount once if the paint grid stays dead. */
    const revivePaint = (): void => {
      if (closed || !opened || term.element === undefined) return
      try {
        if (host.clientWidth < MIN_OPEN_SIZE || host.clientHeight < MIN_OPEN_SIZE) return
        fit.fit()
        sendResize()
        if (terminalPaintBroken(host, term)) {
          if (wakeRemountedRef.current) return
          wakeRemountedRef.current = true
          setRemountToken(token => token + 1)
          return
        }
        term.refresh(0, Math.max(0, term.rows - 1))
        // Nudge Chromium to recomposite the screen layer after GPU sleep /
        // off-screen open during the bottom-panel slide.
        const screen = term.element.querySelector('.xterm-screen')
        if (screen instanceof HTMLElement) {
          const prev = screen.style.transform
          screen.style.transform = 'translateZ(0)'
          void screen.offsetWidth
          screen.style.transform = prev
        }
      } catch {
        if (wakeRemountedRef.current) return
        wakeRemountedRef.current = true
        setRemountToken(token => token + 1)
      }
    }

    const observer = new ResizeObserver(() => {
      try {
        if (!opened) return
        const area = host.clientWidth * host.clientHeight
        // Growing out of a collapsed box (expand slide / unhide) clears the
        // one-shot remount latch so a dead grid can remount again.
        if (area >= MIN_OPEN_SIZE * MIN_OPEN_SIZE && lastHostArea < MIN_OPEN_SIZE * MIN_OPEN_SIZE) {
          wakeRemountedRef.current = false
        }
        lastHostArea = area
        fit.fit()
        sendResize()
        // Bottom-panel expand can leave a dead paint grid that fit alone
        // does not revive — remount once the host has a real box.
        if (
          host.clientWidth >= MIN_OPEN_SIZE
          && host.clientHeight >= MIN_OPEN_SIZE
          && terminalPaintBroken(host, term)
          && !wakeRemountedRef.current
        ) {
          wakeRemountedRef.current = true
          setRemountToken(token => token + 1)
        }
      } catch {
        // The terminal may be mid-dispose; ignore.
      }
    })
    observer.observe(host)

    // After OS sleep/wake the xterm canvas often goes blank (GPU compositor
    // reset) while the host size is unchanged — ResizeObserver stays quiet.
    const recoverAfterWake = (): void => {
      if (document.visibilityState === 'hidden') {
        wakeRemountedRef.current = false
        return
      }
      if (document.visibilityState !== 'visible' || closed) return
      if (wakeFrame !== 0) cancelAnimationFrame(wakeFrame)
      wakeFrame = requestAnimationFrame(() => {
        wakeFrame = requestAnimationFrame(() => {
          wakeFrame = 0
          revivePaint()
        })
      })
    }
    document.addEventListener('visibilitychange', recoverAfterWake)
    window.addEventListener('pageshow', recoverAfterWake)

    // Custom font prefs (the terminal card's secondary settings) apply LIVE:
    // on any store change re-resolve and diff the two options, re-fitting
    // when they moved (the grid dimensions may change with the font). The
    // subscribe fires on every store change (tabs, panels…), so the diff is
    // what keeps this cheap.
    const fontSub = liveStore.subscribe(() => {
      const next = resolveTerminalFont(liveStore.getPrefs(), tokenValue('--ds-font-family-code'))
      if (next.fontFamily !== term.options.fontFamily || next.fontSize !== term.options.fontSize) {
        term.options.fontFamily = next.fontFamily
        term.options.fontSize = next.fontSize
        try {
          fit.fit()
          sendResize()
        } catch {
          // The terminal may be mid-dispose; ignore.
        }
      }
    })

    // The terminal must not be opened in a zero-size container: xterm's
    // renderer creation fails there and the next Viewport refresh crashes
    // reading `.dimensions` off the undefined renderer (blank terminal on
    // WKWebView when the bottom panel's expand slide leaves the host at
    // height 0; any display:none-hidden ancestor does the same). Defer
    // open+fit until the host has a real size — writes arriving meanwhile
    // are buffered by xterm's WriteBuffer and render once open, and
    // FitAddon.fit() is a safe no-op before open. sendResize() here covers
    // the deferred path where the socket may already be open with the
    // default 80x24 dims.
    const cancelOpen = openWhenSized(host, () => {
      try {
        term.open(host)
        opened = true
        fit.fit()
        sendResize()
      } catch (error) {
        console.error('[xrkh-better-sidebar] xterm open failed:', error)
      }
    })

    connect()
    return () => {
      closed = true
      cancelOpen()
      window.clearTimeout(retry)
      if (resizeRaf !== 0) cancelAnimationFrame(resizeRaf)
      if (wakeFrame !== 0) cancelAnimationFrame(wakeFrame)
      document.removeEventListener('visibilitychange', recoverAfterWake)
      window.removeEventListener('pageshow', recoverAfterWake)
      observer.disconnect()
      fontSub()
      schemeSub()
      inputSub.dispose()
      // Three unmount cases, distinguished by the store's tab/open state and
      // the active session id:
      // 1. The tab was closed by the user (NOT in its session's state): send
      //    `{type:'close'}` — the host releases the pty immediately.
      // 2. The user switched to another conversation (the tab IS still open
      //    in scope.sessionId's state, but the active session is now a
      //    different one): send `{type:'park'}` — the host keeps the pty
      //    alive indefinitely (no grace countdown), so switching back
      //    reattaches the SAME shell. Without this, the bare socket drop
      //    would start the 30s reconnect-grace countdown and kill the shell
      //    while the user is still actively working in the other session.
      // 3. A same-session unmount (page refresh, crash, plugin teardown, a
      //    re-render that re-mounts the view): bare socket drop — the host's
      //    reconnect grace keeps the shell alive for a quick reconnect.
      // Agent terminals follow the close-frame rule; their lifetime is owned
      // by the agent, so a bare drop (case 3) already leaves them alive
      // indefinitely — no park frame needed.
      const tabStillOpen = liveStore.tabOpen(scope.sessionId, tabId)
      const sessionSwitched = liveStore.getSnapshot().sessionId !== scope.sessionId
      if (!tabStillOpen && link !== null && linkOpen) {
        link.send(JSON.stringify({ type: 'close' }))
      } else if (tabStillOpen && sessionSwitched && !isAgentTabId(tabId)
        && link !== null && linkOpen) {
        link.send(JSON.stringify({ type: 'park' }))
      }
      link?.close()
      linkProvider.dispose()
      term.dispose()
      connectRef.current = null
    }
  }, [scope.sessionId, scope.cwd, tabId, visible, remountToken])

  return (
    <div className={css.terminalWrap}>
      {depsFatal !== null && (
        <TerminalDepsBanner deps={depsFatal} onRetry={() => { setDepsFatal(null); connectRef.current?.() }} />
      )}
      {fatal !== null && (
        <div className={css.terminalBanner}>
          {t('terminalError')}: {fatal}
          {lastUrl !== null && <div className={css.terminalBannerUrl}>{lastUrl}</div>}
          <button
            type="button"
            className={css.terminalRetry}
            onClick={() => { setFatal(null); connectRef.current?.() }}
          >
            {t('terminalRetry')}
          </button>
        </div>
      )}
      {fatal === null && depsFatal === null && !connected && <div className={css.terminalBanner}>{t('disconnected')}</div>}
      <div ref={hostRef} className={css.terminal} />
    </div>
  )
}

/**
 * The node-pty dependency failure banner (issue #140): explains that the
 * terminal's native dependency failed to load and shows the PASTEABLE repair
 * command (bash / cmd / PowerShell) with a copy button — the user pastes it
 * into a terminal where their DSH profile lives and runs it, then retries.
 * Extracted as a standalone component for direct testing.
 */
export function TerminalDepsBanner(props: { deps: TerminalDepsInfo; onRetry: () => void }) {
  const { deps, onRetry } = props
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    const written = await writeClipboard(deps.command)
    if (written) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <div className={css.terminalDepsBanner}>
      <div className={css.terminalDepsTitle}>{t('terminalDepsFailed')}</div>
      <div className={css.terminalDepsHint}>
        {t('terminalDepsHint')}
        {deps.profile !== null ? t('terminalDepsProfile', { profile: deps.profile }) : ''}
      </div>
      <div className={css.terminalDepsCommandRow}>
        <pre className={css.terminalRepairCommand}>{deps.command}</pre>
        <button type="button" className={css.terminalRetry} onClick={() => { void copy() }} aria-label={t('copy')}>
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      {deps.note !== undefined && <div className={css.terminalDepsNote}>{deps.note}</div>}
      <div className={css.terminalDepsActions}>
        <button type="button" className={css.terminalRetry} onClick={onRetry}>
          {t('terminalRetry')}
        </button>
      </div>
    </div>
  )
}
