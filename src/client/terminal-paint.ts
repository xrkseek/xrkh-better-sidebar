/**
 * Host has a real box but xterm's paint grid is dead — the post-sleep blank
 * terminal: fit left rows/cols at 0, or the `.xterm-screen` layer collapsed
 * while the panel chrome still looks open.
 */
export function terminalPaintBroken(
  host: HTMLElement,
  term: { readonly rows: number; readonly cols: number; readonly element?: HTMLElement },
): boolean {
  if (host.clientWidth < 2 || host.clientHeight < 2) return false
  if (term.element === undefined) return false
  if (term.rows < 2 || term.cols < 2) return true
  const screen = term.element.querySelector('.xterm-screen')
  if (screen instanceof HTMLElement && (screen.clientWidth < 2 || screen.clientHeight < 2)) return true
  return false
}
