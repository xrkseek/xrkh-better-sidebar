/**
 * External open actions for the file tree's "open with" menu: hand a path to
 * the OS file manager (reveal/select) or launch a URL scheme's registered
 * handler (vscode://, cursor://, zed://, custom schemes).
 *
 * The client runs in a browser / DSH Desktop renderer where a raw `vscode://`
 * navigation is unreliable, so both actions fan out through this host route
 * and spawn the platform opener with an argv array (no shell interpolation).
 * The command builders are pure — the platform is injectable — so every
 * per-platform branch is unit-testable without spawning anything.
 *
 * On XRK-Harness product Host, `/sidebar` `open.external` is owned by Face
 * (`revealNativePath`); this module remains for Cordis profile mounts.
 */
import { spawn } from 'node:child_process'
import { parentOf, requireAbsolute } from './fs-tree.ts'
import { SidebarError } from './wire.ts'

/** The two external open actions the route accepts. */
export type OpenExternalAction = 'reveal' | 'url'

/** One platform opener invocation (argv array — never a shell string). */
export interface ExternalCommand {
  command: string
  args: string[]
  /** When false, the spawned process may map a GUI window (Win Explorer). */
  windowsHide?: boolean
}

/**
 * Win32 path for Explorer argv. Forward slashes must become `\`: Explorer
 * treats `/seg` after `/select,` as another switch, so reveal silently no-ops.
 */
export function windowsExplorerPath(target: string): string {
  return target.trim().replace(/\//g, '\\')
}

/** Reveal/select a path in the OS file manager. On Linux there is no common
 *  select protocol — the containing directory is opened instead (KISS). */
export function revealCommand(path: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: ['-R', path] }
    // Bare `explorer.exe /select,…` CreateProcess is a silent no-op when
    // Explorer is already the desktop shell (same class of bug as opening a
    // folder with explorer). Route through `cmd /c start` (ShellExecute);
    // windowsHide must be false or the folder window stays unmapped.
    // `/select,<path>` stays one argv token — no space after the comma.
    // Forward slashes → backslashes so Explorer does not eat path segments.
    case 'win32': {
      const winPath = windowsExplorerPath(path)
      return {
        command: 'cmd.exe',
        args: ['/c', 'start', '', 'explorer.exe', `/select,${winPath}`],
        windowsHide: false,
      }
    }
    default: {
      const parent = parentOf(path)
      return { command: 'xdg-open', args: [parent ?? path] }
    }
  }
}

/** Hand a custom-scheme URL to the OS protocol handler. */
export function urlCommand(url: string, platform: NodeJS.Platform = process.platform): ExternalCommand {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    // url.dll,FileProtocolHandler launches the registered protocol handler;
    // `cmd /c start "" <url>` is the fallback if rundll32 misbehaves.
    case 'win32':
      return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Validate an absolute URL for the OS opener: http(s) (HTML preview /
 *  browser tab → system browser), `file:`, or a custom scheme
 *  (`vscode://`, `cursor://`, `zed://`, …). */
export function validateExternalUrl(raw: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new SidebarError('bad-request', 'url must be an absolute URL')
  }
  try {
    // Reject malformed hosts / illegal characters; keep the original string
    // so custom schemes with braced placeholders (open-with templates) still
    // round-trip to the OS handler.
    void new URL(raw)
  } catch {
    throw new SidebarError('bad-request', 'invalid url')
  }
  return raw
}

/**
 * Launch one external open action and return immediately (detached, no
 * stdio). Spawn failures are reported through the child's 'error' event —
 * by then the route already returned, so the event is swallowed (the OS
 * dialog about a missing handler is the user-visible outcome either way).
 */
export function launchExternal(action: OpenExternalAction, value: string): { started: true } {
  const platform = process.platform
  const spec = action === 'reveal'
    ? revealCommand(requireAbsolute(value), platform)
    : urlCommand(validateExternalUrl(value), platform)
  const child = spawn(spec.command, spec.args, {
    detached: true,
    stdio: 'ignore',
    // Node default is false; win32 reveal sets false explicitly so the
    // Explorer window can map (CREATE_NO_WINDOW leaves it unmapped).
    ...(spec.windowsHide !== undefined ? { windowsHide: spec.windowsHide } : {}),
  })
  child.on('error', () => { /* opener missing/denied: handled by the OS */ })
  child.unref()
  return { started: true }
}
