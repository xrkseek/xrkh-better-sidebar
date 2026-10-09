/**
 * The "no preview — download instead" pane: shown by the editor host when no
 * viewer can render a file (binary without a registered renderer, or the
 * `binary-download` strategy) and registered as the `binary-download` viewer
 * component so the declarative route and the host fallback share one UI.
 *
 * `notice` carries a transient failure from the "open with" menu (the action
 * is fire-and-forget, so a rejection would otherwise be invisible).
 */
import type { ReactNode } from 'react'
import type { SessionScope } from './api.ts'
import { downloadUrl } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function BinaryDownload(props: { scope: SessionScope; path: string; notice?: string }): ReactNode {
  const { scope, path, notice } = props
  return (
    <div className={css.editorBinary}>
      {notice !== undefined && notice !== '' && (
        <span className={css.editorError}>{notice}</span>
      )}
      <span className={css.editorBinaryNotice}>{t('binaryNoPreview')}</span>
      <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
        {t('downloadToView')}
      </a>
    </div>
  )
}