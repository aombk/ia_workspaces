/**
 * GUI programs a workspace owns, and where their windows are.
 *
 * A terminal can already start a GUI program; what happened next was nothing —
 * the window went wherever the system put it and stayed there through every
 * workspace switch, so eleven projects' worth of tool windows piled up on one
 * desktop. This makes a launched program part of the workspace that launched
 * it: away while you are elsewhere, back when you return, and optionally kept
 * over one pane while you are here.
 *
 * **Three modes, and the difference is only how much we touch the window.**
 * `free` launches and forgets. `follow` is visibility alone — the window keeps
 * the size and position you gave it. `snap` adds a rectangle to sit over. See
 * `ExternalAppMode`; the escalation is deliberate, because each step is a step
 * further into somebody else's program.
 *
 * **Hiding is the dangerous one and it is treated that way.** A hidden window
 * is not in the taskbar, so if this app dies while one is hidden, the window is
 * on screen nowhere and in the taskbar nowhere. Three things pay that back: it
 * is not the default (`minimize` is), every hidden handle is written to a
 * recovery file that the next start reads and restores, and quitting restores
 * everything first.
 *
 * **The pid tree, not the pid.** Launchers exist: the thing you start is often
 * a stub that spawns the real program and exits. So the windows we look for are
 * those of the launched process *and its descendants*, refreshed each sync —
 * which also means a program that opens a second window is picked up without
 * being asked about.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createWindowDriver, type ScreenRect, type WindowAction, type WindowDriver } from './windowctl'
import type { AttachableWindow, ExternalApp, ExternalAppSync, RunningApp } from '../shared/types'

/**
 * What the renderer asks for, once the host has converted its rectangles.
 *
 * The same message the renderer sends — see `ExternalAppSync` — with the
 * rectangles now in physical screen pixels rather than CSS ones inside the
 * window. `main.ts` does that conversion, because only it knows where the
 * window is and what the display's scale is.
 */
export type AppSyncRequest = Omit<ExternalAppSync, 'rects'> & {
  rects: Record<string, ScreenRect>
}

interface Tracked {
  app: ExternalApp
  workspaceId: string
  pid: number
  /** Handles seen for this program, so hiding survives a failed re-list. */
  hwnds: Set<string>
  away: boolean
  /** The rectangle last sent, so an unchanged layout costs no calls. */
  placed: string
  /** The program and everything under it, and when that was last worked out. */
  pids: number[]
  pidsAt: number
  /**
   * Bound to a window somebody pointed at, rather than to a process we started.
   *
   * It changes what "still there" means. A launched program is re-listed from
   * its pids, so a window that closes and reopens is picked up again; an
   * attached one is exactly the handle that was chosen, and when that handle
   * stops existing the entry is done rather than reattached to whatever the
   * program opened next.
   */
  attached: boolean
}

/** How often a program is re-scanned for windows after it is launched. */
const WATCH_MS = 700

/** How long to keep looking for a first window before giving up on one. */
const WATCH_FOR_MS = 60_000

/**
 * How often the window list is actually re-read.
 *
 * `sync` is called on every layout change, and dragging a split calls it many
 * times a second. Asking `user32` that often is wasteful and asking it *while
 * dragging* is worse than useless — the answer cannot have changed. Placement
 * still happens on every call; only the enumeration is rationed.
 */
const RELIST_MS = 900

/**
 * How often a dormant attachment goes looking for its window again.
 *
 * Rare on purpose: it costs a full window enumeration, and the thing it is
 * waiting for — a program being started by hand — happens on human time.
 */
const REATTACH_MS = 6_000

/**
 * How often the process tree is walked again.
 *
 * This is the expensive one — a CIM query over every process on the machine —
 * and it exists for the launcher case, where the program you started is a stub
 * that spawns the real thing. Once a program has a window, that question is
 * answered, so this only runs while a program has none or the answer is old.
 */
const REWALK_MS = 15_000

