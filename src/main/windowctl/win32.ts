/**
 * Other programs' windows, moved about from here — the Windows driver.
 *
 * The app can already run a GUI program; what it could not do is have any
 * opinion about where that program's window goes afterwards. This is the
 * smallest layer that gives it one: find the top-level windows a process owns,
 * hide them, show them, put one over a rectangle.
 *
 * One of three, behind the `WindowDriver` interface in `types.ts`. Everything
 * here is `user32`; the macOS and X11 drivers answer the same three questions
 * with entirely different machinery, and `index.ts` picks between them.
 *
 * **A PowerShell helper rather than a native module.** The app has exactly one
 * native dependency and adding an FFI package to call four functions would be
 * the largest thing in `package.json` by an order of magnitude. PowerShell can
 * declare a P/Invoke signature itself, and this app already spawns it to ask
 * about processes — so the same tool answers a fifth question. One helper is
 * started and kept, because snapping a window to a pane means a call per
 * layout change and paying process startup for each would be visible.
 *
 * **Nothing here is reparenting.** `SetParent` on somebody else's window makes
 * it a child of ours, and Microsoft does not support that: menus and dialogs
 * belonging to the guest open outside it, focus goes strange, and a mixed-DPI
 * pair of monitors renders it blurry. Every operation below is one an ordinary
 * window manager already does — show, hide, move — so a program that dislikes
 * being moved is still just a program in a window somebody moved.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { ForeignWindow, WindowAction, WindowDriver } from './types'

/**
 * The helper, as a script.
 *
 * Written to disk and run rather than passed with `-Command`, because a command
 * line carrying a C# class through two levels of quoting is a thing that breaks
 * on a stray brace and takes an afternoon to find.
 *
 * The loop is deliberately dumb: one JSON request per line in, one JSON reply
 * per line out, and an `id` echoed back so the caller can match them. It never
 * exits on a bad request — a helper that dies on one malformed line is a helper
 * that has to be restarted at the worst possible moment.
 *
 * `SWP_NOACTIVATE` and `SW_SHOWNA` matter more than they look. Showing a window
 * must not steal the keyboard from the terminal you are typing in, and moving
 * one must not raise it over everything else — a window coming back with its
 * workspace is not the user asking to use it.
 */
