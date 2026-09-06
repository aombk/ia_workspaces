/**
 * The Linux driver, through `xdotool` — X11 only, and that is not a shortcut.
 *
 * **Wayland cannot do this and never will.** A Wayland client may not see, name
 * or touch another client's windows; that is the security model rather than a
 * missing feature. Some compositors expose their own escape hatch — a KWin
 * script, a GNOME extension — and each is a different API for one desktop. So a
 * Wayland session is reported unsupported, with a reason that says so, and an
 * XWayland-only session is treated as X11 because for these purposes it is.
 *
 * **`xdotool` rather than xcb bindings.** The alternative is a native module
 * against libxcb, which is a compiled dependency for four calls; `xdotool` is
 * one `apt install` away, is on most desktops already, and the whole protocol
 * fits in a shell pipeline. Where it is missing, `reason` says which package.
 *
 * **`windowunmap` is the hide.** X11 has no per-window hide for another client,
 * but unmapping one takes it off the screen and out of the taskbar, which is
 * what hiding means here — and `windowmap` puts it back. Minimising is
 * `windowminimize`, which is the ordinary iconify and what the taskbar expects.
 */
import { execFile } from 'node:child_process'
import type { ForeignWindow, WindowAction, WindowDriver } from './types'

const TIMEOUT_MS = 6_000

function run(file: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout)
    )
  })
}

/**
 * Every visible window, with its pid, name and process, in one spawn.
 *
 * `xdotool` answers one question per invocation, and a desktop has a hundred
 * windows — a call each would be a hundred processes. So the loop runs inside
 * one shell, which is the difference between 40ms and four seconds.
 */
const LIST_SCRIPT = `
for id in $(xdotool search --onlyvisible --name '' 2>/dev/null); do
  pid=$(xdotool getwindowpid "$id" 2>/dev/null || echo 0)
  name=$(xdotool getwindowname "$id" 2>/dev/null || echo '')
  exe=''
  if [ "$pid" != "0" ] && [ -r "/proc/$pid/comm" ]; then exe=$(cat "/proc/$pid/comm"); fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$id" "$pid" "$exe" "$name"
done`

export class X11Driver implements WindowDriver {
  private available: boolean | null = null
  private missing = ''

  constructor(private readonly wayland: boolean) {}

  readonly logicalPixels = false

  get supported(): boolean {
    return !this.wayland && this.available !== false
  }

  get reason(): string {
    if (this.wayland) {
      return 'Wayland does not let one program move another program’s windows. Log in to an X11 session to use this.'
    }
    return this.available === false
      ? `This needs ${this.missing || 'xdotool'} — install it (for example \`sudo apt install xdotool\`) and try again.`
      : ''
  }

  async listAll(): Promise<ForeignWindow[]> {
    if (this.wayland) return []
    const out = await run('sh', ['-c', LIST_SCRIPT])
    if (out === null) {
      this.available = false
      this.missing = 'xdotool'
      return []
    }
    this.available = true

    const windows: ForeignWindow[] = []
    for (const line of out.split('\n')) {
      const [id, rawPid, executable, ...rest] = line.split('\t')
      const title = rest.join('\t')
      const pid = Number(rawPid)
      if (!id || !title || !Number.isFinite(pid)) continue
      windows.push({
        hwnd: id,
        pid,
        title,
        executable: executable ?? '',
        // Everything this lists is mapped, by `--onlyvisible`. A window we
        // unmapped is therefore absent rather than reported hidden, which is
        // why the manager keeps handles it has already claimed.
        visible: true,
        minimized: false,
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
    if (this.wayland || !actions.length) return []
    const done: string[] = []
    // One `xdotool` invocation for the batch: its command line chains, so a
    // workspace switch that hides six windows is one process rather than six.
    const argv: string[] = []
    for (const action of actions) {
      if (!/^\d+$/.test(action.hwnd)) continue
      switch (action.action) {
        case 'hide':
          argv.push('windowunmap', action.hwnd)
          break
        case 'show':
          argv.push('windowmap', action.hwnd)
          break
        case 'minimize':
          argv.push('windowminimize', action.hwnd)
          break
        case 'restore':
          // `windowmap` covers the unmapped case and `windowactivate` the
          // iconified one; there is no deiconify in X11 that does not also
          // raise, so restoring here takes the focus. Minimising is still the
          // safer default, and this is the price of the safer default.
          argv.push('windowmap', action.hwnd, 'windowactivate', action.hwnd)
          break
        case 'place':
          argv.push(
            'windowmap',
            action.hwnd,
            'windowmove',
            action.hwnd,
            String(Math.round(action.x)),
            String(Math.round(action.y)),
            'windowsize',
            action.hwnd,
            String(Math.round(action.width)),
            String(Math.round(action.height))
          )
          break
      }
      done.push(action.hwnd)
    }
    if (!argv.length) return []
    const out = await run('xdotool', argv)
    if (out === null) {
      this.available = false
      this.missing = 'xdotool'
      return []
    }
    this.available = true
    return done
  }

  dispose(): void {}
}
