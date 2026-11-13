/**
 * Editor-header "Open with" control: same targets as the file-tree context
 * menu (Face-probed apps + reveal + custom), reachable from any file detail
 * view without hunting a tree row.
 */
import { useRef, useState, type ReactNode } from 'react'
import {
  IconChevronRightOutlineRegular, IconCodeOutlineRegular, Menu, type MenuEntry, type MenuItem,
} from '@xrkseek/client-ui-primitives'
import { SiCursor, SiZedindustries } from 'react-icons/si'
import { VscFolderOpened, VscLinkExternal, VscPin, VscPinned } from 'react-icons/vsc'
import { IconVscode16 } from './icons.tsx'
import type { OpenWithTarget } from './open-with.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'
import clsx from 'clsx'

export interface OpenWithToolbarButtonProps {
  path: string
  targets: readonly OpenWithTarget[]
  pinned: readonly string[]
  ssh: boolean
  /** Flatten to top-level rows (phone / few targets — no sideways submenu). */
  flat?: boolean
  onOpenWith: (targetId: string, path: string) => void
  onTogglePin?: (targetId: string) => void
}

function itemIcon(target: OpenWithTarget): ReactNode {
  if (target.kind === 'reveal') return <VscFolderOpened size={16} />
  if (target.id === 'vscode' || target.hostAppId === 'vscode') return <IconVscode16 size={16} />
  if (target.id === 'cursor' || target.hostAppId === 'cursor') return <SiCursor size={16} />
  if (target.id === 'zed' || /zed/i.test(target.name)) return <SiZedindustries size={16} />
  return <IconCodeOutlineRegular size={16} />
}

function labelOf(target: OpenWithTarget, ssh: boolean): string {
  const name = target.nameKey !== undefined ? t(target.nameKey) : target.name
  return ssh && !target.localOnly ? `${name}${t('openWithSshSuffix')}` : name
}

/** Toolbar button that opens the shared "Open with" menu for one absolute path. */
export function OpenWithToolbarButton(props: OpenWithToolbarButtonProps): ReactNode {
  const { path, targets, pinned, ssh, flat, onOpenWith, onTogglePin } = props
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  if (path === '' || targets.length === 0) return null

  const pinnedItems = targets
    .filter(target => pinned.includes(target.id))
    .map<MenuItem>(target => ({
      id: `open-with:${target.id}`,
      label: labelOf(target, ssh),
      icon: itemIcon(target),
    }))
  const reveal = targets.find(target => target.kind === 'reveal')
  const topLevel = reveal === undefined
    ? pinnedItems
    : [
        ...pinnedItems.filter(item => item.id !== `open-with:${reveal.id}`),
        {
          id: `open-with:${reveal.id}`,
          label: t('showInFolder'),
          icon: itemIcon(reveal),
        } satisfies MenuItem,
      ]

  let items: MenuEntry[]
  if (flat === true) {
    const flatRows = targets.map<MenuItem>(target => ({
      id: `open-with:${target.id}`,
      label: target.kind === 'reveal' ? t('showInFolder') : labelOf(target, ssh),
      icon: itemIcon(target),
    }))
    const seen = new Set(topLevel.map(item => item.id))
    items = [...topLevel, ...flatRows.filter(item => !seen.has(item.id))]
  } else {
    const submenu = targets.map<MenuItem>(target => {
      const pinnedNow = pinned.includes(target.id)
      return {
        id: `open-with:${target.id}`,
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{labelOf(target, ssh)}</span>
            {onTogglePin !== undefined && (
              <span
                role="button"
                tabIndex={-1}
                className={clsx(css.openWithPin, pinnedNow && css.openWithPinActive)}
                aria-label={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
                title={pinnedNow ? t('unpinOpenWith') : t('pinOpenWith')}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onTogglePin(target.id)
                }}
              >
                {pinnedNow ? <VscPinned size={14} /> : <VscPin size={14} />}
              </span>
            )}
          </span>
        ),
        icon: itemIcon(target),
      }
    })
    items = [
      ...topLevel,
      ...(topLevel.length > 0 ? [{ id: 'open-with-sep', type: 'separator' as const }] : []),
      {
        id: 'open-with-menu',
        label: (
          <span className={css.openWithLabel}>
            <span className={css.openWithName}>{t('openWithMenu')}</span>
            <IconChevronRightOutlineRegular size={14} className={css.openWithChevron} aria-hidden />
          </span>
        ),
        icon: <VscLinkExternal size={16} />,
        submenu,
      },
    ]
  }

  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      align="end"
      portal
      getAnchorRect={() => buttonRef.current?.getBoundingClientRect() ?? null}
      onSelect={(id) => {
        setOpen(false)
        if (!id.startsWith('open-with:')) return
        onOpenWith(id.slice('open-with:'.length), path)
      }}
      anchor={(
        <button
          ref={buttonRef}
          type="button"
          className={css.iconButton}
          aria-label={t('openWithMenu')}
          title={t('openWithMenu')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(prev => !prev) }}
        >
          <VscLinkExternal size={14} />
        </button>
      )}
    />
  )
}