const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class IawWin {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  // Physical pixels, not virtualised ones. A DPI-unaware process is lied to by
  // Windows about every coordinate it passes, so on a 150% display the window
  // would land two thirds of the way to where it was asked to go. The caller
  // works in physical pixels and this is what makes that true.
  static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);
  public static void BeDpiAware() {
    try { if (SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }

  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);

  const uint GW_OWNER = 4;
  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOOLWINDOW = 0x00000080;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_NOZORDER = 0x0004;
  const int SW_HIDE = 0;
  const int SW_SHOWNA = 8;
  const int SW_MINIMIZE = 6;
  const int SW_RESTORE = 9;

  public class Found {
    public string hwnd; public uint pid; public string title; public string executable;
    public bool visible; public bool minimized;
  }

  // The process's own name, for the attach picker's second line. Asking can
  // throw — the process may be gone, or elevated past what we are allowed to
  // read — and a window we cannot name is still a window worth listing.
  static string NameOf(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return ""; }
  }

  // Owned windows are skipped: a dialog or a floating palette belongs to the
  // program's main window, and hiding the pair by hand is how you end up with
  // an orphan tool window nobody can close.
  public static List<Found> List(uint[] pids) {
    var wanted = new HashSet<uint>(pids);
    // No pids at all means every window on the machine — what the attach picker
    // asks for. A filter matching nothing would be the other reading, and it is
    // not a question anybody has: windowsOf is never called with none.
    bool all = wanted.Count == 0;
    var found = new List<Found>();
    EnumWindows(delegate(IntPtr hwnd, IntPtr param) {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (!all && !wanted.Contains(pid)) return true;
      if (GetWindow(hwnd, GW_OWNER) != IntPtr.Zero) return true;
      // Tool windows and untitled ones are the program's scaffolding — a
      // message sink, a GDI+ helper, an off-screen host. Measured on Notepad,
      // which owns four windows and shows one. Hiding scaffolding achieves
      // nothing and tracking it makes the count meaningless.
      if ((GetWindowLong(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW) != 0) return true;
      int length = GetWindowTextLength(hwnd);
      if (length == 0) return true;
      var text = new StringBuilder(length + 1);
      GetWindowText(hwnd, text, text.Capacity);
      found.Add(new Found {
        hwnd = hwnd.ToInt64().ToString(),
        pid = pid,
        title = text.ToString(),
        executable = NameOf(pid),
        visible = IsWindowVisible(hwnd),
        minimized = IsIconic(hwnd)
      });
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Act(string handle, string action, int x, int y, int cx, int cy) {
    long raw;
    if (!long.TryParse(handle, out raw)) return false;
    IntPtr hwnd = new IntPtr(raw);
    if (!IsWindow(hwnd)) return false;
    // ShowWindow answers with the window's *previous* visibility, not with
    // success — so showing a hidden window returns false, which read as failure
    // is a window reported as closed the moment it comes back. The existence
    // check above is the success test; these simply act and say so.
    switch (action) {
      case "hide": ShowWindow(hwnd, SW_HIDE); return true;
      case "show": ShowWindow(hwnd, SW_SHOWNA); return true;
      case "minimize": ShowWindow(hwnd, SW_MINIMIZE); return true;
      case "restore": ShowWindow(hwnd, SW_RESTORE); return true;
      case "place":
        if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
        ShowWindow(hwnd, SW_SHOWNA);
        return SetWindowPos(hwnd, IntPtr.Zero, x, y, cx, cy, SWP_NOACTIVATE | SWP_NOZORDER);
    }
    return false;
  }
}
"@

[IawWin]::BeDpiAware()

# What this helper has hidden and not yet shown again.
#
# The app kills itself outright on quit — there is no orderly shutdown to hang a
# restore on, and an async one would never finish. So the helper owns the undo:
# when our stdin closes, whether that is a quit or a crash, the loop ends and
# every window it hid comes back. A hidden window with nothing left to show it
# is the one failure this feature must not have.
$hidden = New-Object System.Collections.Generic.HashSet[string]

try {
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  try {
    $request = $line | ConvertFrom-Json
    if ($request.op -eq 'list') {
      $pids = @()
      if ($request.pids) { $pids = [uint32[]]$request.pids }
      $windows = @([IawWin]::List($pids))
      $reply = @{ id = $request.id; windows = $windows }
    } elseif ($request.op -eq 'apply') {
      $done = @()
      foreach ($item in @($request.items)) {
        $x = 0; $y = 0; $cx = 0; $cy = 0
        if ($null -ne $item.x) { $x = [int]$item.x; $y = [int]$item.y; $cx = [int]$item.width; $cy = [int]$item.height }
        if ([IawWin]::Act([string]$item.hwnd, [string]$item.action, $x, $y, $cx, $cy)) {
          $done += [string]$item.hwnd
          if ($item.action -eq 'hide') { [void]$hidden.Add([string]$item.hwnd) }
          else { [void]$hidden.Remove([string]$item.hwnd) }
        }
      }
      $reply = @{ id = $request.id; applied = $done }
    } else {
      $reply = @{ id = $request.id; error = 'unknown op' }
    }
  } catch {
    $reply = @{ id = -1; error = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress -Depth 4))
}
} finally {
  foreach ($handle in $hidden) { [void][IawWin]::Act($handle, 'show', 0, 0, 0, 0) }
}
`

interface Pending {
  resolve(value: unknown): void
  reject(reason: Error): void
  timer: NodeJS.Timeout
}

/** Nothing here is worth hanging the app for. */
const CALL_TIMEOUT_MS = 8_000

export class Win32Driver implements WindowDriver {
  private helper: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private scriptPath: string | null = null
  /** Set once the helper has failed, so a broken machine is asked once. */
  private broken = false

  constructor(private readonly writeScript: (text: string) => string | null) {}

  readonly logicalPixels = false
  readonly reason = ''

  /** Whether this machine can do any of it. Callers gate their UI on this. */
  get supported(): boolean {
    return !this.broken
  }

  /**
   * Every visible top-level window there is, for the attach picker.
   *
   * The same enumeration as `windowsOf` with no pid filter, so one window looks
   * the same however it was found — which matters, because a window picked out
   * of this list is then managed by exactly the code that manages a launched
   * one.
   */
  async listAll(): Promise<ForeignWindow[]> {
    const reply = await this.call<{ windows?: unknown }>({ op: 'list', pids: [] })
    return readWindows(reply?.windows)
  }

  /** Every top-level window owned by one of these processes. */
  async windowsOf(pids: readonly number[]): Promise<ForeignWindow[]> {
    if (!pids.length) return []
    const reply = await this.call<{ windows?: unknown }>({ op: 'list', pids: [...pids] })
    return readWindows(reply?.windows)
  }

  /** Runs a batch of actions, and answers which handles it managed. */
  async apply(actions: readonly WindowAction[]): Promise<string[]> {
    if (!actions.length) return []
    const reply = await this.call<{ applied?: unknown }>({ op: 'apply', items: actions })
    return Array.isArray(reply?.applied) ? reply.applied.filter((h): h is string => typeof h === 'string') : []
  }

  /**
   * Stops the helper.
   *
   * Not called on every idle moment: the process costs a few megabytes and
   * restarting it costs the C# compile, which is the expensive part. It goes
   * when the app does.
   */
  dispose(): void {
    for (const [, call] of this.pending) {
      clearTimeout(call.timer)
      call.reject(new Error('window helper stopped'))
    }
    this.pending.clear()
    this.helper?.kill()
    this.helper = null
  }

  private async call<T>(request: Record<string, unknown>): Promise<T | null> {
    if (!this.supported) return null
    const helper = this.start()
    if (!helper?.stdin) return null

    const id = this.nextId++
    return new Promise<T | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // A helper that stopped answering is worse than none: every later call
        // would queue behind it. It is dropped and the next call starts a new
        // one, which is cheap next to a UI that has stopped responding.
        this.helper?.kill()
        this.helper = null
        resolve(null)
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      try {
        helper.stdin?.write(`${JSON.stringify({ ...request, id })}\n`)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(null)
      }
    })
  }

  private start(): ChildProcess | null {
    if (this.helper) return this.helper
    if (!this.supported) return null

    this.scriptPath ??= this.writeScript(HELPER)
    if (!this.scriptPath) {
      this.broken = true
      return null
    }

    let child: ChildProcess
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          // The script is one we wrote to our own data folder this second; the
          // policy this bypasses is about scripts arriving from elsewhere.
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath,
        ],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      )
    } catch {
      this.broken = true
      return null
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.absorb(chunk))
    child.on('exit', () => {
      if (this.helper === child) this.helper = null
      for (const [id, call] of this.pending) {
        clearTimeout(call.timer)
        call.resolve(null)
        this.pending.delete(id)
      }
    })
    child.on('error', () => {
      this.broken = true
      this.helper = null
    })

    this.helper = child
    return child
  }

  /** One reply per line; a line can arrive in pieces. */
  private absorb(chunk: string): void {
    this.buffer += chunk
    let cut = this.buffer.indexOf('\n')
    while (cut !== -1) {
      const line = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut + 1)
      cut = this.buffer.indexOf('\n')
      if (!line) continue
      try {
        const reply = JSON.parse(line) as { id?: number }
        const call = typeof reply.id === 'number' ? this.pending.get(reply.id) : undefined
        if (!call || typeof reply.id !== 'number') continue
        clearTimeout(call.timer)
        this.pending.delete(reply.id)
        call.resolve(reply)
      } catch {
        // A line that is not JSON is PowerShell talking to itself. Ignored.
      }
    }
  }
}

/** A driver reply's window list, checked field by field. */
function readWindows(raw: unknown): ForeignWindow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    const w = entry as Partial<ForeignWindow>
    if (typeof w.hwnd !== 'string' || typeof w.pid !== 'number') return []
    return [
      {
        hwnd: w.hwnd,
        pid: w.pid,
        title: typeof w.title === 'string' ? w.title : '',
        executable: typeof w.executable === 'string' ? w.executable : '',
        visible: Boolean(w.visible),
        minimized: Boolean(w.minimized),
      },
    ]
  })
}
