/**
 * Long-running jobs a pane has declared, and how to show them honestly.
 *
 * A render, an upload, a test matrix: work started from a pane that runs for
 * minutes and that the pane's agent cannot see the inside of. The script doing
 * the work says how far it has got over `iaw job`, and the pane draws a strip
 * along its bottom edge.
 *
 * The same rule as the agent's own progress line: **declared, never inferred.**
 * Nothing here reads output looking for percentages. The one number the app
 * makes up itself is the time left, and it is marked as such — a `~`, computed
 * from the rate the job's own reports describe, and withheld until there is
 * enough of a history for a rate to mean anything.
 *
 * Shared between the main process, which holds the jobs, and the renderer,
 * which draws them — so the rules for what a job looks like at a given moment
 * live in one place, and can be tested without a window.
 */

export type JobState = 'running' | 'done' | 'failed'

/**
 * How a running job says it is going, beyond how far.
 *
 * Only terminal progress reports (OSC 9;4 — see `main/oscProgress.ts`) set
 * these; `iaw job` has no way to, and a job that never sets one is `normal`.
 * They are the program's own words, as declared as the percentage beside them:
 *
 * - `indeterminate` — working, and cannot say how far through. No percentage
 *   and no time left: there is nothing to compute one from.
 * - `paused` — said it has stopped moving. No time left, because a rate
 *   measured before the pause says nothing about after it.
 * - `error` — said something is wrong, and has not said it has stopped. Drawn
 *   in the failure colour, but still a running job: the program may carry on,
 *   and only its clearing the report, or its command ending, closes it.
 */
export type JobPhase = 'normal' | 'indeterminate' | 'paused' | 'error'

/** One job as the main process holds it and the renderer receives it. */
export interface PaneJob {
  id: string
  title: string
  state: JobState
  /** Units the job said it would do, when it said. */
  total?: number
  /** Units done, when it counts in units. */
  done?: number
  /** How far through, 0–1, when that can be known — from done/total or a percentage. */
  fraction?: number
  /** The job's own short note about what it is doing now. */
  detail?: string
  /** Why it failed, in its own words. */
  reason?: string
  startedAt: number
  /** The last report of any kind — what staleness is measured from. */
  updatedAt: number
  /** When it finished, either way. */
  endedAt?: number
  /** Silence longer than this makes the job stale. */
  ttlMs: number
  /** See `JobPhase`. Absent is `normal`. */
  phase?: JobPhase
  /**
   * The progress reports the current rate is measured over.
   *
   * `first` is where the measurement starts and `last` where it currently
   * ends. Counted from the first *progress* report rather than from `start`,
   * because the time between starting a job and its first unit of work is
   * setup — loading a model, opening a file — and a rate that averaged it in
   * would predict a long tail for a job that is in fact nearly done.
   */
  samples: number
  firstAt?: number
  firstFraction?: number
  lastAt?: number
}

/**
 * What `iaw job` sends. One shape for every action.
 *
 * `clear` and `phase` are not reachable from the command line: they exist for
 * terminal progress reports, which can withdraw a bar without saying how the
 * work went — see `main/oscProgress.ts`.
 */
export interface JobReport {
  action: 'start' | 'update' | 'done' | 'fail' | 'clear'
  id: string
  title?: string
  total?: number
  done?: number
  /** 0–100. */
  pct?: number
  detail?: string
  reason?: string
  /** Milliseconds of silence before the job reads as stale. */
  ttl?: number
  /** `update` only. See `JobPhase`. */
  phase?: JobPhase
}

/** How long silence may last before a running job says so. */
export const DEFAULT_JOB_TTL_MS = 30_000
/** A finished job stays long enough to be seen finishing, then goes. */
export const DONE_LINGER_MS = 10_000
/**
 * A failure stays longer, because it is the one outcome somebody has to act on
 * and they may not have been looking. The next job starting on the pane clears
 * it sooner — see `JobRegistry`.
 */
