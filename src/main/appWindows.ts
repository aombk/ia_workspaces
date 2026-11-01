/**
 * The app's windows, and which of them hears what.
 *
 * There used to be one window and everything was sent to it. With several,
 * each message has an address, and there are three kinds:
 *
 * - **To everyone.** A pane's status, an alert, git progress, the document
 *   itself: every window draws a sidebar, and every sidebar shows every
 *   workspace.
 * - **To one pane's window.** A terminal's output goes to the window drawing
 *   that terminal and nowhere else — the others have no terminal to write it
 *   into, and the bytes are the one thing here sent often enough to matter.
 * - **To one window.** Its own focus, its own caption buttons, a request to
 *   show something.
 *
 * Only the registry is here; building a window needs half of `main.ts`, so it
 * stays there.
 */
import { BrowserWindow, type WebContents } from 'electron'
import type { AppWindowKind, WindowInfo } from '../shared/types'
import { MAIN_WINDOW } from '../shared/windowLayout'

export interface AppWindow {
  id: string
  kind: AppWindowKind
  win: BrowserWindow
}

export class AppWindows {
  /** In the order they were opened, which is the order they are numbered in. */
  private readonly entries = new Map<string, AppWindow>()

  add(id: string, kind: AppWindowKind, win: BrowserWindow): AppWindow {
    const entry = { id, kind, win }
    this.entries.set(id, entry)
    return entry
  }

  remove(id: string): void {
    this.entries.delete(id)
  }

  get(id: string): AppWindow | undefined {
    const entry = this.entries.get(id)
    return entry && !entry.win.isDestroyed() ? entry : undefined
  }

  main(): AppWindow | undefined {
    return this.get(MAIN_WINDOW)
  }

  all(): AppWindow[] {
    return [...this.entries.values()].filter((e) => !e.win.isDestroyed())
  }

  /** The window a message came from, if it came from one of ours. */
  ofSender(sender: WebContents): AppWindow | undefined {
    return this.all().find((e) => e.win.webContents === sender)
  }

  /**
   * The window to show something in when nothing says which: the one you are
   * in, unless that is the overview, which shows nothing of its own.
   */
  focusedForContent(): AppWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow()
    const entry = this.all().find((e) => e.win === focused)
    return entry && entry.kind !== 'overview' ? entry : this.main()
  }

  /** True while any of them is the focused window. */
  anyFocused(): boolean {
    return this.all().some((e) => e.win.isFocused())
  }

  sendTo(id: string, channel: string, payload: unknown): void {
    const entry = this.get(id)
    if (entry) entry.win.webContents.send(channel, payload)
  }

  broadcast(channel: string, payload: unknown, except?: string): void {
    for (const entry of this.all()) {
      if (entry.id !== except) entry.win.webContents.send(channel, payload)
    }
  }

  /** Brings a window to the front, from minimised or behind. */
  reveal(id: string): boolean {
    const entry = this.get(id)
    if (!entry) return false
    if (entry.win.isMinimized()) entry.win.restore()
    if (!entry.win.isVisible()) entry.win.show()
    entry.win.focus()
    return true
  }

  info(): WindowInfo[] {
    let n = 1
    return this.all().map((e) => ({
      id: e.id,
      kind: e.kind,
      number: e.kind === 'main' ? 1 : ++n,
      focused: e.win.isFocused(),
    }))
  }
}
