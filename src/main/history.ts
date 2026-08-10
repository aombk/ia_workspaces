/**
 * Every command line submitted in any pane, newest first.
 *
 * Nearly free, because the data was already being collected: the shell
 * integration emits a `133;E` marker carrying each submitted line, the OSC
 * scanner already parses it, and the app already records the most recent one
 * per pane so a restored agent pane can be resumed. All that was missing was
 * keeping more than one of them.
 *
 * Shared across panes rather than kept per pane, because that is how the
 * question is actually asked — "what was that curl invocation" is a thing you
 * remember typing, not a thing you remember typing *there*. The pane and folder
 * travel with each entry anyway, so a per-pane view remains possible.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import type { HistoryEntry } from '../shared/types'

/**
 * How much to keep.
 *
 * Chosen against the file rather than the UI: five hundred entries is a couple
 * of hundred kilobytes at worst, loads instantly, and is far more than anyone
 * scrolls. A ring rather than a growing log, because a history file that only
 * ever grows is a thing that eventually needs its own maintenance story.
 */
const CAP = 500

/** A line longer than this is a paste, not a command worth remembering. */
const MAX_COMMAND = 2000

export class CommandHistory {
  private entries: HistoryEntry[] = []
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        this.entries = parsed
          .filter(
            (e): e is HistoryEntry =>
              !!e && typeof (e as HistoryEntry).command === 'string'
          )
          .slice(0, CAP)
      }
    } catch {
      // No history yet, or a file we cannot read. Either way this run starts
      // collecting rather than failing.
    }
  }

  /**
   * Records a submitted line.
   *
   * Re-running something moves it to the front instead of adding a second copy:
   * a history where `npm test` appears forty times is a history you cannot
   * scroll. The folder is part of the identity, because the same command in two
   * projects is two different things worth reaching separately.
   */
  add(command: string, cwd: string, paneId?: string): void {
    const text = command.trim()
    if (!text || text.length > MAX_COMMAND) return

    const at = Date.now()
    const existing = this.entries.findIndex((e) => e.command === text && e.cwd === cwd)
    if (existing !== -1) this.entries.splice(existing, 1)
    this.entries.unshift({ command: text, cwd, at, paneId })
    if (this.entries.length > CAP) this.entries.length = CAP

    this.dirty = true
    this.schedule()
  }

  /** Newest first. `limit` clamps what crosses the IPC boundary. */
  recent(limit = CAP): HistoryEntry[] {
    return this.entries.slice(0, Math.max(1, Math.min(limit, CAP)))
  }

  /**
   * Writes on a timer rather than per command.
   *
   * A command is submitted whenever anyone presses Enter, in any pane. Writing
   * the whole file each time would put a disk write on the keyboard, which is
   * exactly the sort of cost that only shows up on somebody else's machine.
   */
  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 5000)
    this.timer.unref?.()
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    try {
      writeFileSync(this.file, JSON.stringify(this.entries), 'utf8')
    } catch {
      // Losing history is not worth failing anything over.
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.flush()
  }
}