export const FAILED_LINGER_MS = 120_000
/**
 * A running job that has said nothing for this long is dropped.
 *
 * Its process is almost certainly gone — a script killed with Ctrl+C never
 * gets to say `fail` — and a strip that reads "no update for 9 h" for the rest
 * of the session is accurate and useless. Half an hour of saying "stale" first
 * is long enough to be noticed.
 */
export const ABANDONED_AFTER_MS = 30 * 60_000

/** The time-left estimate is withheld until the rate has this much behind it. */
export const ETA_MIN_SAMPLES = 2
export const ETA_MIN_HISTORY_MS = 3_000

/** What a row of the strip says, already decided. The renderer only draws it. */
export interface JobRow {
  id: string
  title: string
  /**
   * `stale` is a running job that has gone quiet — said, not hidden. `paused`
   * and `error` are running jobs that said so themselves; see `JobPhase`.
   */
  state: 'running' | 'stale' | 'paused' | 'error' | 'done' | 'failed'
  /** 0–100 for the bar, or undefined when nothing says how far through it is. */
  pct?: number
  /**
   * The job said it cannot tell how far through it is. Drawn as a moving bar
   * with no fill, which is different from a job that simply never said: that
   * one gets an empty track, because nothing claims it is moving.
   */
  indeterminate?: boolean
  /** "340/500", or "340" when there is no total. */
  count?: string
  elapsed: string
  /** "~1:20 left", only once there is a rate to compute it from. */
  eta?: string
  /** The job's detail, its failure reason, or how long it has been silent. */
  note?: string
}

/** Whether a job is still worth drawing at `now`. */
export function jobVisible(job: PaneJob, now: number): boolean {
  if (job.state === 'done') return now - (job.endedAt ?? job.updatedAt) < DONE_LINGER_MS
  if (job.state === 'failed') return now - (job.endedAt ?? job.updatedAt) < FAILED_LINGER_MS
  return now - job.updatedAt < ABANDONED_AFTER_MS
}

/**
 * A running job nobody has heard from within its TTL.
 *
 * Not one that said it is paused or cannot say how far it is: those have made
 * no claim that silence could contradict. A program sets "indeterminate" once
 * and then works for ten minutes without another word, and that is the report
 * being used as intended, not going stale. They are still dropped when they are
 * abandoned, like everything else — see `jobVisible`.
 */
export function jobStale(job: PaneJob, now: number): boolean {
  if (job.phase === 'paused' || job.phase === 'indeterminate') return false
  return job.state === 'running' && now - job.updatedAt > job.ttlMs
}

/**
 * Milliseconds left, or null when there is no honest answer.
 *
 * The rate is measured, not assumed: progress gained between the first and the
 * latest report, over the time between them. It needs two reports and a few
 * seconds between them — one report is a position, not a speed, and two
 * reports a quarter of a second apart are a speed measured over noise.
 *
 * The answer counts down between reports, because the clock moves even when
 * the job is quiet. It stops at zero rather than going negative: a job slower
 * than its own history is not "-0:12 left", it is late, and the next report
 * corrects the rate.
 *
 * A stale job gets nothing. An estimate is a claim that the rate still holds,
 * and silence is exactly the evidence that it may not.
 */
export function jobEtaMs(job: PaneJob, now: number): number | null {
  if (job.state !== 'running' || jobStale(job, now)) return null
  // Paused, erroring or not knowing: none of them is a rate to extrapolate.
  if (job.phase && job.phase !== 'normal') return null
  if (job.fraction === undefined || job.samples < ETA_MIN_SAMPLES) return null
  if (job.firstAt === undefined || job.firstFraction === undefined || job.lastAt === undefined) return null
  const span = job.lastAt - job.firstAt
  if (span < ETA_MIN_HISTORY_MS) return null
  const gained = job.fraction - job.firstFraction
  if (!(gained > 0)) return null
  const rate = gained / span
  const left = (1 - job.fraction) / rate - Math.max(0, now - job.lastAt)
  return Math.max(0, left)
}

