/**
 * Copy pdf.js's module worker next to the lazy pdf chunk so /sidebar/bundle
 * can serve it same-origin (phone APK / offline Host cannot reach a CDN).
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const pdfjsRoot = dirname(require.resolve('pdfjs-dist/package.json'))
const src = join(pdfjsRoot, 'build', 'pdf.worker.min.mjs')
const destDir = join(root, 'lib')
const dest = join(destDir, 'client-pdf.worker.mjs')

if (!existsSync(src)) {
  throw new Error(`[xrkh-better-sidebar] pdf.js worker missing at ${src}`)
}
mkdirSync(destDir, { recursive: true })
copyFileSync(src, dest)
console.log(`[xrkh-better-sidebar] copied pdf worker → ${dest}`)
