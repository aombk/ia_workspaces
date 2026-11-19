import {
  ABANDONED_AFTER_MS,
  DONE_LINGER_MS,
  FAILED_LINGER_MS,
  applyJobReport,
  jobVisible,
  type JobReport,
  type PaneJob,
} from '../shared/jobs'

/**
 * The jobs each pane has declared over `iaw job`.
 *
 * The rules — what a report does, when a job is stale, what the time left is —
 * are in `shared/jobs.ts`, where the renderer can use them too. This holds the
 * state and decides *when the renderer hears about it*, which is the part that
 * has a cost.
 *
 * A script is invited to call `iaw job update` several times a second, and
 * every call used to be a candidate for a message to every window. So updates
 * are coalesced: a pane's first change goes out at once, and anything arriving
 * within `EMIT_EVERY_MS` of it is folded into one trailing message carrying the
 * latest state. Starting, finishing and failing skip the queue — those are the
 * moments somebody is waiting to see, and a quarter of a second of lag on a
 * failure reads as the app being slow.
 *
 * Finished jobs are dropped on their own clock, so a pane whose jobs are all
 * over goes back to having no strip without anybody asking.
 */

/** At most this often per pane, a progress update reaches the renderer. */
export const EMIT_EVERY_MS = 250

export class JobRegistry {
  private readonly jobs = new Map<string, PaneJob[]>()
  private readonly lastEmit = new Map<string, number>()
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly expiries = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly onChange: (paneId: string, jobs: PaneJob[]) => void,
    /** Injected so the time-based rules can be tested without waiting. */
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Applies a report. Returns an error to hand back to `iaw`, or null. */
  report(paneId: string, report: JobReport): string | null {
    const now = this.now()
    const result = applyJobReport(this.jobs.get(paneId) ?? [], report, now)
    if ('error' in result) return result.error
    this.jobs.set(paneId, result.jobs)
    this.scheduleExpiry(paneId)
    this.emit(paneId, report.action !== 'update')
    return null
  }

  snapshot(paneId: string): PaneJob[] {
    return this.jobs.get(paneId) ?? []
  }

  /**
   * Drops what is no longer worth drawing. Public so a test can move the clock
   * and ask, rather than waiting out a real ten seconds.
   */
  prune(paneId: string): void {
    const jobs = this.jobs.get(paneId)
    if (!jobs) return
    const now = this.now()
    const kept = jobs.filter((job) => jobVisible(job, now))
    if (kept.length === jobs.length) {
      this.scheduleExpiry(paneId)
      return
    }
    if (kept.length) this.jobs.set(paneId, kept)
    else this.jobs.delete(paneId)
    this.scheduleExpiry(paneId)
    this.emit(paneId, true)
  }

  /** The pane is gone, and every job reporting to it with it. */
  release(paneId: string): void {
    const had = this.jobs.delete(paneId)
    this.clearTimer(this.pending, paneId)
    this.clearTimer(this.expiries, paneId)
    this.lastEmit.delete(paneId)
    if (had) this.onChange(paneId, [])
  }

  /**
   * One timer per pane, for whichever of its jobs leaves first. Re-armed on
   * every change rather than kept per job, so a pane with a dozen jobs still
   * holds one timer.
   */
  private scheduleExpiry(paneId: string): void {
    this.clearTimer(this.expiries, paneId)
    const jobs = this.jobs.get(paneId)
    if (!jobs?.length) return
    const now = this.now()
    let soonest = Infinity
    for (const job of jobs) {
      const at =
        job.state === 'done'
          ? (job.endedAt ?? job.updatedAt) + DONE_LINGER_MS
          : job.state === 'failed'
            ? (job.endedAt ?? job.updatedAt) + FAILED_LINGER_MS
            : job.updatedAt + ABANDONED_AFTER_MS
      soonest = Math.min(soonest, at)
    }
    const timer = setTimeout(() => {
      this.expiries.delete(paneId)
      this.prune(paneId)
    }, Math.max(50, soonest - now + 20))
    // Never the reason a process stays up — a test, or the app quitting.
    timer.unref?.()
    this.expiries.set(paneId, timer)
  }

  private emit(paneId: string, urgent: boolean): void {
    const now = this.now()
    const last = this.lastEmit.get(paneId) ?? -Infinity
    if (urgent || now - last >= EMIT_EVERY_MS) {
      this.clearTimer(this.pending, paneId)
      this.lastEmit.set(paneId, now)
      this.onChange(paneId, this.snapshot(paneId))
      return
    }
    if (this.pending.has(paneId)) return
    const timer = setTimeout(() => {
      this.pending.delete(paneId)
      this.lastEmit.set(paneId, this.now())
      this.onChange(paneId, this.snapshot(paneId))
    }, EMIT_EVERY_MS - (now - last))
    timer.unref?.()
    this.pending.set(paneId, timer)
  }

  private clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, paneId: string): void {
    const timer = map.get(paneId)
    if (timer !== undefined) clearTimeout(timer)
    map.delete(paneId)
  }
}
