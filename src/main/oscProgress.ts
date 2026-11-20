import type { JobPhase, JobReport, PaneJob } from '../shared/jobs'

/**
 * Terminal progress reports — `ESC ] 9 ; 4 ; st ; pr ST` — as a job on the pane.
 *
 * The ConEmu convention, since taken up by Windows Terminal, Ghostty and
 * others: a program says how far through it is, and the terminal draws a bar
 * (a taskbar button, a tab). Here it is the same strip `iaw job` draws, and the
 * same rule holds — **declared, never inferred.** The program emitted the
 * sequence on purpose, with the number in it; nothing reads its output for
 * percentages.
 *
 *   st 0  clear        the bar goes
 *   st 1  normal       pr is 0–100
 *   st 2  error        pr optional
 *   st 3  indeterminate  pr ignored
 *   st 4  paused / warning  pr optional
 *
 * Read strictly, because `OSC 9` is crowded: ConEmu has a dozen other `9;n`
 * subcommands, and iTerm2 uses bare `OSC 9 ; text` for a notification whose
 * text could begin "4;". Only `4;` followed by a single state digit and, at
 * most, a whole number counts. Anything else that starts `4;` is dropped
 * rather than shown — the same as before this existed — because a progress
 * report the parser cannot read is not a notification either.
 */

export type OscProgressState = 0 | 1 | 2 | 3 | 4

export interface OscProgress {
  state: OscProgressState
  /** 0–100 when the report carried one. */
  pct?: number
}

/**
 * The part of an `OSC 9` payload after `9;`, as a progress report — or null
 * when it is not one, or is not one this can read with confidence.
 */
export function parseOscProgress(rest: string): OscProgress | null {
  // `4;st` or `4;st;pr`. Some programs end the state-0 form with a stray
  // separator (`4;0;`), which reads the same.
  const m = /^4;([0-4])(?:;(\d{0,3}))?$/.exec(rest)
  if (!m) return null
  const state = Number(m[1]) as OscProgressState
  const out: OscProgress = { state }
  if (m[2]) out.pct = Math.min(100, Number(m[2]))
  return out
}

/** The id the pane's terminal-reported job goes under. One per pane, as in every terminal that draws these. */
export const OSC_JOB_ID = 'osc'

/**
 * What a progress report does to the pane's `osc` job, given what it is now.
 *
 * Error is a phase of a running job, not a failure. ConEmu and Windows Terminal
 * both draw it as a red bar that can turn green again, and programs use it so:
 * winget, for one, flags an error and carries on. Calling it `failed` would end
 * a job the program had not ended, and refuse its next update. It becomes a
 * failure only if the program then clears the bar, or its command ends, while
 * still saying error — that is the last thing it said about the work.
 *
 * Clearing a bar that reached 100% is done; clearing one anywhere else just
 * removes it. The protocol has no "finished" — st 0 means only "stop drawing
 * this" — so a success is claimed only where the program's own last number
 * said the work was all there.
 */
export function oscProgressReports(
  current: PaneJob | undefined,
  progress: OscProgress,
  title: string
): JobReport[] {
  const running = current?.state === 'running' ? current : undefined
  if (progress.state === 0) return running ? [endReport(running)] : []

  const phase: JobPhase =
    progress.state === 2 ? 'error' : progress.state === 3 ? 'indeterminate' : progress.state === 4 ? 'paused' : 'normal'
  const update: JobReport = { action: 'update', id: OSC_JOB_ID, phase }
  // Windows Terminal ignores pr for indeterminate; so does this.
  if (progress.pct !== undefined && progress.state !== 3) update.pct = progress.pct
  if (running) return [update]
  return [{ action: 'start', id: OSC_JOB_ID, title }, update]
}

/** How a running `osc` job ends when the program clears it or its command ends. */
export function endReport(job: PaneJob): JobReport {
  if (job.phase === 'error') {
    return { action: 'fail', id: OSC_JOB_ID, reason: 'the program reported an error' }
  }
  if ((job.phase ?? 'normal') === 'normal' && job.fraction !== undefined && job.fraction >= 1) {
    return { action: 'done', id: OSC_JOB_ID }
  }
  return { action: 'clear', id: OSC_JOB_ID }
}

/**
 * Coalesces one pane's progress reports.
 *
 * Programs emit these at whatever rate they redraw — `curl` and package
 * managers, once per chunk, hundreds a second. The registry already limits how
 * often the window hears about a job; this limits how often the job is touched
 * at all. A change of state goes through at once, because that is news (an
 * error, a pause, the bar going). A run of reports in the same state is held to
 * one per `OSC_PROGRESS_EVERY_MS`, and the last of a burst is never lost: it
 * lands when the interval is up.
 */
export const OSC_PROGRESS_EVERY_MS = 200

export class OscProgressGate {
  private lastState: OscProgressState | null = null
  private lastAt = -Infinity
  private held: OscProgress | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly apply: (progress: OscProgress) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  push(progress: OscProgress): void {
    const now = this.now()
    if (progress.state !== this.lastState || now - this.lastAt >= OSC_PROGRESS_EVERY_MS) {
      this.cancel()
      this.send(progress, now)
      return
    }
    this.held = progress
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), OSC_PROGRESS_EVERY_MS - (now - this.lastAt))
    this.timer.unref?.()
  }

  /** Sends whatever is held now. Public so a test need not wait out the timer. */
  flush(): void {
    const held = this.held
    this.cancel()
    if (held) this.send(held, this.now())
  }

  /** Forgets everything: the command or the pane ended, and with it the program. */
  reset(): void {
    this.cancel()
    this.lastState = null
    this.lastAt = -Infinity
  }

  private send(progress: OscProgress, now: number): void {
    this.lastState = progress.state
    this.lastAt = now
    this.apply(progress)
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.held = null
  }
}
