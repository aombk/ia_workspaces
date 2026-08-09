/**
 * The only script that runs inside a browser pane's page.
 *
 * A `<webview>` guest is somebody else's web page and gets nothing from us — no
 * node, no context bridge, no way to reach the app. This is the exception, and
 * it exists for one reason: Chromium's Ctrl+scroll zoom is implemented by the
 * browser's own chrome, not by the page, so a bare `<webview>` does not zoom.
 * The wheel event is delivered to the guest and stops there, where the host has
 * no way to see it.
 *
 * So the guest forwards the gesture and does nothing else. It reports the
 * direction of a Ctrl+wheel and a Ctrl+0, and the host decides what that means
 * and applies it with `setZoomLevel`. Nothing is read out of the page, nothing
 * is written into it, and the channel carries one string in one direction.
 *
 * `sendToHost` reaches only the `<webview>` element that owns this guest — it
 * cannot address the main process or another pane.
 */
import { ipcRenderer } from 'electron'

/** Matches the channel the pane listens on. */
const CHANNEL = 'iaw:zoom'

window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return
    // The page must not also scroll, or a zoom gesture jumps the document.
    e.preventDefault()
    ipcRenderer.sendToHost(CHANNEL, e.deltaY < 0 ? 'in' : 'out')
  },
  // Not passive, because preventing the default scroll is the point.
  { passive: false, capture: true }
)

window.addEventListener(
  'keydown',
  (e) => {
    if (!e.ctrlKey) return
    // The digits a browser uses: 0 resets, +/- step. A page that wants Ctrl+0
    // for itself loses it here, which is the same trade every browser makes.
    if (e.key === '0') ipcRenderer.sendToHost(CHANNEL, 'reset')
    else if (e.key === '+' || e.key === '=') ipcRenderer.sendToHost(CHANNEL, 'in')
    else if (e.key === '-') ipcRenderer.sendToHost(CHANNEL, 'out')
    else return
    e.preventDefault()
  },
  { capture: true }
)
