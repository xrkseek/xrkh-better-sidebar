/**
 * File-tree "open with" vocabulary — multi-end.
 *
 * Three axes (do not conflate them):
 *
 * 1. **Carrier** — Phone APK thin shell (`XrkShell`) vs ordinary browser /
 *    Desktop. APK owns share/download in Flutter; never paint a Face IDE list.
 * 2. **Privilege** — Face `isLoopback` + `canOpenPath`. Remote Web (phone or
 *    desktop browser → a server) must not offer Host-machine OS open.
 * 3. **Chrome width** — `LayoutInsets.phone` / narrow viewport (&lt;768). Only
 *    flattens the menu (no sideways submenu). Narrow desktop still gets
 *    Face-probed editors when loopback.
 *
 * | Surface                         | Reveal | Host editors | Custom URL | Menu shape |
 * |---------------------------------|--------|--------------|------------|------------|
 * | Phone APK (`thinShell`)         | never  | never        | never      | — (hidden) |
 * | Remote Web (!loopback)          | never  | never        | never      | — (hidden) |
 * | Local Web / Desktop             | if canOpenPath≠false | Face probe | yes | nested if room |
 * | Same + phone/narrow chrome      | same   | same         | same       | flat       |
 * | SSH workspace                   | never  | → vscode-remote URL | VSCode-fam | — |
 *
 * Editors are **auto-detected** via Face `listOpenInApps`. No hardcoded
 * “always show VS Code / Cursor / Zed” list.
 */
import type { CopyKey } from './locales.ts'

/** One user-configured editor (persisted in `pluginSettings['editor'].openWith`). */
export interface CustomEditor {
  id: string
  /** Human label shown in the menu (e.g. "Windsurf"). */
  name: string
  /** URL template with a `{path}` placeholder (e.g. `windsurf://file/{path}`). */
  urlTemplate: string
  /** Whether the editor speaks the VSCode URL dialect — SSH-remote form. */
  isVscodeFamily: boolean
}

/** Per-user open-with configuration (one key of the editor blob). */
export interface OpenWithConfig {
  /** SSH host (user@host or ~/.ssh/config alias); '' = local workspace. */
  sshHost: string
  /** User-defined editors, appended after Host-probed apps. */
  customEditors: CustomEditor[]
  /** Ids pinned to the menu's top level. */
  pinned: string[]
}

/** One menu-visible open target. */
export interface OpenWithTarget {
  /** Stable id (`explorer` / Face app id / `custom:<id>`). */
  id: string
  /** Locale key for Host-known labels (custom editors use `name`). */
  nameKey?: CopyKey
  /** User-defined label (custom only). */
  name: string
  /**
   * `reveal` — OS file manager via Face openPath.
   * `host` — Face `host.openInApp` (local probed editor argv).
   * `url` — custom scheme or SSH vscode-remote URL.
   */
  kind: 'reveal' | 'host' | 'url'
  /** URL template with `{path}`; only for `url`. */
  urlTemplate?: string
  /** VSCode URL dialect (SSH remote form). */
  isVscodeFamily: boolean
  /** Hidden in SSH mode (cannot reach a remote path). */
  localOnly: boolean
  /** Face catalog id when launching via `host.openInApp`. */
  hostAppId?: string
}

/**
 * Runtime surface for multi-end gating.
 *
 * Built by {@link ./open-with-surface.ts} from LayoutInsets + viewport + Face
 * + Flutter `XrkShell` (APK thin shell).
 */
export interface OpenWithSurface {
  /**
   * AppFrame phone chrome (`data-xrk-layout-phone` / viewport &lt;768).
   * Width-only — true on APK, phone Safari, and a resized desktop window.
   * Affects menu shape, not “hide all Host editors”.
   */
  phone?: boolean
  /** Viewport width &lt; 768 — same flat-menu hint as `phone`. */
  narrow?: boolean
  /**
   * Flutter phone thin shell injected `XrkShell.postMessage`. Ordinary
   * browsers never have this — use it to tell APK apart from phone Web.
   */
  thinShell?: boolean
  /**
   * Privileged local plane (same machine as Host). Remote browsers must not
   * offer OS open — mirrors Overview `ui-open-in-app` `isLoopback` gate.
   * `undefined` = unknown (treat as local for optimistic desktop).
   */
  loopback?: boolean
  /** Face `host.describe.canOpenPath`. */
  canOpenPath?: boolean
  /** Face `host.listOpenInApps` ids. `undefined` = not probed yet. */
  installedApps?: readonly string[]
}

