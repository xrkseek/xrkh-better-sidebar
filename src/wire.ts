/**
 * Wire helpers for the /sidebar JSON API: bounded body reading, response
 * writing, and the shared error envelope. Every API method returns
 * `{ok: true, value}` on success and `{ok: false, error: {code, message}}`
 * (HTTP 4xx/5xx matching the code) on failure.
 */
import type { SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** Machine-readable error codes of the sidebar API. */
export type SidebarErrorCode =
  | 'bad-request'
  | 'not-found'
  | 'forbidden'
  | 'method-error'
  | 'too-large'
  | 'fs-error'
  | 'git-error'
  | 'pty-error'
  | 'pty-deps-missing'
  | 'job-error'
  | 'subagents-unavailable'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'internal'

/** One API failure with its wire code and HTTP status. */
export class SidebarError extends Error {
  constructor(
    readonly code: SidebarErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Body size bound of one JSON request (defense against unbounded reads). */
const MAX_BODY_BYTES = 1 << 20

/** Success envelope of one API method. */
export interface SidebarOk<T> { ok: true; value: T }

/** Failure envelope of one API method. */
export interface SidebarErr { ok: false; error: { code: SidebarErrorCode; message: string } }

/** Read and parse the JSON request body (bounded; malformed → bad-request). */
export async function readJsonBody(req: SidebarHttpRequest): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    // The structural request yields string | Uint8Array; Buffer.from accepts
    // both (and the real runtime chunks are node Buffers anyway).
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new SidebarError('bad-request', 'request body too large')
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new SidebarError('bad-request', 'request body is not valid JSON')
  }
}

/** Write a JSON response with the given status. */
export function writeJson(res: SidebarHttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

/** Write the success envelope. */
export function writeOk(res: SidebarHttpResponse, value: unknown): void {
  writeJson(res, 200, { ok: true, value })
}

/** Write the failure envelope for any thrown value (unknown → internal 500). */
export function writeError(res: SidebarHttpResponse, error: unknown): void {
  if (error instanceof SidebarError) {
    writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

/** Narrow an unknown payload value to a string, else throw bad-request. */
export function requireString(payload: unknown, key: string): string {
  const record = payload as Record<string, unknown> | null
  const value = record?.[key]
  if (typeof value !== 'string' || value === '') {
    throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

/**
 * A bounded array of non-empty strings, else bad-request.
 *
 * The bound is a HOST-side resource budget, not a nicety: the batch routes
 * fan out to one `opendir` / one watch handle per element, so an unbounded
 * array would let a single request walk the workspace.
 *
 * @param payload - the parsed request body.
 * @param key - the member to narrow.
 * @param limit - maximum element count (exceeding it is bad-request).
 * @returns the member as a string array (the caller's own array, not a copy).
 */
export function requireStringArray(payload: unknown, key: string, limit: number): string[] {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (!Array.isArray(value) || value.length > limit || value.some(item => typeof item !== 'string' || item === '')) {
    throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  }
  return value as string[]
}

/**
 * Like {@link requireStringArray} but optional: an absent member (or null)
 * yields an empty array, so a caller can pass a genuinely optional list.
 */
export function optionalStringArray(payload: unknown, key: string, limit: number): string[] {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (value === undefined || value === null) return []
  return requireStringArray(payload, key, limit)
}

/**
 * A finite non-negative number, else bad-request; an absent member yields
 * `fallback`. A NaN/Infinity `since` cursor would silently make every watch
 * round look like a fresh subscribe, so the guard is strict on purpose.
 */
export function optionalNumber(payload: unknown, key: string, fallback: number): number {
  const value = (payload as Record<string, unknown> | null)?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SidebarError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}
