/**
 * Zoomable image preview surface.
 *
 * Controls, all pointer-driven so they work identically on mouse, trackpad
 * and touch:
 * - Ctrl/⌘ + wheel zooms about the cursor (the browser's page-zoom gesture is
 *   suppressed with `preventDefault`; a bare wheel still scrolls the stage).
 * - Drag pans once the image is larger than the viewport; `grab`/`grabbing`
 *   carry that state, and a drag that never crossed the threshold is ignored
 *   so a stray click does not shift the image.
 * - Double-click toggles between fit and 2x about the click point.
 * - The toolbar's Fit / 100% / reset buttons cover the keyboard path; `+`/`-`
 *   and `0` are bound on the host element so the shortcuts work while the
 *   image has focus without hijacking the rest of the app.
 *
 * Zoom is stored as a single scalar (1 = the intrinsic size) and clamped to
 * [MIN, MAX]; `fit` is the largest scale at which the whole image fits the
 * stage, recomputed on resize so a rotated window re-fits instead of
 * letterboxing a stale layout.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { downloadUrl, mediaUrl, type SessionScope } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Below this a pinch/drag delta is noise, not intent. */
const MIN_SCALE = 0.05
/** Hard ceiling; with sane wheel steps this is many notches away, not one flick. */
const MAX_SCALE = 8
/**
 * Per-pixel wheel sensitivity for `exp(-deltaY * k)`.
 * Must stay ~1e-3: `1.0015` made a single ±120 notch jump straight to MAX
 * (~1600%) / MIN, which is what users hit with Ctrl+scroll.
 */
const WHEEL_SENSITIVITY = 0.0015
/** Cap one wheel event so a coalesced trackpad delta cannot leap to the clamp. */
const WHEEL_DELTA_CAP = 160
/** A pointer move beyond this (px) turns a press into a pan. */
const DRAG_THRESHOLD = 3
/** Double-click step. */
const DBL_CLICK_SCALE = 2

/** Multiplicative zoom factor for one wheel event (Ctrl/⌘ held). */
function wheelZoomFactor(deltaY: number): number {
  const capped = Math.max(-WHEEL_DELTA_CAP, Math.min(WHEEL_DELTA_CAP, deltaY))
  return Math.exp(-capped * WHEEL_SENSITIVITY)
}

