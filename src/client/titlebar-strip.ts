/**
 * The title-bar strip resolution chain — the ONE place that decides how
 * many pixels the sidebar yields at the top. Standard signals first, then
 * the user's chosen scheme; never a per-shell branch:
 *
 *   0. `web` scheme — EXPLICIT "DSH official web": never adapt, not even
 *      standard WCO geometry (the user declares the plain web UI).
 *   1. Window Controls Overlay real geometry (standard API, authoritative
 *      when present — even 0, e.g. the overlay is hidden while maximized).
 *   2. The `dsh-desktop-titlebar-inset` URL contract parameter (a shell
 *      declares the exact pixels it reserves).
 *   3. XRK DesktopChrome CSS var `--xrk-desktop-chrome-height` (published
 *      on `<html>` by AppFrame when frameless chrome is present).
 *   4. The active shell preset's strip (scheme `preset` — opt-in data).
 *   5. The legacy manual `titleBarStripPx` (scheme `custom`).
 *   6. 0 — plain-browser semantics, nothing modified.
 *
 * The result drives `--dsh-title-bar-strip` + `body[data-dsh-title-bar-compat]`
 * exactly like the legacy boolean did; only the VALUE source changed.
 */
import type { DesktopEnv } from './desktop-env.ts'
import type { TitleBarScheme } from '../prefs-shared.ts'
import type { WcoSnapshot } from './wco.ts'
import { presetStripFor, type ShellPreset } from './shell-presets.ts'

/** Read AppFrame's published DesktopChrome height (0 when absent / SSR). */
function readXrkDesktopChromeHeight(): number {
  if (typeof document === 'undefined') return 0
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--xrk-desktop-chrome-height')
    .trim()
  if (!raw) return 0
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) && n > 0 && n <= 120 ? Math.round(n) : 0
}

export function computeTitleBarStrip(
  env: DesktopEnv,
  wco: WcoSnapshot,
  scheme: TitleBarScheme,
  preset: ShellPreset | undefined,
  customStripPx: number,
): number {
  if (scheme === 'web') return 0
  if (wco.present) return wco.height
  if (env.titlebarInset > 0) return env.titlebarInset
  const xrkChrome = readXrkDesktopChromeHeight()
  if (xrkChrome > 0) return xrkChrome
  if (scheme === 'preset') return presetStripFor(preset, env) ?? 0
  if (scheme === 'custom') return customStripPx
  return 0
}
