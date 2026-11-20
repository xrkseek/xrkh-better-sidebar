/**
 * Lazy chunk + static asset route: serves client split bundles and the PDF.js
 * worker under /sidebar/bundle/<name>. The official /plugins/<id>/client.js
 * route cannot serve arbitrary file names, so the plugin serves
 * lib/client-<name>.js (and lib/client-pdf.worker.mjs) here.
 *
 * Caching: `cache-control: no-cache` + ETag (content hash, memoized by
 * mtime/size) and If-None-Match 304. Same browser-trust fence as every other
 * /sidebar route; only allowlisted names are servable (no path traversal).
 */
import { createHash } from 'node:crypto'
import { stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, SidebarHttpRequest, SidebarHttpResponse } from './context-types.ts'

/** Lazy chunk names (mirror of src/client/chunk-loader.ts). */
export const CHUNK_NAMES = ['terminal', 'editor', 'mermaid', 'pdf'] as const
export type ChunkName = (typeof CHUNK_NAMES)[number]

/**
 * Extra static assets served next to chunks (not chunk factories).
 * Key = URL basename under /sidebar/bundle/; value = file under lib/.
 */
export const BUNDLE_ASSETS = {
  'pdf.worker.mjs': 'client-pdf.worker.mjs',
} as const
export type BundleAssetName = keyof typeof BUNDLE_ASSETS

/** Directory of this host-half module (lib/ — chunk scripts live next to it). */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** sha1 content hash shortened to 12 hex chars. */
function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

interface FileEtag {
  mtimeMs: number
  size: number
  etag: string
}

const etags = new Map<string, FileEtag>()

async function etagOf(filePath: string): Promise<string | undefined> {
  try {
    const info = await stat(filePath)
    const memo = etags.get(filePath)
    if (memo !== undefined && memo.mtimeMs === info.mtimeMs && memo.size === info.size) {
      return memo.etag
    }
    const etag = `"${shortHash(await readFile(filePath))}"`
    etags.set(filePath, { mtimeMs: info.mtimeMs, size: info.size, etag })
    return etag
  } catch {
    return undefined
  }
}

function resolveBundleFile(
  basename: string,
  chunkDir: string,
): { path: string; contentType: string } | undefined {
  if ((CHUNK_NAMES as readonly string[]).includes(basename.replace(/\.js$/, ''))) {
    const name = basename.replace(/\.js$/, '') as ChunkName
    if (basename !== `${name}.js`) return undefined
    return {
      path: join(chunkDir, `client-${name}.js`),
      contentType: 'text/javascript; charset=utf-8',
    }
  }
  const asset = (BUNDLE_ASSETS as Record<string, string>)[basename]
  if (asset === undefined) return undefined
  return {
    path: join(chunkDir, asset),
    // Module worker must be application/javascript (or text/javascript).
    contentType: 'text/javascript; charset=utf-8',
  }
}

/**
 * Build the /sidebar/bundle route handler. `fence` is the shared browser-
 * trust check; `chunkDir` is overridable for tests.
 */
export function createBundleRouteHandler(
  fence: (req: SidebarHttpRequest) => boolean,
  chunkDir: string = LIB_DIR,
): (req: SidebarHttpRequest, res: SidebarHttpResponse) => Promise<void> {
  return async (req, res): Promise<void> => {
    if (!fence(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const match = /^\/sidebar\/bundle\/([a-z0-9.-]+\.(?:js|mjs))$/.exec(pathname)
    const basename = match?.[1]
    const resolved = basename !== undefined ? resolveBundleFile(basename, chunkDir) : undefined
    if (resolved === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    const etag = await etagOf(resolved.path)
    if (etag === undefined) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'cache-control': 'no-cache', etag })
      res.end()
      return
    }
    try {
      const body = await readFile(resolved.path)
      res.writeHead(200, {
        'content-type': resolved.contentType,
        'cache-control': 'no-cache',
        etag,
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }
}

/** Register the /sidebar/bundle route (disposed with the fiber). */
export function registerBundleRoute(ctx: Context, fence: (req: SidebarHttpRequest) => boolean): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/sidebar/bundle',
    handler: createBundleRouteHandler(fence),
  })
}
