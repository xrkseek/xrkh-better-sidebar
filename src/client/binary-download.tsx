/**
 * The "no preview — download instead" pane: shown by the editor host when no
 * viewer can render a file (binary without a registered renderer, or the
 * `binary-download` strategy) and registered as the `binary-download` viewer
 * component so the declarative route and the host fallback share one UI.
 *
 * Phone APK thin shell: chat open wakes this pane for pptx/etc., but
 * `routeWorkspaceOpenFile` skips download after a successful wake — so we
 * auto-hand the file to `XrkShell` once (Flutter Downloads → share /
 * open-with). Desktop keeps the manual download link only.
 *
 * `notice` carries a transient failure from the "open with" menu (the action
 * is fire-and-forget, so a rejection would otherwise be invisible).
 */
import { useEffect, type ReactNode, type MouseEvent } from 'react'
import type { SessionScope } from './api.ts'
import { downloadBasename, downloadUrl, triggerBrowserDownload } from './api.ts'
import { readPhoneThinShell } from './open-with-surface.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function BinaryDownload(props: { scope: SessionScope; path: string; notice?: string }): ReactNode {
  const { scope, path, notice } = props
  const url = downloadUrl(scope, path)
  const name = downloadBasename(path)

  useEffect(() => {
    if (!readPhoneThinShell()) return
    void triggerBrowserDownload(url, name)
  }, [url, name])

  const onDownload = (event: MouseEvent<HTMLAnchorElement>): void => {
    // Prefer fetch→blob so iOS / Android Chrome actually save instead of navigating.
    event.preventDefault()
    void triggerBrowserDownload(url, name)
  }
  return (
    <div className={css.editorBinary}>
      {notice !== undefined && notice !== '' && (
        <span className={css.editorError}>{notice}</span>
      )}
      <span className={css.editorBinaryNotice}>{t('binaryNoPreview')}</span>
      <a
        className={css.editorDownloadLink}
        href={url}
        download={name}
        onClick={onDownload}
      >
        {t('downloadToView')}
      </a>
    </div>
  )
}
