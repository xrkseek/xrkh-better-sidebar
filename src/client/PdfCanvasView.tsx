/**
 * PDF.js canvas renderer for multi-end preview (Desktop, phone WebView,
 * mobile browsers). Android System WebView has no built-in PDF plugin — the
 * old iframe+blob path left a black stage. Loaded only via the `pdf` lazy
 * chunk so pdf.js stays out of the startup bundle.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import { PDF_WORKER_SOURCE } from 'virtual:pdf-worker'
import { fitScale } from './pdf-scale.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Optional HTTP fallback (kept for Hosts that already serve the asset). */
export const PDF_WORKER_URL = '/sidebar/bundle/pdf.worker.mjs'

/** Blob URL of the inlined worker — no second /sidebar/bundle hop (phone WebView). */
let workerBlobUrl: string | undefined

function pdfWorkerSrc(): string {
  if (workerBlobUrl === undefined) {
    // ESM worker: pdf.js 4 always constructs `new Worker(src, { type: 'module' })`.
    workerBlobUrl = URL.createObjectURL(
      new Blob([PDF_WORKER_SOURCE], { type: 'text/javascript' }),
    )
  }
  return workerBlobUrl
}

type DocState =
  | { status: 'loading' }
  | { status: 'ready'; pdf: PDFDocumentProxy; pages: number; pageWidthAt1: number }
  | { status: 'error'; message: string }

export function PdfCanvasView(props: {
  data: ArrayBuffer
  title: string
  /** User zoom relative to fit-width (1 = fill the stage). */
  zoom: number
  /** Preview stage content width in CSS px (from ResizeObserver). */
  stageWidth: number
  onPages?: (count: number) => void
  onVisiblePage?: (page: number) => void
}): ReactNode {
  const { data, title, zoom, stageWidth, onPages, onVisiblePage } = props
  const [doc, setDoc] = useState<DocState>({ status: 'loading' })
  const onPagesRef = useRef(onPages)
  const onVisibleRef = useRef(onVisiblePage)
  onPagesRef.current = onPages
  onVisibleRef.current = onVisiblePage
  const visibility = useRef(new Map<number, number>())

  useEffect(() => {
    let cancelled = false
    let pdf: PDFDocumentProxy | undefined
    setDoc({ status: 'loading' })
    void (async () => {
      try {
        const opened = await openPdfDocument(data)
        if (cancelled) {
          void opened.destroy()
          return
        }
        pdf = opened
        const first = await opened.getPage(1)
        const pageWidthAt1 = first.getViewport({ scale: 1 }).width
        first.cleanup()
        if (cancelled) {
          void opened.destroy()
          return
        }
        setDoc({ status: 'ready', pdf: opened, pages: opened.numPages, pageWidthAt1 })
        onPagesRef.current?.(opened.numPages)
        onVisibleRef.current?.(1)
      } catch (error) {
        if (cancelled) return
        setDoc({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
    return () => {
      cancelled = true
      if (pdf !== undefined) void pdf.destroy()
    }
  }, [data])

  const onPageVisibility = (page: number, ratio: number): void => {
    visibility.current.set(page, ratio)
    let bestPage = 1
    let bestRatio = -1
    for (const [p, r] of visibility.current) {
      if (r > bestRatio) {
        bestRatio = r
        bestPage = p
      }
    }
    if (bestRatio >= 0) onVisibleRef.current?.(bestPage)
  }

  if (doc.status === 'loading') {
    return <div className={css.editorPlaceholder}>{t('loading')}</div>
  }
  if (doc.status === 'error') {
    return <div className={css.editorError}>{doc.message}</div>
  }

  const scale = fitScale(doc.pageWidthAt1, stageWidth, zoom)
  const nodes: ReactNode[] = []
  for (let n = 1; n <= doc.pages; n += 1) {
    nodes.push(
      <PdfPage
        key={n}
        pdf={doc.pdf}
        pageNumber={n}
        scale={scale}
        pageWidthAt1={doc.pageWidthAt1}
        label={`${title} · ${n}/${doc.pages}`}
        onVisibility={onPageVisibility}
      />,
    )
  }
  return <div className={css.editorPdfPages}>{nodes}</div>
}

async function openPdfDocument(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist')
  const open = async (workerSrc: string): Promise<PDFDocumentProxy> => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc
    return pdfjs.getDocument({
      data: data.slice(0),
      useSystemFonts: true,
      isEvalSupported: false,
      verbosity: 0,
    }).promise
  }
  // Prefer inlined blob (phone 8787 / WebView often 404s the separate worker
  // asset and then FakeWorker fails with "Failed to fetch dynamically…").
  // HTTP URL remains a desktop/browser fallback when blob workers are blocked.
  try {
    return await open(pdfWorkerSrc())
  } catch (blobError) {
    try {
      return await open(PDF_WORKER_URL)
    } catch {
      throw blobError instanceof Error ? blobError : new Error(String(blobError))
    }
  }
}

function PdfPage(props: {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  pageWidthAt1: number
  label: string
  onVisibility: (page: number, ratio: number) => void
}): ReactNode {
  const { pdf, pageNumber, scale, pageWidthAt1, label, onVisibility } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onVisibilityRef = useRef(onVisibility)
  onVisibilityRef.current = onVisibility
  // A4-ish placeholder until the real render measures; keeps scroll stable.
  const placeholderHeight = Math.max(120, pageWidthAt1 * scale * 1.414)

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (host === null || canvas === null) return

    let cancelled = false
    let page: PDFPageProxy | undefined
    let renderTask: RenderTask | undefined
    let started = false

    const render = async (): Promise<void> => {
      if (started || cancelled) return
      started = true
      try {
        page = await pdf.getPage(pageNumber)
        if (cancelled) return
        const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1
        const viewport = page.getViewport({ scale: scale * dpr })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        canvas.style.width = `${viewport.width / dpr}px`
        canvas.style.height = `${viewport.height / dpr}px`
        const ctx = canvas.getContext('2d', { alpha: false })
        if (ctx === null) return
        renderTask = page.render({ canvasContext: ctx, viewport })
        await renderTask.promise
      } catch (error) {
        if (cancelled) return
        if (error instanceof Error && /cancel/i.test(error.message)) return
        started = false
      }
    }

    const stage = host.closest(`.${css.editorPdfStage}`)
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          onVisibilityRef.current(pageNumber, entry.isIntersecting ? entry.intersectionRatio : 0)
          if (entry.isIntersecting) void render()
        }
      },
      {
        root: stage instanceof Element ? stage : null,
        rootMargin: '320px 0px',
        threshold: [0, 0.15, 0.35, 0.55, 0.75],
      },
    )
    io.observe(host)

    return () => {
      cancelled = true
      io.disconnect()
      onVisibilityRef.current(pageNumber, 0)
      try {
        renderTask?.cancel()
      } catch {
        // Already settled.
      }
      page?.cleanup()
    }
  }, [pdf, pageNumber, scale])

  return (
    <div
      ref={hostRef}
      className={css.editorPdfPage}
      style={{ minHeight: placeholderHeight }}
      data-pdf-page={pageNumber}
      aria-label={label}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}
