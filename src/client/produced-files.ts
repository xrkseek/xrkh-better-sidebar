/**
 * Path resolution helpers for sidebar file opens.
 *
 * Turn-tail deliverables UI lives in first-party
 * `@xrkseek/client-ui-deliverables`; this module only resolves paths for the
 * openPath / explorer interception path.
 */
import { isAbsolutePath } from './paths.ts'

/**
 * Resolve a (possibly relative) path against the session cwd for the sidebar.
 * Absolute detection mirrors the host (see client/paths.isAbsolutePath):
 * POSIX roots, drive letters and UNC shares must not be joined onto the cwd.
 */
export function resolveSidebarPath(cwd: string | undefined, path: string): string {
  if (isAbsolutePath(path)) return path
  const base = cwd ?? ''
  if (base === '') return path
  const separator = base.includes('\\') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${path}`
}
