/**
 * Deferred one-shot open for hosts that may not have a real size yet.
 *
 * xterm's `Terminal.open()` must not run in a zero-size container: the
 * renderer creation fails there (the DomRenderer is built from the host's
 * dimensions), leaving the render service's renderer `undefined`, and the
 * next Viewport refresh crashes reading `.dimensions` off it. WebKit-based
 * hosts (WKWebView) reliably report zero while the bottom panel's expand
 * slide is in flight; any `display:none`-hidden ancestor does the same.
 *
 * A single frame with a 1–few px box mid CSS height transition is also
 * unsafe — xterm can "open" then leave a dead paint grid until something
 * else forces a fit (dragging the right workbench was the common recovery).
 * Wait for {@link MIN_OPEN_SIZE} on both axes across two consecutive frames
 * before calling `open`.
 *
 * The caller's `open` callback (open + fit + resize) is invoked exactly
 * once. While the host stays undersized the polling continues every frame;
 * it stops when the host leaves the document (`isConnected`), so a pending
 * open never fires after unmount. The returned cancel function drops a
 * pending frame immediately (idempotent).
 *
 * `raf`/`caf` are injectable so tests can drive the polling deterministically.
 */

/** Match terminal-paint / sendResize: sub-2px boxes are not a usable grid. */
export const MIN_OPEN_SIZE = 2

/**
 * Consecutive sized frames required before `open`. One frame alone is often
 * a mid-slide flicker while the bottom panel's height CSS transitions.
 */
export const OPEN_STABLE_FRAMES = 2

export function openWhenSized(
  host: HTMLElement,
  open: () => void,
  raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  caf: (id: number) => void = cancelAnimationFrame,
): () => void {
  let frame: number | null = null
  let readyFrames = 0
  const step = (): void => {
    frame = null
    if (!host.isConnected) return
    if (host.clientWidth >= MIN_OPEN_SIZE && host.clientHeight >= MIN_OPEN_SIZE) {
      readyFrames += 1
      if (readyFrames >= OPEN_STABLE_FRAMES) {
        open()
        return
      }
    } else {
      readyFrames = 0
    }
    frame = raf(step)
  }
  frame = raf(step)
  return () => {
    if (frame !== null) {
      caf(frame)
      frame = null
    }
  }
}