/**
 * A duration as a clock: `0:45`, `12:03`, `1:02:09`.
 *
 * A clock rather than "45 s" because these sit side by side in a row and are
 * read against each other — elapsed beside time left — and a clock lines up.
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** A silence, the way a person would say it: `45 s`, `3 min`, `2 h`. */
export function formatSilence(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 90) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 90) return `${m} min`
  return `${Math.floor(m / 60)} h`
}

/**
 * The order rows are drawn in, which is also the one the collapsed line picks
 * its job from.
 *
 * A failure first: it is the only state somebody has to act on. Then what is
 * still running, oldest first so a row does not jump about as others start.
 * Finished work last — it is on its way out.
 */
function rank(job: PaneJob): number {
  return job.state === 'failed' || job.phase === 'error' ? 0 : job.state === 'running' ? 1 : 2
}

/** Every job worth drawing at `now`, as rows, in drawing order. */
export function jobRows(jobs: readonly PaneJob[], now: number): JobRow[] {
  return jobs
    .filter((job) => jobVisible(job, now))
    .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt)
    .map((job) => jobRow(job, now))
}

export function jobRow(job: PaneJob, now: number): JobRow {
  const stale = jobStale(job, now)
  const state: JobRow['state'] =
    job.state !== 'running'
      ? job.state
      : stale
        ? 'stale'
        : job.phase === 'paused'
          ? 'paused'
          : job.phase === 'error'
            ? 'error'
            : 'running'
  const indeterminate = job.state === 'running' && job.phase === 'indeterminate'
  const end = job.state === 'running' ? now : (job.endedAt ?? job.updatedAt)
  const eta = jobEtaMs(job, now)

  let count: string | undefined
  if (job.done !== undefined) {
    count = job.total !== undefined ? `${fmtCount(job.done)}/${fmtCount(job.total)}` : fmtCount(job.done)
  }

  let note: string | undefined
  if (job.state === 'failed') note = job.reason || 'failed'
  else if (stale) note = `no update for ${formatSilence(now - job.updatedAt)}`
  else note = job.detail || undefined

  return {
    id: job.id,
    title: job.title,
    state,
    pct: job.fraction !== undefined && !indeterminate ? job.fraction * 100 : undefined,
    ...(indeterminate ? { indeterminate: true } : {}),
    count,
    elapsed: formatClock(end - job.startedAt),
    eta: eta !== null ? `~${formatClock(eta)} left` : undefined,
    note,
  }
}

/**
 * Several panes' jobs as one bar — the sidebar's, under a workspace's name.
 *
 * One bar for many jobs has to pick what it is a bar *of*, and the choice is
 * the plain average of the running jobs' own fractions. Not done over total
 * summed across them: a render counting frames and an upload counting bytes
 * share no unit, and adding 340 frames to 2 GB would let whichever job counts
 * in the bigger numbers decide the bar. Each job saying how far through it is
 * counts once.
 *
 * And only when every one of them says. A running job with no fraction — a
 * count with no total, a program that reported "indeterminate" — means the
 * workspace's overall position is not known, and an average of the jobs that
 * did say would be a confident bar standing in for one that is not there. So
 * such a job is left out of the fraction; if nothing running has one, there is no bar.
 *
 * What is finished does not count towards the fraction, or the bar would jump
 * forward the moment one job of three ends. It shows when nothing is running
 * any more: green for done, red for a failure — and a failure next to running
 * work is carried as `failed` so the bar can say both at once.
 */
