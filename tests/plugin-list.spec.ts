/**
 * Built-in plugin catalog integrity: XRKH ships empty curated catalogs
 * (community entries are not bundled). Shape guards still apply when entries
 * are added later.
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
  it('ships empty curated catalogs (XRKH-native; no DSH marketplace bundle)', () => {
    expect(builtinTabPlugins).toEqual([])
    expect(builtinViewerPlugins).toEqual([])
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
