/**
 * Drag the window to the top of the screen and it maximises — for the one
 * window Windows will not do that for itself.
 *
 * Aero Snap belongs to windows with a resizable frame (`WS_THICKFRAME`), and
 * Electron builds a transparent window without one, whatever `thickFrame` says:
 * measured, the style bits are identical with the option on and off. The drag
 * itself is still the system's — `-webkit-app-region: drag` — so the window
 * moves, reaches the top edge, and simply stays there at the same size.
 *
 * So the gesture is finished here: when a move ends with the pointer at the
 * top edge of a display, maximise. What a restore goes back to is where the
 * drag *started*, which is what Windows does — not the top-edge position the
 * window happened to be dropped at.
 *
 * Only the top edge. Half-screen snapping to the sides is the same idea, but a
 * side edge between two monitors is not an edge the pointer stops at, and
 * guessing wrong there would throw the window across the desk.
 */
import { screen, type BrowserWindow, type Rectangle } from 'electron'

/**
 * How long a move has to have been still before it counts as finished.
 *
 * `moved` is not "the drag ended": measured, it fires mid-drag too, whenever
 * the pointer pauses. Waiting for a short quiet spell means a pause at the top
 * on the way somewhere else does not maximise.
 */
const SETTLE_MS = 150

export function snapToTop(win: BrowserWindow): void {
  /** Where the current drag began, from its first `will-move`. */
  let dragStart: Rectangle | null = null
  /** What an unmaximise should restore, set only when this file maximised. */
  let restoreTo: Rectangle | null = null
  let settle: ReturnType<typeof setTimeout> | null = null

  win.on('will-move', () => {
    if (!dragStart && !win.isMaximized()) dragStart = win.getBounds()
    if (settle) clearTimeout(settle)
    settle = null
  })

  win.on('moved', () => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      const started = dragStart
      dragStart = null
      if (win.isDestroyed() || win.isMaximized()) return

      const cursor = screen.getCursorScreenPoint()
      const display = screen.getDisplayNearestPoint(cursor)
      if (cursor.y > display.bounds.y + 1) return

      restoreTo = started
      win.maximize()
    }, SETTLE_MS)
  })

  win.on('unmaximize', () => {
    const target = restoreTo
    restoreTo = null
    if (target && !win.isDestroyed()) win.setBounds(target)
  })
}
