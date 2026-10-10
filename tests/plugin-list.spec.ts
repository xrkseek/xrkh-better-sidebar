/**
 * Built-in plugin catalog integrity: tab catalog stays empty (XRKH-native);
 * viewer catalog seeds the optional office preview plugin. Shape guards
 * apply to every entry.
 */
import { describe, expect, it } from 'vitest'
import { builtinTabPlugins } from '../src/client/plugins-tabs.ts'
import { builtinViewerPlugins } from '../src/client/plugins-viewers.ts'
import type { PluginEntry } from '../src/client/plugins-shared.ts'

/** Resolve an i18n-friendly string-or-function value (mirror of textOf). */
function textOf(value: string | (() => string)): string {
  return typeof value === 'function' ? value() : value
}

const catalogs: Array<[string, readonly PluginEntry[]]> = [
  ['tab catalog', builtinTabPlugins],
  ['viewer catalog', builtinViewerPlugins],
]

describe('builtin plugin catalogs', () => {
  it('seeds the office viewer plugin; tab catalog stays empty', () => {
    expect(builtinTabPlugins).toEqual([])
    expect(builtinViewerPlugins.map(p => p.id)).toEqual(['xrkh-better-sidebar-plugin-office'])
    expect(builtinViewerPlugins[0]?.install).toBe('xrkh plugin add xrkh-better-sidebar-plugin-office@0.1.0')
  })

  for (const [name, list] of catalogs) {
    describe(name, () => {
      it('every entry has a unique id (the npm package name)', () => {
        const ids = list.map(p => p.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const id of ids) {
          expect(id.length).toBeGreaterThan(0)
          expect(id).not.toContain(' ')
        }
      })

      it('every entry has a name, a GitHub URL, and an install script', () => {
        for (const entry of list) {
          expect(entry.name.length).toBeGreaterThan(0)
          expect(entry.url.startsWith('https://github.com/')).toBe(true)
          expect(entry.install.length).toBeGreaterThan(0)
          expect(entry.install).toMatch(/xrkh plugin|pnpm /)
        }
      })

      it('every description resolves to a non-empty localized string', () => {
        for (const entry of list) {
          expect(textOf(entry.description).length).toBeGreaterThan(0)
        }
      })
    })
  }
})
