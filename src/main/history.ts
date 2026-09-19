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
import { readDurable, writeDurable } from './durableWrite'
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

/**
 * The line this app types into a restored agent pane, exactly as it composes it.
 *
 * Recorded as an ordinary command until `synthetic` reached this file, so a
 * history written by an earlier version has one of these per agent pane per
 * restart — each naming a conversation that has already been resumed, none of
 * them anything anybody typed or would want back. They are dropped on load.
 *
 * Anchored, and the id has to be a UUID: `claude --resume` is a thing a person
 * may well type themselves, and only the shape this app generates is ours to
 * throw away.
 */
const RESUME_LINE = /^claude --resume [0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export class CommandHistory {
  private entries: HistoryEntry[] = []
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file: string) {
    // Falls back to the copy of the previous version when the live file cannot
    // be read — a power cut leaves one of the right length full of NUL bytes,
    // and reading that as "no history" would quietly discard months of it.
    const parsed = readDurable<unknown>(
      file,
      (text) => JSON.parse(text) as unknown,
      () => console.error('[history] file was unreadable; recovered the previous version')
    )

    if (Array.isArray(parsed)) {
      this.entries = parsed
        .filter(
          (e): e is HistoryEntry => !!e && typeof (e as HistoryEntry).command === 'string'
        )
        // A file written before the counts existed has none, and every reader
        // treats an absent count as "one run, never failed". Normalised here
        // rather than at each reader, so there is one place that decides what
        // an old entry means.
        .map((e) => ({ ...e, runs: e.runs ?? 1, fails: e.fails ?? 0 }))
        .slice(0, CAP)

      // Cleared out on the first load that knows about them — see `RESUME_LINE`.
      // Written back straight away rather than left to the next command, so the
      // file stops carrying them whether or not anything else happens.
      const kept = this.entries.filter((e) => !RESUME_LINE.test(e.command))
      if (kept.length !== this.entries.length) {
        this.entries = kept
        this.dirty = true
        this.flush()
      }
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
    // The entry that was already here carries its own past with it. Removing and
    // re-inserting is how this list has always worked — it is what keeps the
    // most recent at the top — and the counts have to survive that move, or a
    // command you run every day would report having been run once.
    const previous = existing === -1 ? null : this.entries[existing]
    if (existing !== -1) this.entries.splice(existing, 1)

    this.entries.unshift({
      command: text,
      cwd,
      at,
      paneId,
      runs: (previous?.runs ?? (previous ? 1 : 0)) + 1,
      fails: previous?.fails ?? 0,
      // Deliberately not carried over. The last run is the one that just
      // started, and it has no outcome yet — leaving the previous run's code
      // here would report the old result as if it were this one's.
      lastCode: undefined,
      lastMs: undefined,
    })
    if (this.entries.length > CAP) this.entries.length = CAP

    this.dirty = true
    this.schedule()
  }

  /**
   * Stamps the outcome onto the command a pane most recently started.
   *
   * Found by pane rather than by position: `add` puts the newest at the front of
   * a list shared by every pane, so by the time a slow build finishes, three
   * other panes may have pushed entries in front of it. The newest entry *for
   * this pane* is unambiguous, because a pane runs one command at a time.
   *
   * A command that never reports — no shell integration, a pane killed
   * mid-command — simply keeps `lastCode` undefined, which reads as "not known"
   * everywhere and never as "succeeded".
   */
  finish(paneId: string, exitCode: number, ms: number): void {
    if (!paneId) return
    const entry = this.entries.find((e) => e.paneId === paneId)
    if (!entry) return

    entry.lastCode = exitCode
    entry.lastMs = ms
    if (exitCode !== 0) entry.fails = (entry.fails ?? 0) + 1

    this.dirty = true
    this.schedule()
  }

  /**
   * Forgets a command.
   *
   * By text alone when no folder is given, because that is how the list is read:
   * a line you never want to see again is not one you want to delete once per
   * project it was run in. Returns how many went, so a caller can say nothing
   * happened rather than redraw an unchanged list.
   */
  remove(command: string, cwd?: string): number {
    const before = this.entries.length
    this.entries = this.entries.filter(
      (e) => e.command !== command || (cwd !== undefined && e.cwd !== cwd)
    )
    const gone = before - this.entries.length
    if (!gone) return 0

    this.dirty = true
    // Written now rather than on the timer. Forgetting is the one operation
    // somebody may well quit straight after, and a delete that comes back after
    // a restart is worse than no delete at all.
    this.flush()
    return gone
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
      // Durably, and with the version it replaces kept beside it. This wrote
      // straight over the live file until a power cut took the workspace
      // document out the same way — and unlike that one, this holds the run
      // counts and outcomes, which cannot be reconstructed from anything.
      writeDurable(this.file, JSON.stringify(this.entries), { backup: true })
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
