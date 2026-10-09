/**
 * Office document previews (.pptx / .docx / .xlsx) rendered from the OOXML
 * parts by `office/*` — no LibreOffice, no network, no heavy viewer bundle.
 *
 * Fidelity is deliberately structural, not pixel-perfect: slides become a
 * paginated text+image card, a document becomes a formatted reading column, a
 * workbook becomes a scrollable table. That is the honest ceiling of a
 * client-side OOXML reader without a layout engine (the open-source
 * alternatives that do render faithfully either need a server or are
 * commercial). Layout, themes, charts and SmartArt are out of scope; each
 * pane says so instead of pretending.
 *
 * Bytes come through the host's normal download route (the same one the
 * "no preview" pane uses), so a file outside the workspace is refused by the
 * same fence before anything is parsed.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { downloadUrl, type SessionScope } from './api.ts'
import { parseDocx, type DocxDocument } from './office/docx.ts'
import { parsePptx, type PptxDeck } from './office/pptx.ts'
import { parseXlsx, type XlsxBook } from './office/xlsx.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

type OfficeKind = 'pptx' | 'docx' | 'xlsx'

/** Which parser a path needs (undefined = not an OOXML preview target). */
export function officeKindOf(path: string): OfficeKind | undefined {
  const at = path.lastIndexOf('.')
  if (at === -1) return undefined
  switch (path.slice(at + 1).toLowerCase()) {
    case 'pptx': return 'pptx'
    case 'docx': return 'docx'
    case 'xlsx': return 'xlsx'
    default: return undefined
  }
}

type OfficeLoad =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'pptx'; deck: PptxDeck }
  | { status: 'docx'; doc: DocxDocument }
  | { status: 'xlsx'; book: XlsxBook }

/** Fetch one file's raw bytes through the host download route. */
async function fetchBytes(scope: SessionScope, path: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(downloadUrl(scope, path), { signal })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * One image out of a deck, as a blob URL. Object URLs must be revoked or every
 * slide the user visits leaks its media for the life of the window.
 */
function OfficeImage(props: { image: { mime: string; bytes: Uint8Array; name: string } }): ReactNode {
  const { image } = props
  const url = useMemo(
    () => URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.mime })),
    [image],
  )
  useEffect(() => () => { URL.revokeObjectURL(url) }, [url])
  // EMF/WMF are vector metafiles (usually clip art): no browser can rasterise
  // them, and a broken-image glyph reads worse than the file name.
  if (image.mime === 'image/emf' || image.mime === 'image/wmf') {
    return <span className={css.officeImageFallback}>{image.name}</span>
  }
  return <img className={css.officeSlideImage} src={url} alt={image.name} />
}

function PptxView(props: { deck: PptxDeck }): ReactNode {
  const { deck } = props
  const [at, setAt] = useState(1)
  const total = deck.slides.length
  const slide = deck.slides.find(item => item.index === at) ?? deck.slides[0]
  const step = useCallback((delta: number) => {
    setAt(current => Math.min(Math.max(current + delta, 1), Math.max(total, 1)))
  }, [total])

  // Arrow keys page the deck, the way every presentation viewer behaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowRight' || event.key === 'PageDown') step(1)
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [step])

  if (slide === undefined) return <div className={css.editorPlaceholder}>{t('officeUnsupported')}</div>

  return (
    <div className={css.officePptx}>
      <div className={css.officePptxStage}>
        <article className={css.officeSlide}>
          <header className={css.officeSlideNumber}>
            {t('officeSlide', { n: slide.index })} / {total}
          </header>
          <div className={css.officeSlideBody}>
            {slide.texts.length === 0 && slide.images.length === 0 && (
              <span className={css.officeSlideEmpty}>{t('officeUnsupported')}</span>
            )}
            {slide.texts.map((line, i) => (
              // The first paragraph is almost always the title; render it as
              // one so a deck reads as a deck rather than a word list.
              <p key={i} className={i === 0 ? css.officeSlideTitle : css.officeSlideText}>{line}</p>
            ))}
            {slide.images.length > 0 && (
              <div className={css.officeSlideImages}>
                {slide.images.map(image => <OfficeImage key={image.name} image={image} />)}
              </div>
            )}
          </div>
        </article>
      </div>
      <div className={css.officePager}>
        <button type="button" className={css.iconButton} disabled={at <= 1} onClick={() => { step(-1) }}>
          {t('officePrev')}
        </button>
        <span className={css.officePagerLabel}>{slide.index} / {total}</span>
        <button type="button" className={css.iconButton} disabled={at >= total} onClick={() => { step(1) }}>
          {t('officeNext')}
        </button>
      </div>
      {slide.notes !== undefined && slide.notes !== '' && (
        <aside className={css.officeNotes}>
          <span className={css.officeNotesLabel}>{t('officeNotes')}</span>
          {slide.notes.split('\n').map((line, i) => <p key={i}>{line}</p>)}
        </aside>
      )}
    </div>
  )
}

