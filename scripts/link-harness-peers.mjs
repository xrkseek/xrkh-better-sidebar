#!/usr/bin/env node
/**
 * Link @xrkseek peerDependencies from the parent harness checkout
 * (they are not on public npm). Writes `overrides:` into pnpm-workspace.yaml
 * (pnpm 11 ignores package.json `pnpm.overrides`). Strip before publish.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Prefer XRK_HARNESS when the plugin lives outside the monorepo tree
// (e.g. ~/.xrk/community-plugin-src/…); else assume ../../ is the harness root.
const harness = process.env.XRK_HARNESS
  ? path.resolve(process.env.XRK_HARNESS)
  : path.resolve(pluginRoot, '../..')
const pkgPath = path.join(pluginRoot, 'package.json')
const workspacePath = path.join(pluginRoot, 'pnpm-workspace.yaml')

function findPkg(name) {
  const roots = [path.join(harness, 'packages'), path.join(harness, 'apps')]
  const hits = []
  function walk(dir, depth) {
    if (depth > 5 || !existsSync(dir)) return
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue
      const next = path.join(dir, ent.name)
      const pj = path.join(next, 'package.json')
      if (existsSync(pj)) {
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'))
          if (pkg.name === name) hits.push(next)
        } catch { /* ignore */ }
      }
      walk(next, depth + 1)
    }
  }
  for (const root of roots) walk(root, 0)
  if (hits.length === 0) return undefined
  hits.sort((a, b) => a.length - b.length)
  return hits[0]
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
// Drop ignored package.json pnpm.overrides if a prior run left them.
if (pkg.pnpm !== undefined) {
  delete pkg.pnpm
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
}

const peers = Object.keys(pkg.peerDependencies ?? {}).filter((n) => n.startsWith('@xrkseek/'))
const links = []
const missing = []
for (const name of peers) {
  const dir = findPkg(name)
  if (dir === undefined) {
    missing.push(name)
    continue
  }
  links.push({ name, dir })
  console.log(`link ${name} -> ${path.relative(pluginRoot, dir)}`)
}
if (missing.length > 0) {
  console.error('missing peers in harness:', missing.join(', '))
  process.exit(1)
}

// Direct symlinks into node_modules (works even when pnpm ignores overrides).
const scopeDir = path.join(pluginRoot, 'node_modules', '@xrkseek')
mkdirSync(scopeDir, { recursive: true })
for (const { name, dir } of links) {
  const leaf = name.slice('@xrkseek/'.length)
  const target = path.join(scopeDir, leaf)
  rmSync(target, { recursive: true, force: true })
  symlinkSync(dir, target, 'junction')
}

// Keep workspace overrides for pnpm graph consistency on next install.
const overrideLines = links.map(({ name, dir }) => {
  const rel = path.relative(pluginRoot, dir).split(path.sep).join('/')
  return `  "${name}": link:${rel}`
})
const baseYaml = `packages:
  - .

allowBuilds:
  node-pty: true
  protobufjs: true

overrides:
${overrideLines.join('\n')}
`
writeFileSync(workspacePath, baseYaml)

const install = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['install', '--config.auto-install-peers=false', '--no-frozen-lockfile'],
  { cwd: pluginRoot, encoding: 'utf8', shell: false, env: { ...process.env, CI: 'true' } },
)
process.stdout.write(install.stdout ?? '')
process.stderr.write(install.stderr ?? '')
if (install.status !== 0) process.exit(install.status ?? 1)

// Re-stamp junctions after install (pnpm may clear the scope dir).
mkdirSync(scopeDir, { recursive: true })
for (const { name, dir } of links) {
  const leaf = name.slice('@xrkseek/'.length)
  const target = path.join(scopeDir, leaf)
  rmSync(target, { recursive: true, force: true })
  symlinkSync(dir, target, 'junction')
}
console.log(`peers linked (${links.length})`)
