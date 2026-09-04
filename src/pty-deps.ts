/**
 * node-pty dependency loading for the host half (issue #140, plugin side).
 *
 * The terminal surfaces (UI tabs + model-facing terminal_* tools) need
 * node-pty, but the package must NEVER be imported statically at module
 * top level: a missing or broken install (pnpm 11's strict-dep-builds
 * skipping node-pty's install script, a pruned store entry, a failed
 * prebuilt-binary download…) would then fail the plugin module load and —
 * because a loader entry apply failure aborts the boot — take the whole
 * Host down with it.
 *
 * Instead the host half loads node-pty lazily (synchronously, via
 * createRequire). When the load fails the plugin stays mounted in a
 * degraded state: the terminal tab shows a friendly error carrying a
 * pasteable repair command, and the agent terminal tools are simply not
 * registered.
 *
 * Version contract: keep `"node-pty": "^1.1.0"` aligned with this package's
 * dependencies (and with Host `allowBuilds` for node-pty).
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type * as nodePtyNs from 'node-pty'
import { SidebarError } from './wire.ts'

/** The node-pty module surface the registries consume (spawn/kill/resize/…). */
export type NodePtyModule = typeof nodePtyNs

/**
 * The node-pty version range this plugin ships. Keep in sync with
 * package.json `dependencies["node-pty"]`.
 */
export const NODE_PTY_RANGE = '^1.1.0'

/** @deprecated Use {@link NODE_PTY_RANGE}. */
export const DSH_NODE_PTY_RANGE = NODE_PTY_RANGE

/**
 * The WebSocket close-code-1011 reason the host sends when node-pty is
 * unavailable. The client recognizes this exact marker and fetches the full
 * repair details from `/sidebar/api/terminal.deps` (a WS close reason is
 * capped at 123 bytes, so the command itself cannot ride the close frame).
 */
export const PTY_DEPS_MISSING = 'pty-deps-missing'

/** A require-compatible loader, injectable for tests. */
export type NodePtyRequire = (id: string) => unknown

const defaultRequire: NodePtyRequire = createRequire(import.meta.url)

type LoadResult = { ok: true; module: NodePtyModule } | { ok: false; cause: unknown }

let cached: LoadResult | undefined

/**
 * Load node-pty once (synchronously) and cache the outcome. Returns null
 * when the package or its native binding cannot be loaded; the cause stays
 * queryable through {@link nodePtyLoadCause}. Never throws.
 */
export function loadNodePty(requireImpl: NodePtyRequire = defaultRequire): NodePtyModule | null {
  if (cached === undefined) {
    try {
      cached = { ok: true, module: requireImpl('node-pty') as NodePtyModule }
    } catch (cause) {
      cached = { ok: false, cause }
    }
  }
  return cached.ok ? cached.module : null
}

/** The recorded load failure (undefined when the load succeeded or never ran). */
export function nodePtyLoadCause(): unknown {
  return cached !== undefined && !cached.ok ? cached.cause : undefined
}

/** Forget the cached outcome (tests only — a real reload is otherwise one-shot). */
export function resetNodePtyCache(): void {
  cached = undefined
}

/** Load node-pty or throw the canonical degraded-mode error (class-constructor default). */
export function loadRequiredNodePty(): NodePtyModule {
  const module = loadNodePty()
  if (module === null) {
    const cause = describeCause(nodePtyLoadCause())
    throw new SidebarError(
      'pty-deps-missing',
      `node-pty (${NODE_PTY_RANGE}) failed to load: ${cause} — run the repair command shown in the terminal tab`,
      503,
    )
  }
  return module
}

/** Resolve a directory to its physical location (symlinked/link: installs). */
function realDir(file: string): string {
  try {
    return dirname(realpathSync(file))
  } catch {
    return dirname(file)
  }
}

