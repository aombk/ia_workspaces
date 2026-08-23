/**
 * Telling the main process what is on screen, so time records itself.
 *
 * The whole of the renderer's part in time tracking: a small message every
 * fifteen seconds saying which project is in front of you, or nothing when
 * none is. Everything else — when a stretch of work starts, when it ends, what
 * a lost heartbeat means — is decided in `timeLog.ts`, in one place, where it
 * survives the window being closed and reopened.
 *
 * Focus is the signal, deliberately. An app left running behind a browser all
 * afternoon is not somebody working, and a tracker that counted it would
 * produce the flattering, useless numbers that make people stop believing
 * trackers. Keystrokes would be the opposite mistake: reading code with the
 * window in front of you is work, and a tracker that demanded typing would
 * punish the part of the job that matters most.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { TimeSpan } from '../../shared/types'

/** Matches `HEARTBEAT_MS` in `timeLog.ts`, which decides what a gap means. */
const BEAT_MS = 15_000

/** How often the pane re-reads the log. Slower: nobody watches a total tick up. */
const READ_MS = 30_000

let spans: TimeSpan[] = []
let beatTimer: ReturnType<typeof setInterval> | null = null
let readTimer: ReturnType<typeof setInterval> | null = null
const listeners = new Set<() => void>()

export function initTimeMonitor(): void {
  if (beatTimer) return
  beat()
  beatTimer = setInterval(beat, BEAT_MS)

  // Focus changes are the one thing worth reporting immediately: they are what
  // starts and stops a stretch of work, and waiting up to fifteen seconds to
  // say so would round every session up or down by that much.
  window.addEventListener('focus', beat)
  window.addEventListener('blur', beat)
  // Switching workspace ends one stretch and starts another, for the same
  // reason. `store.subscribe` fires for a great deal else too, which is why
  // the message is cheap and the main side ignores a repeat.
  store.subscribe(beat)
}

function beat(): void {
  const workspace = document.hasFocus() ? store.activeWorkspace : null
  void backend()
    .timeBeat(workspace?.cwd ?? '', workspace?.name ?? '')
    .catch(() => {
      // A missed beat is a shorter recorded session, not a broken one. The log
      // closes a span at the last beat it actually heard.
    })
}

/** Everything recorded, as of the last read. */
export function timeSpans(): readonly TimeSpan[] {
  return spans
}

/** Called when a fresh read lands, for anything drawing from it. */
export function watchTime(fn: () => void): () => void {
  listeners.add(fn)
  if (!readTimer) {
    void read()
    readTimer = setInterval(() => void read(), READ_MS)
  }
  return () => listeners.delete(fn)
}

/** Re-reads now, for a pane that has just been opened. */
export function refreshTimeNow(): void {
  void read()
}

async function read(): Promise<void> {
  try {
    spans = await backend().timeSpans()
  } catch {
    // Keep the last good answer rather than blanking a pane over one failed
    // round trip.
  }
  for (const fn of listeners) fn()
}

/**
 * Total milliseconds per day for one project, keyed by local calendar date.
 *
 * Split at local midnight rather than filed under whichever day a span began,
 * because a session from eleven at night to one in the morning belongs to both
 * days and reporting it as two hours on Tuesday is simply wrong. The nightly
 * case is not rare in this line of work.
 */
export function byDay(all: readonly TimeSpan[], cwd?: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const span of all) {
    if (cwd && !samePath(span.cwd, cwd)) continue

    let from = span.start
    while (from < span.end) {
      const midnight = nextMidnight(from)
      const to = Math.min(span.end, midnight)
      const key = dayKey(from)
      out.set(key, (out.get(key) ?? 0) + (to - from))
      from = to
    }
  }
  return out
}

/** Every project that has any recorded time, most first. */
export function byProject(all: readonly TimeSpan[]): { cwd: string; name: string; ms: number }[] {
  const out = new Map<string, { cwd: string; name: string; ms: number }>()
  for (const span of all) {
    const key = norm(span.cwd)
    const seen = out.get(key)
    if (seen) {
      seen.ms += span.end - span.start
      // The newest name wins: a project renamed in March is not two projects.
      if (span.end >= 0) seen.name = span.name || seen.name
    } else {
      out.set(key, { cwd: span.cwd, name: span.name, ms: span.end - span.start })
    }
  }
  return [...out.values()].sort((a, b) => b.ms - a.ms)
}

/** `2026-08-22`, in local time, which is the only sense a person means by "today". */
export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function nextMidnight(at: number): number {
  const d = new Date(at)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function norm(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/**
 * A duration a person would say out loud.
 *
 * No seconds above a minute and no decimals above an hour: this is read at a
 * glance to answer "roughly how long", and `2h 14m 33s` answers it worse than
 * `2h 14m` does.
 */
export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}