export function ImagePreview(props: { scope: SessionScope; path: string; title: string }): ReactNode {
  const { scope, path, title } = props
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  /** Intrinsic pixel size, learned from the decoded image. */
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [failed, setFailed] = useState(false)
  /** User zoom; `null` means "follow the stage" (fit). */
  const [zoom, setZoom] = useState<number | null>(null)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  /** Stage box, remeasured on resize; drives the fit scale. */
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect()
      setStage(prev => (
        prev !== null && prev.width === rect.width && prev.height === rect.height
          ? prev
          : { width: rect.width, height: rect.height }
      ))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])

  /** Largest scale at which the whole image fits the stage (padding-aware). */
  const fitScale = useMemo(() => {
    if (natural === null || stage === null) return 1
    if (natural.width <= 0 || natural.height <= 0) return 1
    const pad = 24
    return Math.min(
      (stage.width - pad) / natural.width,
      (stage.height - pad) / natural.height,
      1,
    )
  }, [natural, stage])

  const scale = Math.min(Math.max(zoom ?? fitScale, MIN_SCALE), MAX_SCALE)
  const isFit = zoom === null

  /** Apply a new scale, keeping the point under the cursor pinned. */
  const zoomAbout = useCallback((nextScale: number, clientX: number, clientY: number): void => {
    const el = stageRef.current
    if (el === undefined || el === null) return
    const clamped = Math.min(Math.max(nextScale, MIN_SCALE), MAX_SCALE)
    const rect = el.getBoundingClientRect()
    // Cursor position relative to the stage centre, in CSS pixels.
    const cx = clientX - rect.left - rect.width / 2
    const cy = clientY - rect.top - rect.height / 2
    // Zoom about the centre unless there is a real box to anchor to: with no
    // measured stage (first layout, or a non-rendering host) the cursor offset
    // is meaningless and would fling the image off-screen.
    const hasBox = rect.width > 0 && rect.height > 0
    if (!hasBox) {
      setOffset({ x: 0, y: 0 })
      setZoom(clamped)
      return
    }
    setOffset(prev => {
      const k = clamped / scale
      return { x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
    })
    setZoom(clamped)
  }, [scale])

  // React 17+ registers `wheel` (like touchstart/touchmove) as a PASSIVE
  // listener on the root container, so the synthetic onWheel above CANNOT
  // preventDefault — a Ctrl+wheel would zoom the whole application page as
  // well as the image. The suppression therefore needs a native, explicitly
  // non-passive listener. Registered on the stage itself (the gesture only
  // means "zoom" while the pointer is over the image).
  useEffect(() => {
    const el = stageRef.current
    if (el === null) return
    const onNativeWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      event.stopPropagation()
      zoomAbout(scale * wheelZoomFactor(event.deltaY), event.clientX, event.clientY)
    }
    el.addEventListener('wheel', onNativeWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onNativeWheel) }
  }, [scale, zoomAbout])

  // ── Panning ──────────────────────────────────────────────────────────────
  const drag = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    drag.current = { startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const state = drag.current
    if (state === null) return
    const dx = event.clientX - state.startX
    const dy = event.clientY - state.startY
    if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    state.moved = true
    setOffset({ x: state.originX + dx, y: state.originY + dy })
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current !== null) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      drag.current = null
    }
  }

  /** Fit (or 2x when already fitting) about the pointer, on double-click. */
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (isFit) {
      zoomAbout(DBL_CLICK_SCALE * fitScale, event.clientX, event.clientY)
    } else {
      setZoom(fitScale)
      setOffset({ x: 0, y: 0 })
    }
  }

  const reset = useCallback((): void => {
    setZoom(null)
    setOffset({ x: 0, y: 0 })
  }, [])

  // Keyboard shortcuts on the stage itself: scoped to this surface, so `+`/`-`
  // keep their usual meaning everywhere else.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.target !== stageRef.current) return
      if (event.key === '0') { reset(); return }
      if (event.key !== '+' && event.key !== '=' && event.key !== '-' && event.key !== '_') return
      event.preventDefault()
      const rect = stageRef.current?.getBoundingClientRect()
      const cx = (rect?.left ?? 0) + (rect?.width ?? 0) / 2
      const cy = (rect?.top ?? 0) + (rect?.height ?? 0) / 2
      const step = event.key === '-' || event.key === '_' ? 1 / 1.25 : 1.25
      zoomAbout(scale * step, cx, cy)
    }
    const el = stageRef.current
    if (el === null) return
    el.addEventListener('keydown', onKey)
    return () => { el.removeEventListener('keydown', onKey) }
  }, [scale, zoomAbout, reset])

  const percent = Math.round(scale * 100)

  return (
    <div className={css.editorImageView}>
      <div className={css.editorImageToolbar}>
        <button
          type="button"
          className={clsx(css.iconButton, isFit && css.editorImageToggleActive)}
          onClick={() => { setZoom(fitScale); setOffset({ x: 0, y: 0 }) }}
        >
          {t('imageFit')}
        </button>
        <button
          type="button"
          className={clsx(css.iconButton, !isFit && Math.abs(percent - 100) < 1 && css.editorImageToggleActive)}
          onClick={() => {
            const rect = stageRef.current?.getBoundingClientRect()
            zoomAbout(1, (rect?.left ?? 0) + (rect?.width ?? 0) / 2, (rect?.top ?? 0) + (rect?.height ?? 0) / 2)
            setOffset({ x: 0, y: 0 })
          }}
        >
          {t('imageActualSize')}
        </button>
        <span className={css.editorImageZoomLabel}>{percent}%</span>
        <a className={css.editorDownloadLink} href={downloadUrl(scope, path)} download>
          {t('download')}
        </a>
      </div>
      <div
        ref={stageRef}
        className={clsx(css.editorImageStage, offset.x !== 0 || offset.y !== 0 ? css.editorImageStagePannable : undefined)}
        tabIndex={0}
        role="img"
        aria-label={title}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={handleDoubleClick}
      >
        {failed
          ? <div className={css.editorError}>{t('imageLoadFailed')}</div>
          : (
            <img
              ref={imageRef}
              className={css.editorImage}
              src={mediaUrl(scope, path)}
              alt={title}
              draggable={false}
              style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
              onLoad={(event) => {
                const img = event.currentTarget
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNatural({ width: img.naturalWidth, height: img.naturalHeight })
                }
              }}
              onError={() => { setFailed(true) }}
            />
          )}
      </div>
    </div>
  )
}
