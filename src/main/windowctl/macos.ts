/**
 * The macOS driver, through `osascript`.
 *
 * **Why AppleScript and not a compiled helper.** Everything this needs lives
 * behind the Accessibility API, and the one route to it that ships with the
 * system — and needs no binary of ours signed, notarised and shipped per
 * architecture — is System Events. The app already compiles a small C helper
 * for sensors, so a second one was possible; it would still have needed the
 * same permission, so it would have bought a build step and nothing else.
 *
 * **It needs Accessibility permission, and that is not a footnote.** Until the
 * user ticks ia_workspaces under Privacy & Security → Accessibility, System
 * Events refuses and every call here fails. `supported` reports that state, and
 * `reason` says what to do about it, because a feature that silently does
 * nothing is worse than one that says it is switched off.
 *
 * **Hiding is per application, not per window.** macOS has no per-window hide
 * for another process; `set visible of process to false` hides all of it. So a
 * program with two windows in two workspaces cannot have one of them off
 * screen — the honest thing, and it is why `minimize` stays the default: that
 * one *is* per window.
 *
 * **Handles are made up here.** Nothing hands out a durable window identifier
 * without private API, so a handle is `pid:title` and a window is addressed by
 * name within its process. A retitled window is therefore a lost window, which
 * the manager copes with by re-listing.
 */
import { execFile } from 'node:child_process'
import type { ForeignWindow, WindowAction, WindowDriver } from './types'

/** Long enough for a slow System Events call, short enough to not hang a sync. */
const TIMEOUT_MS = 6_000

function osascript(script: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      ['-e', script],
      { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout)
    )
  })
}

/** `pid:title`, and the two halves back again. */
function handleOf(pid: number, title: string): string {
  return `${pid}:${title}`
}

function splitHandle(hwnd: string): { pid: number; title: string } | null {
  const cut = hwnd.indexOf(':')
  if (cut < 1) return null
  const pid = Number(hwnd.slice(0, cut))
  if (!Number.isFinite(pid)) return null
  return { pid, title: hwnd.slice(cut + 1) }
}

/** AppleScript's own escaping, which is only backslash and double quote. */
function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Every window of every ordinary application, as tab-separated rows.
 *
 * `background only is false` drops the daemons and agents, which is most of the
 * process list and none of what anybody wants to attach to.
 */
const LIST_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with proc in (every application process whose background only is false)
    try
      set procPid to unix id of proc
      set procName to name of proc
      set procVisible to visible of proc
      repeat with win in (every window of proc)
        try
          set winName to name of win
          set winMin to value of attribute "AXMinimized" of win
          set out to out & procPid & tab & procName & tab & winName & tab & (procVisible as text) & tab & (winMin as text) & linefeed
        end try
      end repeat
    end try
  end repeat
  return out
end tell`

export class MacDriver implements WindowDriver {
  private trusted: boolean | null = null

  readonly logicalPixels = true

  get supported(): boolean {
    // Optimistic until proven otherwise: the permission can be granted while
    // the app is running, and a driver that decided at startup would stay off
    // until a restart nobody knows to do.
    return this.trusted !== false
  }

  get reason(): string {
    return this.trusted === false
      ? 'macOS needs ia_workspaces ticked under Privacy & Security → Accessibility before it can move another program’s windows.'
      : ''
  }

  async listAll(): Promise<ForeignWindow[]> {
    const out = await osascript(LIST_SCRIPT)
    this.trusted = out !== null
    if (!out) return []
    const windows: ForeignWindow[] = []
    for (const line of out.split('\n')) {
      const [rawPid, executable, title, visible, minimized] = line.split('\t')
      const pid = Number(rawPid)
      if (!Number.isFinite(pid) || !title) continue
      windows.push({
        hwnd: handleOf(pid, title),
        pid,
        title,
        executable: executable ?? '',
        // Per application, because that is the only visibility macOS reports
        // for somebody else's window.
        visible: visible === 'true',
        minimized: minimized === 'true',
      })
    }
    return windows
  }

  async windowsOf(pids: readonly number[]): Promise<ForeignWindow[]> {
    if (!pids.length) return []
    const wanted = new Set(pids)
    return (await this.listAll()).filter((window) => wanted.has(window.pid))
  }

  async apply(actions: readonly WindowAction[]): Promise<string[]> {
    const done: string[] = []
    for (const action of actions) {
      const target = splitHandle(action.hwnd)
      if (!target) continue
      const script = this.scriptFor(action, target)
      if (!script) continue
      const out = await osascript(script)
      this.trusted = out !== null
      if (out !== null) done.push(action.hwnd)
    }
    return done
  }

  dispose(): void {}

  private scriptFor(action: WindowAction, target: { pid: number; title: string }): string | null {
    const proc = `first application process whose unix id is ${target.pid}`
    const win = `(first window whose name is ${quote(target.title)})`
    switch (action.action) {
      case 'hide':
        // The whole application. See the note at the top of the file.
        return `tell application "System Events" to set visible of (${proc}) to false`
      case 'show':
        return `tell application "System Events" to set visible of (${proc}) to true`
      case 'minimize':
        return `tell application "System Events" to tell (${proc}) to set value of attribute "AXMinimized" of ${win} to true`
      case 'restore':
        return `tell application "System Events" to tell (${proc}) to set value of attribute "AXMinimized" of ${win} to false`
      case 'place':
        // Points, not pixels: AppleScript works in the same coordinate space
        // the window manager does, so a Retina display's backing scale must not
        // be applied twice. The caller is told this by `pixelsAreLogical`.
        return `tell application "System Events" to tell (${proc})
  set position of ${win} to {${Math.round(action.x)}, ${Math.round(action.y)}}
  set size of ${win} to {${Math.round(action.width)}, ${Math.round(action.height)}}
end tell`
      default:
        return null
    }
  }
}