function DocxView(props: { doc: DocxDocument }): ReactNode {
  const { doc } = props
  return (
    <div className={css.officeDocx}>
      <article className={css.officePage}>
        {doc.paragraphs.map((para, i) => {
          // Headings drive both the size and the anchor; a heading level is
          // 1..6, mapped onto h1..h6 semantics for screen readers.
          const Heading = para.level === undefined
            ? null
            : (`h${Math.min(Math.max(para.level, 1), 6)}` as keyof JSX.IntrinsicElements)
          if (Heading !== null) {
            return <Heading key={i} className={css.officeHeading} data-level={para.level}>{para.text}</Heading>
          }
          if (para.list !== undefined) {
            return (
              <div key={i} className={css.officeListItem}>
                <span className={css.officeListMarker} aria-hidden="true">{para.list === 'ordered' ? '1.' : '•'}</span>
                <span className={css.officeListText}>{para.text}</span>
              </div>
            )
          }
          return <p key={i} className={css.officeParagraph}>{para.text}</p>
        })}
      </article>
    </div>
  )
}

function XlsxView(props: { book: XlsxBook }): ReactNode {
  const { book } = props
  const [active, setActive] = useState(0)
  const sheet = book.sheets[active] ?? book.sheets[0]
  if (sheet === undefined) return <div className={css.editorPlaceholder}>{t('officeUnsupported')}</div>
  return (
    <div className={css.officeXlsx}>
      {book.sheets.length > 1 && (
        <div className={css.officeSheetTabs} role="tablist">
          {book.sheets.map((item, i) => (
            <button
              key={item.name}
              type="button"
              role="tab"
              aria-selected={i === active}
              className={clsx(css.officeSheetTab, i === active && css.officeSheetTabActive)}
              onClick={() => { setActive(i) }}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}
      <div className={css.officeGridWrap}>
        <table className={css.officeGrid}>
          <tbody>
            {sheet.rows.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => {
                  // The first row reads as a header when the sheet has one:
                  // every cell non-empty and no numeric-looking value.
                  const head = ri === 0 && row.every(value => value !== '' && !/^-?[\d.,]+$/.test(value))
                  return head
                    ? <th key={ci} className={css.officeGridHead}>{cell}</th>
                    : <td key={ci} className={css.officeGridCell}>{cell}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function OfficePreview(props: { scope: SessionScope; path: string; title?: string }): ReactNode {
  const { scope, path } = props
  const kind = officeKindOf(path)
  const [load, setLoad] = useState<OfficeLoad>({ status: 'loading' })
  const [retryTick, setRetryTick] = useState(0)

  useEffect(() => {
    if (kind === undefined) {
      setLoad({ status: 'error', message: t('officeUnsupported') })
      return
    }
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    void (async () => {
      try {
        const bytes = await fetchBytes(scope, path, controller.signal)
        if (controller.signal.aborted) return
        // Parse off the main flow: these are CPU-bound over an arbitrarily
        // large archive, so each kind is awaited before its state lands.
        if (kind === 'pptx') setLoad({ status: 'pptx', deck: await parsePptx(bytes) })
        else if (kind === 'docx') setLoad({ status: 'docx', doc: await parseDocx(bytes) })
        else setLoad({ status: 'xlsx', book: await parseXlsx(bytes) })
      } catch (error) {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => { controller.abort() }
  }, [scope.sessionId, scope.cwd, path, kind, retryTick])

  const download = (
    <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
      {t('officeDownload')}
    </a>
  )

  if (load.status === 'loading') {
    return (
      <div className={css.officeShell}>
        <div className={css.editorPlaceholder}>{t('officeConverting')}</div>
      </div>
    )
  }
  if (load.status === 'error') {
    return (
      <div className={css.officeShell}>
        <div className={css.officeError}>
          {t('officeFailed', { message: load.message })}
        </div>
        <div className={css.officeActions}>
          <button type="button" className={css.iconButton} onClick={() => { setRetryTick(tick => tick + 1) }}>
            {t('refresh')}
          </button>
          {download}
        </div>
      </div>
    )
  }
  return (
    <div className={css.officeShell}>
      {load.status === 'pptx' && <PptxView deck={load.deck} />}
      {load.status === 'docx' && <DocxView doc={load.doc} />}
      {load.status === 'xlsx' && <XlsxView book={load.book} />}
    </div>
  )
}