export interface ExternalAppsDeps {
  /** Where the recovery file and the helper script live. */
  dataDir: string
  /** Descendant pids of a process, for the launcher case. */
  descendants(pid: number): Promise<number[]>
  /** Every pid running an executable of this name, for the adopt-by-name case. */
  pidsNamed(executable: string): Promise<number[]>
}

export class ExternalApps {
  private readonly control: WindowDriver
  private readonly running = new Map<string, Tracked>()
  private watching: NodeJS.Timeout | null = null
  private watchUntil = 0
  private relistedAt = 0
  private reattachedAt = 0
  private lastSync: AppSyncRequest | null = null

  constructor(private readonly deps: ExternalAppsDeps) {
    this.control = createWindowDriver((text: string) => this.writeHelper(text))
  }

  /** Whether this platform can place other programs' windows at all. */
  get supported(): boolean {
    return this.control.supported
  }

  /** Why not, when it cannot — shown rather than swallowed. */
  get reason(): string {
    return this.control.reason
  }

  /** Whether the rectangles it wants are points rather than pixels. */
  get logicalPixels(): boolean {
    return this.control.logicalPixels
  }

  /**
   * Puts back anything a previous run left hidden.
   *
   * Called once at startup, before a window of ours exists. The handles are
   * almost always stale — the programs died with the app — and a stale handle
   * is simply refused by the helper, which is why this can be unconditional.
   */
  recover(): void {
    const file = this.recoveryFile()
    if (!existsSync(file)) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      const hwnds = Array.isArray(raw) ? raw.filter((h): h is string => typeof h === 'string') : []
      if (hwnds.length) {
        void this.control.apply(hwnds.map((hwnd) => ({ hwnd, action: 'show' as const })))
      }
    } catch {
      // A corrupt file is a file we no longer need.
    }
    try {
      rmSync(file, { force: true })
    } catch {
      /* it will be overwritten */
    }
  }

  /**
   * Starts a program, and begins watching for the windows it draws.
   *
   * One at a time per configured program, and the guard is not a nicety: what
   * is tracked is keyed by the program, so a second launch would take the first
   * one's place and leave its windows managed by nobody — including, if it were
   * off screen at the time, hidden by nobody.
   */
  async launch(app: ExternalApp, workspaceId: string, fallbackCwd: string): Promise<number | null> {
    const already = this.running.get(app.id)
    if (already) return already.pid
    if (!app.command) return null
    const command = app.command
    const cwd = app.cwd || fallbackCwd
    let pid: number | undefined
    try {
      // Detached, like every other program you start from a terminal: closing
      // the app is not a reason to kill the editor you opened from it. Streams
      // are ignored rather than piped — a GUI program that writes to stdout
      // must not fill a buffer nobody reads and block.
      const child = spawn(command, splitArgs(app.args ?? ''), {
        cwd: existsSync(cwd) ? cwd : undefined,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.unref()
      pid = child.pid
      child.on('error', () => this.running.delete(app.id))
    } catch {
      return null
    }
    if (!pid) return null

    this.running.set(app.id, {
      app,
      workspaceId,
      pid,
      hwnds: new Set(),
      away: false,
      placed: '',
      pids: [pid],
      pidsAt: 0,
      attached: false,
    })
    this.watch()
    return pid
  }

  /**
   * Every window on screen, for the picker that binds one to a workspace.
   *
   * Windows this app already manages are left in — attaching one twice is
   * refused by `attach` rather than hidden here, because a window missing from
   * the list with no explanation is the more confusing of the two.
   */
  async attachable(): Promise<AttachableWindow[]> {
    const windows = await this.control.listAll()
    return windows
      .filter((window) => window.title.trim())
      .map(({ hwnd, pid, title, executable }) => ({ hwnd, pid, title, executable }))
  }

  /**
   * Binds one window that is already open to a workspace.
   *
   * The whole point of the feature: two copies of the same program, one per
   * project, each disappearing with its own workspace. A path to an executable
   * cannot express that and never could — this can, because it names the
   * window rather than the program.
   *
   * Nothing is launched and no process tree is walked. The handle *is* the
   * subscription, and when the window goes so does the entry.
   */
  attach(appId: string, workspaceId: string, app: ExternalApp, hwnd: string, pid: number): boolean {
    for (const [id, tracked] of this.running) {
      if (id !== appId && tracked.hwnds.has(hwnd)) return false
    }
    this.running.set(appId, {
      app,
      workspaceId,
      pid,
      hwnds: new Set([hwnd]),
      away: false,
      placed: '',
      // Empty on purpose: an attached window is followed by its handle, not by
      // its process, so there is no tree to walk and nothing to re-walk.
      pids: [],
      pidsAt: Number.MAX_SAFE_INTEGER,
      attached: true,
    })
    return true
  }

  /** Forgets a program without touching it — its window is left where it is. */
  release(appId: string): void {
    const tracked = this.running.get(appId)
    if (!tracked) return
    this.running.delete(appId)
    if (!tracked.hwnds.size || !tracked.away) return
    void this.control.apply([...tracked.hwnds].map((hwnd) => ({ hwnd, action: 'show' as const })))
    this.rememberHidden()
  }

  /** What is being managed, for the menu that says so. */
  list(): RunningApp[] {
    return [...this.running.values()].map((t) => ({
      appId: t.app.id,
      workspaceId: t.workspaceId,
      pid: t.pid,
      windows: t.hwnds.size,
      away: t.away,
    }))
  }

  /**
   * The one call that does the work: given which workspace is on screen and
   * where the snapping panes are, make every tracked window agree.
   *
   * Called on a workspace switch, a tab switch and a layout change, so it is
   * written to be cheap when nothing moved — an unchanged rectangle sends no
   * action, and a program with no windows yet sends nothing at all.
   */
  async sync(request: AppSyncRequest): Promise<void> {
    this.lastSync = request
    if (!this.supported) return
    await this.reattachDormant(request)
    if (!this.running.size) return

    await this.refreshWindows()

    const actions: WindowAction[] = []
    for (const tracked of this.running.values()) {
      const app = request.apps[tracked.app.id] ?? tracked.app
      tracked.app = app
      if (!tracked.hwnds.size) continue

      // Left alone entirely. Mode is read fresh each sync, so switching a
      // program to `free` releases it from the next sync onwards rather than
      // needing a relaunch.
      if (app.mode === 'free') {
        if (tracked.away) {
          for (const hwnd of tracked.hwnds) actions.push({ hwnd, action: 'show' })
          tracked.away = false
        }
        continue
      }

      const here = tracked.workspaceId === request.activeWorkspaceId
      if (!here) {
        if (!tracked.away) {
          for (const hwnd of tracked.hwnds) {
            actions.push({ hwnd, action: app.away === 'hide' ? 'hide' : 'minimize' })
          }
          tracked.away = true
          tracked.placed = ''
        }
        continue
      }

      if (tracked.away) {
        for (const hwnd of tracked.hwnds) {
          actions.push({ hwnd, action: app.away === 'hide' ? 'show' : 'restore' })
        }
        tracked.away = false
      }

      // Snapping only ever moves the first window. A program's second window is
      // a dialog or a palette, and dropping one of those onto the pane
      // rectangle on top of the main window is not what anybody meant.
      const rect = app.mode === 'snap' ? request.rects[app.id] : undefined
      if (!rect) {
        tracked.placed = ''
        continue
      }
      const signature = `${rect.x},${rect.y},${rect.width},${rect.height}`
      if (signature === tracked.placed) continue
      tracked.placed = signature
      const [first] = tracked.hwnds
      if (first) actions.push({ hwnd: first, action: 'place', ...rect })
    }

    if (actions.length) {
      const applied = new Set(await this.control.apply(actions))
      this.dropClosedAttachments(actions, applied)
    }
    this.rememberHidden()
  }

  /**
   * Forgets an attached window that no longer exists.
   *
   * A handle the driver refuses is a window that has closed — the program quit,
   * or the document was closed — and an attachment is to that window and no
   * other. Free to detect: it is what the driver already told us about the
   * batch it just ran. Launched entries are exempt, because there the program
   * is the subscription and the next window it opens is still its window.
   */
  private dropClosedAttachments(actions: readonly WindowAction[], applied: Set<string>): void {
    for (const [id, tracked] of [...this.running]) {
      if (!tracked.attached) continue
      const mine = actions.filter((action) => tracked.hwnds.has(action.hwnd))
      if (!mine.length) continue
      if (mine.some((action) => applied.has(action.hwnd))) continue
      this.running.delete(id)
    }
  }

  /**
   * Everything back on screen, whatever workspace it belongs to.
   *
   * The escape hatch, and the thing quitting calls. It deliberately does not
   * clear `away`: this is "I want to see them", not a change to where they
   * belong, and the next sync puts them back under the rule they were under.
   */
  async showAll(): Promise<void> {
    const actions: WindowAction[] = []
    for (const tracked of this.running.values()) {
      for (const hwnd of tracked.hwnds) actions.push({ hwnd, action: 'show' })
    }
    if (actions.length) await this.control.apply(actions)
    this.forgetHidden()
  }

  /** Restores every hidden window and stops the helper. */
  async dispose(): Promise<void> {
    await this.showAll()
    if (this.watching) clearInterval(this.watching)
    this.watching = null
    this.control.dispose()
  }

  // ------------------------------------------------------------------ private

  /**
   * Finds the windows that attached entries were bound to before a restart.
   *
   * A handle does not survive the program that owned it, so what was written
   * down is the pair a person would use — the program, and the title. This
   * binds an entry again when that pair matches **exactly one** window on
   * screen.
   *
   * Exactly one, and never the first of several. Two copies of Projucer with
   * the same document open is precisely the case this feature exists for, and
   * guessing between them would silently put the wrong instance in the wrong
   * workspace — which is worse than leaving the entry dormant and letting
   * somebody point at the right one.
   */
  private async reattachDormant(request: AppSyncRequest): Promise<void> {
    const dormant = Object.values(request.apps).filter(
      (app) => app.attached && !this.running.has(app.id)
    )
    if (!dormant.length) return
    const now = Date.now()
    if (now - this.reattachedAt < REATTACH_MS) return
    this.reattachedAt = now

    const windows = await this.control.listAll()
    if (!windows.length) return
    const taken = new Set([...this.running.values()].flatMap((t) => [...t.hwnds]))

    for (const app of dormant) {
      const wanted = app.attached
      const workspaceId = request.owners[app.id]
      if (!wanted || !workspaceId) continue
      const matches = windows.filter(
        (window) =>
          !taken.has(window.hwnd) &&
          window.executable === wanted.executable &&
          window.title === wanted.title
      )
      if (matches.length !== 1) continue
      const [match] = matches
      if (this.attach(app.id, workspaceId, app, match.hwnd, match.pid)) taken.add(match.hwnd)
    }
  }

  /**
   * Re-reads which windows each program owns.
   *
   * Every sync, not once at launch: a program that opens a second window, or
   * replaces its splash screen with a real one, must not be half-managed. The
   * pid tree is re-walked for the same reason — a launcher's child can appear
   * a second after the launcher exits.
   */
  private async refreshWindows(): Promise<void> {
    const now = Date.now()
    if (now - this.relistedAt < RELIST_MS) return
    this.relistedAt = now

    const owners = new Map<number, Tracked>()
    for (const tracked of this.running.values()) {
      // An attached entry is its handle. There is no pid tree behind it and
      // nothing to rediscover, so it takes no part in the enumeration below.
      if (tracked.attached) continue
      // The walk is skipped for a program that already has a window and was
      // walked recently — which is every program, almost all of the time.
      if (!tracked.hwnds.size || now - tracked.pidsAt > REWALK_MS) {
        tracked.pids = [tracked.pid, ...(await this.deps.descendants(tracked.pid))]
        if (tracked.app.adopt === 'name' && tracked.app.command) {
          tracked.pids.push(...(await this.deps.pidsNamed(executableOf(tracked.app.command))))
        }
        tracked.pidsAt = now
      }
      for (const pid of tracked.pids) owners.set(pid, tracked)
    }
    if (!owners.size) return

    const windows = await this.control.windowsOf([...owners.keys()])
    // A failed call answers with nothing, which must not be read as "the
    // program closed its windows" — that would leave a hidden window untracked
    // and therefore unrecoverable.
    if (!windows.length) return

    // Adopted while on screen, kept once adopted.
    //
    // Both halves matter. Only claiming a window that is currently visible
    // keeps a program's invisible scaffolding out — measured on Notepad, which
    // keeps an unshown helper window alive the whole time. Keeping one we have
    // already claimed is what makes hiding safe: a window we hid is invisible
    // by definition, and dropping it here would leave it hidden with nothing
    // left holding its handle.
    const seen = new Map<Tracked, Set<string>>()
    for (const window of windows) {
      const tracked = owners.get(window.pid)
      if (!tracked) continue
      if (!window.visible && !tracked.hwnds.has(window.hwnd)) continue
      const set = seen.get(tracked) ?? new Set<string>()
      set.add(window.hwnd)
      seen.set(tracked, set)
    }
    for (const [tracked, set] of seen) tracked.hwnds = set
  }

  /**
   * Polls for windows shortly after a launch, then stops.
   *
   * A program takes a moment to draw its first window and there is no event for
   * it. Rather than poll forever, this runs for a minute after the most recent
   * launch — long enough for a slow Java or Electron tool, short enough that an
   * idle app is not asking `user32` about pids for the rest of the day.
   */
  private watch(): void {
    this.watchUntil = Date.now() + WATCH_FOR_MS
    if (this.watching) return
    this.watching = setInterval(() => {
      if (Date.now() > this.watchUntil || !this.running.size) {
        if (this.watching) clearInterval(this.watching)
        this.watching = null
        return
      }
      if (this.lastSync) void this.sync(this.lastSync)
    }, WATCH_MS)
  }

  private recoveryFile(): string {
    return path.join(this.deps.dataDir, 'hidden-windows.json')
  }

  /**
   * Records which handles are hidden right now.
   *
   * The whole point of the file is the crash we did not survive, so it is
   * written on every change rather than at quit. Minimised windows are not
   * recorded — they are in the taskbar, and the user can get them back without
   * us.
   */
  private rememberHidden(): void {
    const hidden: string[] = []
    for (const tracked of this.running.values()) {
      if (!tracked.away || tracked.app.away !== 'hide') continue
      hidden.push(...tracked.hwnds)
    }
    if (!hidden.length) {
      this.forgetHidden()
      return
    }
    try {
      mkdirSync(this.deps.dataDir, { recursive: true })
      writeFileSync(this.recoveryFile(), JSON.stringify(hidden), 'utf8')
    } catch {
      // Best effort. A missing recovery file costs a restore we would have
      // liked; a throw here would cost the workspace switch it happened during.
    }
  }

  private forgetHidden(): void {
    try {
      rmSync(this.recoveryFile(), { force: true })
    } catch {
      /* nothing to remove */
    }
  }

  private writeHelper(text: string): string | null {
    try {
      mkdirSync(this.deps.dataDir, { recursive: true })
      const file = path.join(this.deps.dataDir, 'windowctl.ps1')
      // Rewritten every start rather than checked: the script is ours, it is
      // small, and a stale copy from an older version is a bug that would only
      // show up as a feature quietly not working.
      writeFileSync(file, text, 'utf8')
      return file
    } catch {
      return null
    }
  }
}

/** The executable's own file name, which is what a process is listed under. */
export function executableOf(command: string): string {
  return command.split(/[\/]/).pop() ?? command
}

/**
 * A command-line string as a list of arguments.
 *
 * Quotes group, and nothing else is interpreted — no variables, no escapes, no
 * globbing. This is a field in a settings dialog, not a shell, and a field that
 * silently behaves like a shell is how a path with an ampersand in it becomes
 * two commands.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
      continue
    }
    if (/\s/.test(ch)) {
      if (has || current) out.push(current)
      current = ''
      has = false
      continue
    }
    current += ch
  }
  if (has || current) out.push(current)
  return out
}
