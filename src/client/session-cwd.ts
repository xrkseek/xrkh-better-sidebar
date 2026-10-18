/**
 * The one place the sidebar resolves a session's working directory.
 *
 * Two views of the cwd exist and they drift apart:
 *
 * - the **client list summary** — what chat-side path resolution joins
 *   against, refreshed only when the session list refreshes;
 * - the **host's authoritative `session.cwd`** — what the filesystem routes
 *   join against, updated the instant a `working_directory` call or a linked
 *   worktree moves the session.
 *
 * A session that moves updates the host immediately and the summary later, so
 * a path spelled against the stale summary points at a directory the session
 * has already left. The editor then opens that stale path and every read
 * answers "file missing" for a file the user can plainly see on disk.
 *
 * Everything that needs a cwd comes through here, so the drift has exactly one
 * fix point: prefer the host's answer, keep the summary as the first-paint
 * placeholder, and rebase paths spelled against the stale root.
 */
import { isAbsolutePath, relativeTo } from './paths.ts'
import { resolveSidebarPath } from './produced-files.ts'

/** Cwds the host reported for a session, keyed by session id. */
const hostCwds = new Map<string, string>()

/**
 * Record the host's authoritative cwd for a session.
 *
 * Called from every surface that asks the host (`api.sessionCwd`) so the
 * answer is available synchronously afterwards — the openPath interception
 * runs synchronously and cannot wait for a round trip.
 */
export function noteHostCwd(sessionId: string, cwd: string): void {
  if (sessionId === '' || cwd === '') return
  hostCwds.set(sessionId, cwd)
}

/** The host-reported cwd for a session, when it has been asked for. */
export function hostCwdOf(sessionId: string): string | undefined {
  return hostCwds.get(sessionId)
}

/**
 * The cwd the sidebar should resolve paths against: the host's answer first,
 * the list summary as the first-paint placeholder. `summaryCwd` is what the
 * caller saw in the session list and is only a stand-in until the host
 * replies.
 */
export function sessionCwdFor(sessionId: string | undefined, summaryCwd: string | undefined): string | undefined {
  if (sessionId === undefined) return summaryCwd
  return hostCwds.get(sessionId) ?? summaryCwd
}

/**
 * Re-spell a path that was built against `staleRoot` so it points at the same
 * place under `cwd`.
 *
 * Chat-side file opens join the *list summary* cwd, so the absolute path the
 * editor receives is pinned to a root the session may have left. Only the tail
 * below that root is stable, so swap the prefix. A path outside `staleRoot` is
 * genuinely its own thing (a linked worktree, another workspace) and travels
 * unchanged; so does a relative path, which the host joins onto the cwd it
 * owns anyway.
 */
export function rebasePath(cwd: string | undefined, staleRoot: string | undefined, path: string): string {
  if (cwd === undefined || staleRoot === undefined || staleRoot === '') return path
  if (!isAbsolutePath(path)) return path
  if (cwd === staleRoot) return path
  const tail = relativeTo(staleRoot, path)
  // `relativeTo` echoes the input when the path is not under the root.
  if (tail === path) return path
  return resolveSidebarPath(cwd, tail)
}