/** Walk up from `dir` looking for a profile / workspace root. */
function walkUp(dir: string, isRoot: (dir: string) => boolean): string | null {
  let current = dir
  for (let depth = 0; depth < 16; depth += 1) {
    if (isRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** Whether `dir` looks like a plugins workspace root (package.json + pnpm-workspace.yaml). */
function isProfileRoot(dir: string): boolean {
  return existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'pnpm-workspace.yaml'))
}

/**
 * Detect the install directory this plugin lives under: nearest ancestor
 * with both `package.json` and `pnpm-workspace.yaml`. Falls back to
 * `$XRK_HOME/plugins` when that tree looks like a workspace root.
 */
export function findProfileDir(fromFile: string = fileURLToPath(import.meta.url)): string | null {
  const detected = walkUp(realDir(fromFile), isProfileRoot)
  if (detected !== null) return detected
  const home = process.env.XRK_HOME !== undefined && process.env.XRK_HOME.trim() !== ''
    ? process.env.XRK_HOME
    : join(homedir(), '.xrk')
  const plugins = join(home, 'plugins')
  return isProfileRoot(plugins) ? realpathSync(plugins) : null
}

/** Whether `dir`'s package.json declares this plugin's name. */
function isPluginRoot(dir: string): boolean {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return false
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { name?: unknown }
    return parsed.name === 'xrkh-better-sidebar'
  } catch {
    return false
  }
}

/** The plugin package root (walk-up from the module; works for lib/ and src/ layouts). */
export function findPluginRoot(fromFile: string = fileURLToPath(import.meta.url)): string | null {
  return walkUp(realDir(fromFile), isPluginRoot)
}

/** Options for {@link buildRepairCommand}. */
export interface RepairCommandOptions {
  /** The plugin package root (where scripts/ live). */
  pluginRoot: string | null
  /** The detected plugins workspace directory (null → default hint). */
  profileDir: string | null
  /** Platform override for tests; defaults to the live process. */
  platform?: NodeJS.Platform
}

/**
 * The pasteable repair command for a broken node-pty install: rebuild in the
 * plugin package, or re-add via `xrkh plugin add`.
 */
export function buildRepairCommand(options: RepairCommandOptions): { command: string; note?: string } {
  const { pluginRoot } = options
  const platform = options.platform ?? process.platform
  if (pluginRoot !== null) {
    if (platform === 'win32') {
      return {
        command: `cd /d "${pluginRoot}" && pnpm rebuild node-pty`,
        note: 'Ensure pnpm-workspace allowBuilds includes node-pty, then hard-refresh the browser.',
      }
    }
    return {
      command: `cd "${pluginRoot}" && pnpm rebuild node-pty`,
      note: 'Ensure pnpm-workspace allowBuilds includes node-pty, then hard-refresh the browser.',
    }
  }
  return {
    command: 'xrkh plugin add xrkh-better-sidebar@latest && xrkh restart',
    note: 'If pnpm blocked node-pty\'s build script, set `allowBuilds: node-pty: true` in the install workspace then rebuild.',
  }
}

/** One-line human description of the recorded load cause. */
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

/** Structured status served by the `/sidebar/api/terminal.deps` endpoint. */
export type NodePtyDepsStatus =
  | { ok: true }
  | {
    ok: false
    /** The require-time error message (module missing, native binding broken…). */
    cause: string
    /** The pasteable repair command (terminal/cmd). */
    command: string
    /** The detected profile name (null when undetected → the command defaults to web). */
    profile: string | null
    /** Optional supplementary hint (fallback command only). */
    note?: string
  }

/** Current node-pty dependency status (loaded vs degraded + repair info). */
export function depsStatus(options: { fromFile?: string } = {}): NodePtyDepsStatus {
  const module = loadNodePty()
  if (module !== null) return { ok: true }
  const pluginRoot = findPluginRoot(options.fromFile)
  const profileDir = findProfileDir(options.fromFile)
  const { command, note } = buildRepairCommand({ pluginRoot, profileDir })
  return {
    ok: false,
    cause: describeCause(nodePtyLoadCause()),
    command,
    profile: profileDir !== null ? basename(profileDir) : null,
    ...(note !== undefined ? { note } : {}),
  }
}
