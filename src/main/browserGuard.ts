/**
 * What a web page in the browser pane is allowed to do.
 *
 * The pane shows arbitrary sites, and Electron's default answer to every
 * permission a page asks for is yes — silently, with no prompt anywhere. In
 * an app whose clipboard routinely holds tokens and passwords copied out of
 * terminals, "any site may read the clipboard whenever it has focus" is the
 * sharpest of those, but the list went on: camera and microphone once the OS
 * had granted them to the app, location, notifications, and launching any
 * program registered for a URL scheme (`vscode:`, `ms-msdt:`, …) on a click.
 *
 * So the browser session answers no, except to the two things an ordinary page
 * needs to work and that cannot reach anything: going fullscreen, and writing
 * (never reading) the clipboard from a copy button.
 *
 * ## The webview itself
 *
 * A `<webview>` is configured by attributes the renderer sets, and a renderer
 * that had been compromised could set different ones — Node integration in the
 * guest, a preload of its choosing. `will-attach-webview` is where main gets
 * the final say, and it pins the guest to exactly what `browserView.ts` asks
 * for: our one guest preload or none, no Node, isolated, sandboxed, and only
 * web addresses to load.
 */
import { session, type BrowserWindow, type WebContents } from 'electron'
import path from 'node:path'

/** The partition `browserView.ts` gives every browser pane. */
const BROWSER_PARTITION = 'persist:browser'

/** The only permissions a page in the pane is granted. */
const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write'])

/** Web addresses only: no `file:`, no `data:`, no app scheme. */
function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:' || url === 'about:blank'
  } catch {
    return false
  }
}

/** Exported for the tests: the permission decision on its own. */
export function allowBrowserPermission(permission: string): boolean {
  return ALLOWED.has(permission)
}

/**
 * Applies the rules to the browser session and to webviews in `win`.
 *
 * `guestPreload` is the absolute path of the one preload a guest may have.
 */
export function guardBrowserPane(win: BrowserWindow, guestPreload: string): void {
  const browser = session.fromPartition(BROWSER_PARTITION)
  browser.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowBrowserPermission(permission))
  })
  // The synchronous form, which pages use to ask "do I already have it" — a
  // page told yes here skips the request entirely.
  browser.setPermissionCheckHandler((_contents, permission) => allowBrowserPermission(permission))

  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    // Whatever the attributes said, these are what a guest runs with.
    prefs.nodeIntegration = false
    prefs.nodeIntegrationInSubFrames = false
    prefs.contextIsolation = true
    prefs.sandbox = true
    prefs.webSecurity = true
    // Our guest preload, or nothing. Compared as resolved paths: the renderer
    // hands over a file URL and Electron converts it, so the spelling differs
    // while the file is the same.
    if (prefs.preload && path.resolve(prefs.preload) !== path.resolve(guestPreload)) delete prefs.preload
    if (params.src && !isWebUrl(params.src)) event.preventDefault()
  })

  win.webContents.on('did-attach-webview', (_event, guest: WebContents) => {
    // A page cannot leave the web either: navigating to a `file:` path or an
    // app scheme from a link or a script is refused, the same rule the address
    // bar already applies to what is typed into it.
    guest.on('will-navigate', (e, url) => {
      if (!isWebUrl(url)) e.preventDefault()
    })
    guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}