export const OPEN_WITH_DEFAULTS: OpenWithConfig = {
  sshHost: '',
  customEditors: [],
  pinned: [],
}

/** Single reveal row — Host openPath, not a duplicate file-manager app entry. */
export const OPEN_WITH_REVEAL: OpenWithTarget = {
  id: 'explorer',
  nameKey: 'openWithExplorer',
  name: '',
  kind: 'reveal',
  isVscodeFamily: false,
  localOnly: true,
}

/**
 * Face catalog ids that belong on a *file* row. Terminals / file-managers are
 * skipped (reveal covers the manager; terminals do not open a file usefully).
 * Labels only — membership comes from Face probe, not this map alone.
 */
const HOST_FILE_EDITORS: Readonly<Record<string, {
  nameKey: CopyKey
  isVscodeFamily: boolean
  /** Scheme template used only to synthesize SSH vscode-remote URLs. */
  urlTemplate: string
}>> = {
  vscode: {
    nameKey: 'openWithVscode',
    isVscodeFamily: true,
    urlTemplate: 'vscode://file/{path}',
  },
  cursor: {
    nameKey: 'openWithCursor',
    isVscodeFamily: true,
    urlTemplate: 'cursor://file/{path}',
  },
}

/** @deprecated Use {@link OPEN_WITH_REVEAL}; kept for transitional imports. */
export const OPEN_WITH_BUILTINS: readonly OpenWithTarget[] = [OPEN_WITH_REVEAL]

function isCustomEditor(value: unknown): value is CustomEditor {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && record.id !== ''
    && typeof record.name === 'string'
    && typeof record.urlTemplate === 'string'
    && typeof record.isVscodeFamily === 'boolean'
}

export function parseOpenWithConfig(raw: unknown): OpenWithConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...OPEN_WITH_DEFAULTS }
  const record = raw as Record<string, unknown>
  const sshHost = typeof record.sshHost === 'string' ? record.sshHost : ''
  const customEditors = Array.isArray(record.customEditors)
    ? record.customEditors.filter(isCustomEditor)
    : []
  const pinned = Array.isArray(record.pinned)
    ? record.pinned.filter((id): id is string => typeof id === 'string' && id !== '')
    : []
  return { sshHost, customEditors, pinned }
}

function customIdOf(id: string): string {
  return `custom:${id}`
}

/** Build Host-probed editor targets from Face `listOpenInApps`. */
export function hostProbedEditorTargets(
  installedApps: readonly string[] | undefined,
  ssh: boolean,
): OpenWithTarget[] {
  if (installedApps === undefined) return []
  const out: OpenWithTarget[] = []
  for (const appId of installedApps) {
    const meta = HOST_FILE_EDITORS[appId]
    if (meta === undefined) continue
    if (ssh) {
      out.push({
        id: appId,
        nameKey: meta.nameKey,
        name: '',
        kind: 'url',
        urlTemplate: meta.urlTemplate,
        isVscodeFamily: meta.isVscodeFamily,
        localOnly: false,
        hostAppId: appId,
      })
    } else {
      out.push({
        id: appId,
        nameKey: meta.nameKey,
        name: '',
        kind: 'host',
        isVscodeFamily: meta.isVscodeFamily,
        localOnly: false,
        hostAppId: appId,
      })
    }
  }
  return out
}

/**
 * Whether this surface may offer any OS / Host open actions at all.
 * - Remote Web (`!loopback`): Host apps are on the server — never.
 * - Phone APK thin shell: Flutter share / Download — never Face IDE list.
 * - `phone` chrome alone does **not** deny (narrow desktop / phone Web local).
 */
