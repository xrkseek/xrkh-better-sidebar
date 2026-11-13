/**
 * Open-with pure logic: Face-probed editors + reveal + custom URLs; phone /
 * canOpenPath / SSH gates; no invented vscode/cursor/zed without a probe.
 */
import { describe, expect, it } from 'vitest'
import {
  hostProbedEditorTargets,
  isValidCustomEditor,
  newCustomEditorId,
  normalizeUrlPath,
  openWithSshActive,
  openWithUrl,
  parseOpenWithConfig,
  preferFlatOpenWithMenu,
  resolveOpenWithTargets,
  type CustomEditor,
} from '../src/client/open-with.ts'

describe('parseOpenWithConfig', () => {
  it('returns the defaults for null / non-object / array values', () => {
    expect(parseOpenWithConfig(null)).toEqual({ sshHost: '', customEditors: [], pinned: [] })
    expect(parseOpenWithConfig('junk')).toEqual({ sshHost: '', customEditors: [], pinned: [] })
    expect(parseOpenWithConfig([])).toEqual({ sshHost: '', customEditors: [], pinned: [] })
  })

  it('keeps structurally valid custom editors and drops junk', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [
        { id: 'a', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false },
        { id: 'b', name: '', urlTemplate: 'b://file/{path}', isVscodeFamily: true },
        'junk',
        null,
      ],
      pinned: ['vscode', 'custom:a', 42, ''],
    })
    expect(config.sshHost).toBe('dev')
    expect(config.customEditors.map(editor => editor.id)).toEqual(['a', 'b'])
    expect(config.pinned).toEqual(['vscode', 'custom:a'])
  })
})

describe('hostProbedEditorTargets', () => {
  it('emits host-kind rows for Face-probed editors (local)', () => {
    const targets = hostProbedEditorTargets(['explorer', 'cursor', 'vscode', 'windowsterminal'], false)
    expect(targets.map(t => t.id)).toEqual(['cursor', 'vscode'])
    expect(targets.every(t => t.kind === 'host')).toBe(true)
  })

  it('emits url-kind rows in SSH mode (vscode-remote needs a scheme)', () => {
    const targets = hostProbedEditorTargets(['cursor'], true)
    expect(targets).toHaveLength(1)
    expect(targets[0]?.kind).toBe('url')
    expect(targets[0]?.urlTemplate).toBe('cursor://file/{path}')
  })

  it('returns nothing before Face has probed', () => {
    expect(hostProbedEditorTargets(undefined, false)).toEqual([])
  })
})

describe('resolveOpenWithTargets', () => {
  const localCustom: CustomEditor = {
    id: 'e1', name: 'Windsurf', urlTemplate: 'windsurf://file/{path}', isVscodeFamily: false,
  }
  const familyCustom: CustomEditor = {
    id: 'e2', name: 'Fork', urlTemplate: 'x-fork://file/{path}', isVscodeFamily: true,
  }

  it('never invents IDE rows without a Face probe', () => {
    const targets = resolveOpenWithTargets(parseOpenWithConfig({}))
    expect(targets.map(t => t.id)).toEqual(['explorer'])
    expect(targets[0]?.kind).toBe('reveal')
  })

  it('adds Face-probed editors after reveal', () => {
    const targets = resolveOpenWithTargets(
      parseOpenWithConfig({ customEditors: [localCustom] }),
      { canOpenPath: true, installedApps: ['vscode', 'cursor'] },
    )
    expect(targets.map(t => t.id)).toEqual(['explorer', 'vscode', 'cursor', 'custom:e1'])
    expect(targets.find(t => t.id === 'vscode')?.kind).toBe('host')
  })

  it('drops reveal when Face says canOpenPath is false', () => {
    const targets = resolveOpenWithTargets(
      parseOpenWithConfig({}),
      { canOpenPath: false, installedApps: ['cursor'] },
    )
    expect(targets.map(t => t.id)).toEqual(['cursor'])
  })

  it('APK thinShell: empty — Flutter share/download, not a Face IDE list', () => {
    expect(resolveOpenWithTargets(
      parseOpenWithConfig({ customEditors: [localCustom] }),
      { thinShell: true, phone: true, canOpenPath: true, installedApps: ['cursor', 'vscode'] },
    )).toEqual([])
  })

  it('phone chrome alone (Safari / resized desktop) still offers Face targets', () => {
    expect(resolveOpenWithTargets(
      parseOpenWithConfig({ customEditors: [localCustom] }),
      { phone: true, canOpenPath: true, installedApps: ['cursor'] },
    ).map(t => t.id)).toEqual(['explorer', 'cursor', 'custom:e1'])
  })

  it('remote Web (!loopback): empty — phone or desktop browser to a server', () => {
    expect(resolveOpenWithTargets(
      parseOpenWithConfig({}),
      { phone: true, loopback: false, canOpenPath: true, installedApps: ['cursor'] },
    )).toEqual([])
    expect(resolveOpenWithTargets(
      parseOpenWithConfig({}),
      { loopback: false, canOpenPath: true, installedApps: ['cursor'] },
    )).toEqual([])
  })

  it('SSH drops local-only custom editors; Host editors become URL', () => {
    const config = parseOpenWithConfig({
      sshHost: 'dev',
      customEditors: [localCustom, familyCustom],
    })
    const targets = resolveOpenWithTargets(config, {
      canOpenPath: true,
      installedApps: ['vscode'],
    })
    expect(targets.map(t => t.id)).toEqual(['vscode', 'custom:e2'])
    expect(targets[0]?.kind).toBe('url')
  })

  it('prefers flat menus on phone/narrow chrome and with few targets', () => {
    expect(preferFlatOpenWithMenu([], { phone: true })).toBe(true)
    expect(preferFlatOpenWithMenu(
      resolveOpenWithTargets(parseOpenWithConfig({}), {
        canOpenPath: true,
        installedApps: ['cursor', 'vscode'],
      }),
      { narrow: true },
    )).toBe(true)
    const two = resolveOpenWithTargets(parseOpenWithConfig({}), {
      canOpenPath: true,
      installedApps: ['cursor'],
    })
    expect(preferFlatOpenWithMenu(two)).toBe(true)
  })
})

describe('openWithUrl', () => {
  it('builds SSH-remote URLs for VSCode-family targets', () => {
    const config = parseOpenWithConfig({ sshHost: 'dev' })
    const [cursor] = hostProbedEditorTargets(['cursor'], true)
    expect(openWithUrl(cursor!, '/home/u/f.ts', config))
      .toBe('cursor://vscode-remote/ssh-remote+dev/home/u/f.ts')
  })

  it('normalizes backslashes in local URL templates', () => {
    expect(normalizeUrlPath('C:\\Users\\u\\f.ts')).toBe('C:/Users/u/f.ts')
  })

  it('openWithSshActive tracks the ssh host field', () => {
    expect(openWithSshActive(parseOpenWithConfig({ sshHost: 'dev' }))).toBe(true)
    expect(openWithSshActive(parseOpenWithConfig({}))).toBe(false)
  })
})

describe('custom editor validators', () => {
  it('accepts a filled name + scheme://{path} template', () => {
    expect(isValidCustomEditor({ name: 'Windsurf', urlTemplate: 'windsurf://file/{path}' })).toBe(true)
    expect(isValidCustomEditor({ name: '', urlTemplate: 'x://file/{path}' })).toBe(false)
    expect(isValidCustomEditor({ name: 'X', urlTemplate: 'no-scheme/{path}' })).toBe(false)
  })

  it('mints a non-empty custom id', () => {
    expect(newCustomEditorId().length).toBeGreaterThan(4)
  })
})
