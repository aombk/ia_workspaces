/**
 * How long you actually spent on each project, without being asked.
 *
 * Every time tracker has the same defect and it is not a feature gap: you have
 * to remember to press start, and you don't. Toggl and Clockify are good
 * software wrapped around a discipline almost nobody sustains, and the result
 * is a timesheet with holes in it that you then reconstruct from memory — which
 * is to say, invent.
 *
 * This app never has to ask. It already knows which workspace is on screen,
 * whether its window has focus, and whether anything is happening in it. So the
 * timesheet is *observed*, and the only thing left for a person to do is
 * correct it, which is a far smaller job than creating it.
 *
 * **What counts as working.** A span is open while the window has focus and a
 * workspace is on screen. Focus is the honest signal: an app left running
 * behind a browser is not somebody working on that project, and counting it
 * would produce the flattering, useless numbers that make people stop believing
 * a tracker. Thinking time *does* count — reading code with the window in front
 * of you is work, and a tracker that demanded keystrokes would punish the part
 * of the job that matters most.
 *
 * **What stops a span.** Losing focus, switching workspace, or the heartbeats
 * stopping — which is what a crash, a sleep or a kill looks like from here. A
 * span that stopped being heard from is closed at the last beat that was
 * actually heard, never at the time the app noticed, so a laptop closed at six
 * does not record until nine the next morning.
 */
import path from 'node:path'
import { readDurable, writeDurable } from './durableWrite'

/** A stretch of time on one project. Minutes, not milliseconds, once stored. */
export interface TimeSpan {
  /** The workspace's folder, which is what identifies a project across renames. */
  cwd: string
  /** What it was called when the time was spent. */
  name: string
  /** Epoch milliseconds. */
  start: number
  end: number
}

/**
 * How often the renderer says what is on screen.
 *
 * Short enough that the last beat is a good estimate of when a session really
 * ended, long enough to be nothing. The cost is one small IPC message.
 */
export const HEARTBEAT_MS = 15_000

/**
 * How long a span may go unheard from before it is considered over.
 *
 * Two missed beats. One can be missed by a busy main thread or a laptop
 * hesitating; two means something stopped.
 */
const LOST_MS = HEARTBEAT_MS * 2.5

/**
 * Spans shorter than this are dropped rather than recorded.
 *
 * Clicking through four workspaces to find one is not four sessions of work,
 * and a day's log made mostly of eight-second fragments is a log nobody reads.
 */
const MIN_SPAN_MS = 30_000

/**
 * How long a log is kept.
 *
 * A year of spans is a couple of hundred kilobytes and answers every question
 * anybody asks of a timesheet. Beyond that it is history nobody consults, and
 * this file is read in full at startup.
 */
const KEEP_DAYS = 400

export class TimeLog {
  private spans: TimeSpan[] = []
  /** The span being accumulated, not yet in `spans`. */
  private open: (TimeSpan & { lastBeat: number }) | null = null
  private dirty = false
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly file: string) {
    const parsed = readDurable<unknown>(
      file,
      (text) => JSON.parse(text) as unknown,
      () => console.error('[time] log was unreadable; recovered the previous version')
    )
    if (Array.isArray(parsed)) {
      this.spans = parsed.filter(
        (s): s is TimeSpan =>
          !!s &&
          typeof s.cwd === 'string' &&
          typeof s.start === 'number' &&
          typeof s.end === 'number' &&
          s.end > s.start
      )
      this.prune()
    }
  }

  /**
   * The renderer reporting what is on screen, once every `HEARTBEAT_MS`.
   *
   * `cwd` empty means nothing is being worked on — no focus, or no workspace —
   * and closes whatever was open. That is the same call, deliberately: a caller
   * that has to remember to say "stopped" is a caller that will forget on the
   * one path nobody tested.
   */
  beat(cwd: string, name: string, now = Date.now()): void {
    // Anything open that has not been heard from is finished, and finished at
    // the last beat that was heard rather than now. Otherwise a machine that
    // slept for the weekend logs the weekend.
    if (this.open && now - this.open.lastBeat > LOST_MS) this.close(this.open.lastBeat)

    if (!cwd) {
      this.close(now)
      return
    }

    if (this.open && this.open.cwd !== cwd) this.close(this.open.lastBeat)

    if (!this.open) {
      this.open = { cwd, name, start: now, end: now, lastBeat: now }
      return
    }

    this.open.end = now
    this.open.lastBeat = now
    // A workspace renamed mid-session is still the same session; the newest
    // name is the one worth keeping.
    this.open.name = name
  }

  /** Ends the open span, keeping it if it lasted long enough to mean anything. */
  close(at = Date.now()): void {
    const span = this.open
    this.open = null
    if (!span) return

    const end = Math.max(span.start, Math.min(at, span.end + LOST_MS))
    if (end - span.start < MIN_SPAN_MS) return

    this.spans.push({ cwd: span.cwd, name: span.name, start: span.start, end })
    this.dirty = true
    this.schedule()
  }

  /**
   * Everything recorded, including the span still running.
   *
   * The open one is included because a pane showing today's total with the
   * current session missing from it is a pane that looks broken — the number
   * would sit still while you watched it.
   */
  all(now = Date.now()): TimeSpan[] {
    const out = this.spans.slice()
    if (this.open && this.open.end - this.open.start >= MIN_SPAN_MS) {
      out.push({
        cwd: this.open.cwd,
        name: this.open.name,
        start: this.open.start,
        end: Math.min(now, this.open.end + HEARTBEAT_MS),
      })
    }
    return out
  }

  /** Called on quit, so the last session is not lost to the log never being written. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    try {
      this.prune()
      writeDurable(this.file, JSON.stringify(this.spans), { backup: true })
      this.dirty = false
    } catch (err) {
      console.error('[time] failed to persist the log', err)
    }
  }

  private schedule(): void {
    if (this.timer) return
    // Lazily: a span is minutes long, so there is no hurry, and a write per
    // span is a write per few minutes at worst.
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, 5000)
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000
    const kept = this.spans.filter((s) => s.end >= cutoff)
    if (kept.length !== this.spans.length) {
      this.spans = kept
      this.dirty = true
    }
  }
}

/** Where the log lives, beside everything else the app remembers. */
export function timeLogPath(dataDir: string): string {
  return path.join(dataDir, 'time-log.json')
}