export function openWithSurfaceAllowsOs(surface: OpenWithSurface): boolean {
  if (surface.thinShell === true) return false
  if (surface.loopback === false) return false
  return true
}

/**
 * Menu-visible targets for the current end + OS capability.
 * Never invents vscode/cursor/zed without a Face probe.
 */
export function resolveOpenWithTargets(
  config: OpenWithConfig,
  surface: OpenWithSurface = {},
): OpenWithTarget[] {
  if (!openWithSurfaceAllowsOs(surface)) return []

  const ssh = config.sshHost.trim() !== ''
  const canOpen = surface.canOpenPath
  const targets: OpenWithTarget[] = []

  // Local Web / Desktop: reveal when canOpenPath is true or still unknown
  // (describe may lag); deny when Face said false.
  if (canOpen !== false && !(ssh && OPEN_WITH_REVEAL.localOnly)) {
    targets.push(OPEN_WITH_REVEAL)
  }

  targets.push(...hostProbedEditorTargets(surface.installedApps, ssh))

  for (const editor of config.customEditors.filter(isValidCustomEditor)) {
    const target: OpenWithTarget = {
      id: customIdOf(editor.id),
      name: editor.name,
      kind: 'url',
      urlTemplate: editor.urlTemplate,
      isVscodeFamily: editor.isVscodeFamily,
      localOnly: !editor.isVscodeFamily,
    }
    if (ssh && target.localOnly) continue
    targets.push(target)
  }

  return targets
}

/**
 * Apply surface gates to an already-built list (tests / composition).
 * Prefer {@link resolveOpenWithTargets} for the full pipeline.
 */
export function filterOpenWithBySurface(
  targets: readonly OpenWithTarget[],
  surface: OpenWithSurface = {},
): OpenWithTarget[] {
  if (!openWithSurfaceAllowsOs(surface)) return []
  const canOpen = surface.canOpenPath
  const installed = surface.installedApps
  return targets.filter((target) => {
    if (target.kind === 'reveal') return canOpen !== false
    if (target.kind === 'host' && installed !== undefined && target.hostAppId !== undefined) {
      return installed.includes(target.hostAppId)
    }
    return true
  })
}

/**
 * Flatten menus on phone, narrow viewports, or short lists — nested submenu
 * cards open sideways and spill past APK / split-pane edges.
 */
export function preferFlatOpenWithMenu(
  targets: readonly OpenWithTarget[],
  surface: OpenWithSurface = {},
): boolean {
  if (surface.phone === true) return true
  if (surface.narrow === true) return true
  if (targets.length <= 2) return true
  return targets.every(target => target.kind === 'reveal')
}

export function openWithSshActive(config: OpenWithConfig): boolean {
  return config.sshHost.trim() !== ''
}

/** URL for a `url` target; Host/`reveal` go through Face instead. */
export function openWithUrl(target: OpenWithTarget, path: string, config: OpenWithConfig): string | undefined {
  if (target.kind !== 'url' || target.urlTemplate === undefined) return undefined
  const normalized = normalizeUrlPath(path)
  const ssh = openWithSshActive(config)
  if (ssh && target.isVscodeFamily) {
    const scheme = schemeOf(target.urlTemplate)
    if (scheme === undefined) return undefined
    return `${scheme}://vscode-remote/ssh-remote+${config.sshHost.trim()}${normalized}`
  }
  if (!target.urlTemplate.includes('{path}') || !hasUrlScheme(target.urlTemplate)) return undefined
  return target.urlTemplate.replace('{path}', normalized)
}

function hasUrlScheme(template: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(template)
}

function schemeOf(template: string): string | undefined {
  const at = template.indexOf(':')
  if (at <= 0) return undefined
  const scheme = template.slice(0, at)
  return /^[a-z][a-z0-9+.-]*$/i.test(scheme) ? scheme : undefined
}

export function normalizeUrlPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function newCustomEditorId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

export function isValidCustomEditor(row: { name: string; urlTemplate: string }): boolean {
  return row.name.trim() !== ''
    && row.urlTemplate.includes('{path}')
    && /^[a-z][a-z0-9+.-]*:\/\//i.test(row.urlTemplate.trim())
}