export interface JobSummary {
  /**
   * `stale` only when everything running has gone quiet, and `paused` only
   * when everything else running is paused: one live job is enough for the bar
   * to be live. `error` when any running job says something is wrong.
   */
  state: 'running' | 'stale' | 'paused' | 'error' | 'done' | 'failed'
  /** 0–100, or undefined when the overall position cannot honestly be given. */
  pct?: number
  /** A failure, finished or still running, sits among the rest. */
  failed: boolean
  /** When the latest finished job finished, for how long the outcome flashes. */
  endedAt?: number
  /** Every visible job, drawn in strip order — what a tooltip lists. */
  rows: JobRow[]
}

export function jobsSummary(jobs: readonly PaneJob[], now: number): JobSummary | null {
  const visible = jobs.filter((job) => jobVisible(job, now))
  if (!visible.length) return null
  const rows = jobRows(visible, now)
  // Only work that says how far it is counts. The sidebar bar fills; it never
  // sweeps. A job with no percentage (an agent's own "busy" OSC 9;4, a job
  // with no --total) is listed in the tooltip and drawn in the pane's strip,
  // but it does not get to turn the workspace bar into a moving band.
  const live = rows.filter((r) => r.state !== 'done' && r.state !== 'failed' && r.pct !== undefined && !r.indeterminate)
  const running = rows.some((r) => r.state !== 'done' && r.state !== 'failed')
  const failed = rows.some((r) => r.state === 'failed' || r.state === 'error')
  const ended = visible.filter((j) => j.state !== 'running').map((j) => j.endedAt ?? j.updatedAt)
  const endedAt = ended.length ? Math.max(...ended) : undefined

  if (!live.length) {
    // Something is running but none of it can say how far: no bar at all.
    if (running) return null
    const state = rows.some((r) => r.state === 'failed') ? 'failed' : 'done'
    return { state, pct: 100, failed: state === 'failed', endedAt, rows }
  }

  const pct = live.reduce((sum, r) => sum + (r.pct ?? 0), 0) / live.length
  const awake = live.filter((r) => r.state !== 'stale')
  const state: JobSummary['state'] = !awake.length
    ? 'stale'
    : awake.some((r) => r.state === 'error')
      ? 'error'
      : awake.every((r) => r.state === 'paused')
        ? 'paused'
        : 'running'
  return { state, pct, failed, endedAt, rows }
}

