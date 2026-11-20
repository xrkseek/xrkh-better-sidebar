/**
 * Multi-end PDF preview shell: fetch bytes, fit-to-width zoom, page chrome,
 * download fallback. Painting lives in the lazy `pdf` chunk (PDF.js canvases)
 * so Android WebView / mobile browsers get a real preview instead of a blank
 * native-PDF iframe.
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import clsx from 'clsx'
import {
  downloadBasename, downloadUrl, mediaUrl, triggerBrowserDownload, type SessionScope,
} from './api.ts'
import { useNarrowViewport } from './breakpoints.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import {
  PDF_DEFAULT_ZOOM, PDF_MAX_ZOOM, PDF_MIN_ZOOM, nextPdfZoom,
} from './pdf-scale.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

interface PdfCanvasProps {
  data: ArrayBuffer
  title: string
  zoom: number
  stageWidth: number
  onPages?: (count: number) => void
  onVisiblePage?: (page: number) => void
}

const pickPdfCanvas = (mod: Record<string, unknown>): ComponentType<PdfCanvasProps> | undefined =>
  mod.PdfCanvasView as ComponentType<PdfCanvasProps> | undefined

const LazyPdfCanvas = lazyChunkComponent<PdfCanvasProps>('pdf', pickPdfCanvas)

export function PdfView(props: {
  scope: SessionScope
  path: string
  title: string
  /** Host-supplied media URL (mtime cache-bust). Falls back to a live build. */
  mediaUrl?: string
}) {
  const { scope, path, title } = props
  const source = props.mediaUrl ?? mediaUrl(scope, path)
  const narrow = useNarrowViewport()
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageWidth, setStageWidth] = useState(0)
  const [load, setLoad] = useState<
    | { status: 'loading' }
    | { status: 'ready'; data: ArrayBuffer }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [zoom, setZoom] = useState(PDF_DEFAULT_ZOOM)
  const [pages, setPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)

  useEffect(() => {
    const controller = new AbortController()
    setLoad({ status: 'loading' })
    setPages(0)
    setCurrentPage(1)
    setZoom(PDF_DEFAULT_ZOOM)
    void (async () => {
      try {
        const response = await fetch(source, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const bytes = await response.arrayBuffer()
        if (controller.signal.aborted) return
        setLoad({ status: 'ready', data: bytes })
      } catch (error) {
        if (controller.signal.aborted) return
        setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return () => {
      controller.abort()
    }
  }, [source])

  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const measure = (): void => {
      // clientWidth excludes the scrollbar — matches the paint width.
      setStageWidth(stage.clientWidth)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => {
      ro.disconnect()
    }
  }, [load.status])

  const download = (): void => {
    void triggerBrowserDownload(downloadUrl(scope, path), downloadBasename(path))
  }

  return (
    <div className={css.editorPdf}>
      <div className={css.editorPdfToolbar} role="toolbar" aria-label={t('viewerPdf')}>
        <div className={css.editorPdfToolbarGroup}>
          <button
            type="button"
            className={css.editorPdfButton}
            disabled={zoom <= PDF_MIN_ZOOM}
            aria-label={t('pdfZoomOut')}
            onClick={() => { setZoom((current) => nextPdfZoom(current, -1)) }}
          >
            −
          </button>
          <span className={css.editorPdfPosition} aria-live="polite">
            {pages > 0
              ? t('pdfPageOf', { current: currentPage, total: pages })
              : '– / –'}
          </span>
          <button
            type="button"
            className={css.editorPdfButton}
            disabled={zoom >= PDF_MAX_ZOOM}
            aria-label={t('pdfZoomIn')}
            onClick={() => { setZoom((current) => nextPdfZoom(current, 1)) }}
          >
            +
          </button>
          {!narrow && (
            <span className={css.editorPdfZoom}>{Math.round(zoom * 100)}%</span>
          )}
        </div>
        <div className={css.editorPdfToolbarGroup}>
          {narrow && (
            <span className={css.editorPdfZoom}>{Math.round(zoom * 100)}%</span>
          )}
          <button
            type="button"
            className={clsx(css.editorPdfButton, css.editorPdfDownloadBtn)}
            onClick={download}
          >
            {narrow ? t('pdfDownloadShort') : t('downloadToView')}
          </button>
        </div>
      </div>
      <div ref={stageRef} className={css.editorPdfStage}>
        {load.status === 'loading' && <div className={css.editorPlaceholder}>{t('loading')}</div>}
        {load.status === 'error' && (
          <div className={css.editorPdfErrorPane}>
            <div className={css.editorError}>{load.message}</div>
            <button type="button" className={css.editorPdfButton} onClick={download}>
              {t('downloadToView')}
            </button>
          </div>
        )}
        {load.status === 'ready' && stageWidth > 0 && (
          <LazyPdfCanvas
            data={load.data}
            title={title}
            zoom={zoom}
            stageWidth={stageWidth}
            onPages={setPages}
            onVisiblePage={setCurrentPage}
          />
        )}
      </div>
    </div>
  )
}
