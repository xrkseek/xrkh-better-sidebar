/**
 * Live multi-end surface for the file-tree "open with" menu.
 *
 * Axes (see `open-with.ts` matrix — do not conflate):
 * - **thinShell** — Flutter APK injected `XrkShell.postMessage` (≠ phone chrome)
 * - **phone / narrow** — AppFrame width chrome (&lt;768); flat menus only
 * - **loopback / canOpenPath / listOpenInApps** — Face privilege + OS probe
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context } from '../context-types.ts'
import { useNarrowViewport } from './breakpoints.ts'
import type { OpenWithSurface } from './open-with.ts'

type HostDescriptionSource = {
  getSnapshot(): { canOpenPath?: boolean } | null | undefined
  subscribe(listener: () => void): () => void
}

type FaceHostApi = {
  listOpenInApps: (
    body?: Record<string, never>,
  ) => Promise<{ result: { ok: true; value: { apps: readonly string[] } } | { ok: false } }>
}

type ConnectionService = {
  isLoopback?: boolean
  hostDescription?: HostDescriptionSource
  api?: { host?: FaceHostApi }
  connectionState?: {
    getSnapshot(): string | undefined
    subscribe(listener: () => void): () => void
  }
}

type XrkShellPort = { readonly postMessage?: (raw: string) => void }

/**
 * True only inside the Flutter phone thin shell. Ordinary browsers (including
 * phone Safari hitting a Host) never inject a usable `XrkShell.postMessage`.
 */
export function readPhoneThinShell(): boolean {
  try {
    const shell = (globalThis as { XrkShell?: XrkShellPort }).XrkShell
    return typeof shell?.postMessage === 'function'
  } catch {
    return false
  }
}

function readPhone(ctx: Context): boolean {
  try {
    return ctx.layout.insets.getSnapshot().phone === true
  } catch {
    return false
  }
}

/** Soft-read Cordis `connection` (full ConnectionHandle when Host loaded it). */
export function readConnection(ctx: Context): ConnectionService | undefined {
  const withGet = ctx as Context & { get?: (name: string) => unknown }
  if (typeof withGet.get === 'function') {
    const viaGet = withGet.get('connection')
    if (viaGet !== undefined && viaGet !== null && typeof viaGet === 'object') {
      return viaGet as ConnectionService
    }
  }
  const narrow = ctx.connection
  if (narrow !== undefined && typeof narrow === 'object') {
    return narrow as ConnectionService
  }
  return undefined
}

/**
 * Subscribe to thinShell / phone / narrow / Face open capabilities.
 * Return value is memoized so consumers can depend on it safely.
 */
export function useOpenWithSurface(ctx: Context): OpenWithSurface {
  const thinShell = readPhoneThinShell()

  const phone = useSyncExternalStore(
    (callback) => {
      try {
        return ctx.layout.insets.subscribe(callback)
      } catch {
        return () => {}
      }
    },
    () => readPhone(ctx),
    () => false,
  )

  const narrow = useNarrowViewport()
  const connection = readConnection(ctx)

  const loopback = useSyncExternalStore(
    (callback) => {
      // isLoopback is a getter on ConnectionHandle — re-check on connect/describe.
      const state = connection?.connectionState
      const desc = connection?.hostDescription
      if (state === undefined && desc === undefined) return () => {}
      const unsubs: Array<() => void> = []
      if (state !== undefined) unsubs.push(state.subscribe(callback))
      if (desc !== undefined) unsubs.push(desc.subscribe(callback))
      return () => { for (const u of unsubs) u() }
    },
    () => {
      if (connection === undefined) return undefined
      if (typeof connection.isLoopback === 'boolean') return connection.isLoopback
      return undefined
    },
    () => undefined,
  )

  const canOpenPath = useSyncExternalStore(
    (callback) => {
      const desc = connection?.hostDescription
      if (desc === undefined) return () => {}
      return desc.subscribe(callback)
    },
    () => {
      if (thinShell) return false
      if (loopback === false) return false
      const snap = connection?.hostDescription?.getSnapshot()
      if (snap == null) return undefined
      return snap.canOpenPath === true
    },
    () => undefined,
  )

  const connected = useSyncExternalStore(
    (callback) => {
      const state = connection?.connectionState
      if (state === undefined) return () => {}
      return state.subscribe(callback)
    },
    () => connection?.connectionState?.getSnapshot() === 'connected',
    () => false,
  )

  const [installedApps, setInstalledApps] = useState<readonly string[] | undefined>(undefined)

  useEffect(() => {
    // APK thin shell + remote Web: never probe Face IDE catalog.
    if (thinShell || loopback === false) {
      setInstalledApps([])
      return
    }
    if (!connected) return
    if (canOpenPath !== true) {
      // Not privileged yet — clear probed list so we do not keep stale apps
      // after a reconnect that lost canOpenPath.
      setInstalledApps(undefined)
      return
    }
    const list = connection?.api?.host?.listOpenInApps
    if (typeof list !== 'function') return
    let cancelled = false
    void list({}).then((response) => {
      if (cancelled) return
      if (response.result.ok && Array.isArray(response.result.value.apps)) {
        setInstalledApps(response.result.value.apps.filter((id): id is string => typeof id === 'string'))
      } else {
        setInstalledApps([])
      }
    }).catch(() => {
      if (!cancelled) setInstalledApps(undefined)
    })
    return () => { cancelled = true }
  }, [connected, canOpenPath, connection, loopback, thinShell])

  return useMemo((): OpenWithSurface => ({
    phone,
    narrow,
    thinShell,
    ...(loopback !== undefined ? { loopback } : {}),
    ...(canOpenPath !== undefined ? { canOpenPath } : {}),
    ...(installedApps !== undefined ? { installedApps } : {}),
  }), [phone, narrow, thinShell, loopback, canOpenPath, installedApps])
}