function fmtCount(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

/**
 * Applies one report to a pane's jobs, returning the new list or why not.
 *
 * Pure so the rules can be tested without a process: the registry in
 * `main/jobs.ts` owns the timers and the throttling, and calls this.
 */
export function applyJobReport(
  jobs: readonly PaneJob[],
  report: JobReport,
  now: number
): { jobs: PaneJob[] } | { error: string } {
  const id = clip(report.id, 64)
  if (!id) return { error: 'a job needs an --id' }
  const existing = jobs.find((j) => j.id === id)
  const others = jobs.filter((j) => j.id !== id)

  switch (report.action) {
    case 'start': {
      const job = blankJob(id, clip(report.title, 120) || id, now, report.ttl)
      if (report.total !== undefined) {
        if (!(report.total > 0) || !Number.isFinite(report.total)) return { error: '--total must be a positive number' }
        job.total = report.total
      }
      job.detail = clip(report.detail, 200) || undefined
      // A new job makes an old failure history, the same rule the agent's own
      // --failed follows: the next run beginning is the moment the last one's
      // verdict stops being news. Finished-and-fine jobs are left to fade on
      // their own clock; they are not in anybody's way.
      const kept = others.filter((j) => j.state !== 'failed')
      if (kept.length >= MAX_JOBS_PER_PANE) {
        // Room is made from finished work first. A pane genuinely running this
        // many jobs at once is told so rather than having one silently dropped.
        const oldestDone = kept.find((j) => j.state === 'done')
        if (!oldestDone) return { error: `this pane already has ${MAX_JOBS_PER_PANE} jobs running` }
        kept.splice(kept.indexOf(oldestDone), 1)
      }
      return { jobs: [...kept, job] }
    }

    case 'update': {
      // An update for a job nobody started starts it, titled by its id. A
      // script that lost its `start` — a restarted loop, a typo fixed halfway
      // — still gets a bar, and the title says exactly what it was called.
      if (existing && existing.state !== 'running') {
        return { error: `job ${id} has already finished — start it again to reuse the id` }
      }
      const job: PaneJob = existing ? { ...existing } : blankJob(id, id, now, report.ttl)
      if (report.total !== undefined && report.total > 0 && Number.isFinite(report.total)) job.total = report.total
      if (report.ttl !== undefined && report.ttl > 0) job.ttlMs = report.ttl

      let fraction: number | undefined
      if (report.done !== undefined) {
        if (!Number.isFinite(report.done) || report.done < 0) return { error: '--done must be a number of at least 0' }
        job.done = report.done
        if (job.total !== undefined) fraction = Math.min(1, report.done / job.total)
      }
      if (report.pct !== undefined) {
        if (!Number.isFinite(report.pct)) return { error: '--pct must be a number from 0 to 100' }
        fraction = Math.max(0, Math.min(100, report.pct)) / 100
      }
      if (report.detail !== undefined) job.detail = clip(report.detail, 200) || undefined

      if (report.phase !== undefined && report.phase !== (job.phase ?? 'normal')) {
        // A change of phase restarts the rate. Time spent paused, or spent not
        // knowing, is not time the job was moving at its old speed, and a rate
        // that averaged it in would predict a tail that is not there.
        job.firstAt = undefined
        job.firstFraction = undefined
        job.samples = 0
        if (report.phase === 'normal') delete job.phase
        else job.phase = report.phase
        // Not knowing how far through is not "still at 40%".
        if (report.phase === 'indeterminate' && fraction === undefined) delete job.fraction
      }

      if (fraction !== undefined) {
        // Going backwards restarts the measurement. A job that moved on to a
        // second pass, or a counter that was reset, has not got a negative
        // speed — its old history just no longer describes it.
        if (job.firstAt === undefined || job.fraction === undefined || fraction < job.fraction) {
          job.firstAt = now
          job.firstFraction = fraction
          job.samples = 1
        } else {
          job.samples += 1
        }
        job.lastAt = now
        job.fraction = fraction
      }
      job.updatedAt = now
      return { jobs: [...others, job] }
    }

    case 'clear':
      // Gone without a verdict: the program withdrew its bar and said nothing
      // about how the work went, so nothing is drawn in its place.
      return { jobs: existing ? others : [...jobs] }

    case 'done':
    case 'fail': {
      const job: PaneJob = existing ? { ...existing } : blankJob(id, id, now, report.ttl)
      job.state = report.action === 'done' ? 'done' : 'failed'
      delete job.phase
      job.endedAt = now
      job.updatedAt = now
      if (report.detail !== undefined) job.detail = clip(report.detail, 200) || undefined
      if (report.action === 'fail') job.reason = clip(report.reason, 200) || undefined
      // Done is all of it, whatever the last update managed to say. A failure
      // keeps the bar where it stopped, which is the useful part of it.
      if (report.action === 'done' && (job.fraction !== undefined || job.total !== undefined)) {
        job.fraction = 1
        if (job.total !== undefined) job.done = job.total
      }
      return { jobs: [...others, job] }
    }
  }
  return { error: 'unknown job action' }
}

/** More than this on one pane is a loop gone wrong, not a workload. */
export const MAX_JOBS_PER_PANE = 16

function blankJob(id: string, title: string, now: number, ttl: number | undefined): PaneJob {
  return {
    id,
    title,
    state: 'running',
    startedAt: now,
    updatedAt: now,
    ttlMs: ttl !== undefined && ttl > 0 ? ttl : DEFAULT_JOB_TTL_MS,
    samples: 0,
  }
}

/** One line of text, bounded: these are drawn in a strip one row high. */
function clip(value: string | undefined, max: number): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/[\r\n\t]+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}
