/**
 * Things that happened, in order, with a cursor.
 *
 * The control server has a dozen verbs and every one of them is an
 * instruction. Nothing could *watch*. A script that wanted to know when an
 * agent got blocked had to call `agent-state` on a timer and diff the answers,
 * which is both wasteful and lossy — two state changes inside one poll interval
 * are indistinguishable from one.
 *
 * The shape is the one every comparable tool converged on, and each part of it
 * exists because a reader can be interrupted:
 *
 * - a **monotonic `seq`** so a reader can say where it got to,
 * - a **`boot` id** so it can tell "nothing new" from "a different process is
 *   answering now", which is the case where its cursor is meaningless,
 * - a **bounded ring** with an honest `gap` flag, because a reader that was away
 *   too long must be told it missed things rather than handed a plausible
 *   subset,
 * - and a **JSONL mirror** on disk, so catching up beyond the ring is possible
 *   at all and so there is something to read after a crash.
 *
 * Deliberately not a log of everything: terminal output is not in here. It is
 * the highest-volume thing in the app by three orders of magnitude, it already
 * has a ring of its own, and `read-screen` already serves it.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/**
 * The categories a subscriber can filter on.
 *
 * Coarse on purpose. A filter fine enough to name individual event types would
 * have to change every time one is added, and a reader that asked for a type
 * that no longer fires gets silence rather than an error.
 */
export type EventCategory = 'pane' | 'agent' | 'alert' | 'activity' | 'host'

export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'pane',
  'agent',
  'alert',
  'activity',
  'host',
]

export interface AppEvent {
  seq: number
  /** Epoch milliseconds, so a reader can age an event without a clock of ours. */
  at: number
  category: EventCategory
  type: string
  paneId?: string
  workspaceId?: string
  data?: Record<string, unknown>
}

export interface EventPage {
  /** Identifies the process that produced these. See `gap`. */
  boot: string
  events: AppEvent[]
  /** The cursor to pass next time — the last seq issued, not the last returned. */
  cursor: number
  /**
   * True when the reader's cursor was older than anything still held, or came
   * from a different boot. Events were missed, and saying so is the whole point
   * of the flag: a subset presented as continuous is worse than an admission.
   */
  gap: boolean
}

/** How many events stay in memory. Beyond this, readers fall back to the file. */
const RING = 2000
/** The JSONL mirror rotates past this, keeping one previous generation. */
const MIRROR_MAX_BYTES = 5 * 1024 * 1024

export class EventLog {
  /**
   * Regenerated every start.
   *
   * A cursor is only meaningful against the process that issued it. Without
   * this, a reader holding `seq: 900` across a restart would be told "nothing
   * new" by a fresh log that has only reached 12 — silently, and forever.
   */
  readonly boot = randomUUID()

  private readonly ring: AppEvent[] = []
  private seq = 0
  private readonly waiters = new Set<() => void>()
  private mirrorPath: string | null = null
  private mirrorBytes = 0

  /**
   * Starts mirroring to disk. Optional: the ring works without it, and a
   * read-only data directory should cost the feature, not the app.
   */
  mirrorTo(file: string): void {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      this.mirrorPath = file
      try {
        this.mirrorBytes = statSync(file).size
      } catch {
        this.mirrorBytes = 0
      }
    } catch {
      this.mirrorPath = null
    }
  }

  emit(
    category: EventCategory,
    type: string,
    fields: { paneId?: string; workspaceId?: string; data?: Record<string, unknown> } = {}
  ): AppEvent {
    const event: AppEvent = { seq: ++this.seq, at: Date.now(), category, type, ...fields }
    this.ring.push(event)
    if (this.ring.length > RING) this.ring.shift()
    this.writeMirror(event)

    // Woken rather than handed the event: a long-poller re-reads from its own
    // cursor, which is what makes "several events arrived while you were being
    // woken" behave the same as "one did".
    for (const wake of [...this.waiters]) {
      try {
        wake()
      } catch {
        /* a subscriber must not take the emitter down with it */
      }
    }
    return event
  }

  /**
   * Everything after `cursor`.
   *
   * A cursor from another boot, or one older than the ring still holds, comes
   * back with everything available and `gap: true`.
   */
  since(
    cursor: number | undefined,
    opts: { boot?: string; categories?: readonly EventCategory[]; limit?: number } = {}
  ): EventPage {
    const wrongBoot = opts.boot !== undefined && opts.boot !== this.boot
    const from = wrongBoot || cursor === undefined ? 0 : cursor
    const oldest = this.ring.length ? this.ring[0].seq : this.seq + 1
    // `from + 1` is the first event they have not seen; a gap exists when even
    // that one has already fallen out of the ring.
    const gap = wrongBoot || (from > 0 && from + 1 < oldest)

    let events = this.ring.filter((e) => e.seq > from)
    if (opts.categories?.length) {
      const wanted = new Set(opts.categories)
      events = events.filter((e) => wanted.has(e.category))
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 500, RING))
    if (events.length > limit) events = events.slice(-limit)

    return { boot: this.boot, events, cursor: this.seq, gap }
  }

  /**
   * Resolves when something new arrives, or when the deadline passes.
   *
   * Long-polling rather than a persistent stream, because the control protocol
   * is one request and one reply and `ask` already proved a handler may answer
   * later. A caller that wants to follow simply asks again with the cursor it
   * was given; a caller that does not, does not.
   *
   * Returns immediately when there is already something after `cursor`, which
   * is what stops a follower from missing an event that lands between two
   * requests.
   */
  wait(cursor: number, timeoutMs: number, onAbort: (fn: () => void) => void): Promise<void> {
    if (this.seq > cursor) return Promise.resolve()
    return new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const wake = () => finish()
      const timer = setTimeout(finish, Math.max(0, timeoutMs))
      timer.unref?.()
      this.waiters.add(wake)
      // The caller hung up. Without this the waiter would sit until its
      // deadline holding a reference to a socket nobody is reading.
      onAbort(finish)
    })
  }

  /** For diagnostics and tests. */
  get lastSeq(): number {
    return this.seq
  }

  private writeMirror(event: AppEvent): void {
    if (!this.mirrorPath) return
    const line = JSON.stringify({ boot: this.boot, ...event }) + '\n'
    try {
      // Rotate before writing rather than after, so the file never exceeds the
      // cap even briefly, and keep exactly one generation: the mirror is for
      // catching up and for a post-mortem, not an archive.
      if (this.mirrorBytes + line.length > MIRROR_MAX_BYTES) {
        renameSync(this.mirrorPath, this.mirrorPath + '.1')
        this.mirrorBytes = 0
      }
      appendFileSync(this.mirrorPath, line, 'utf8')
      this.mirrorBytes += line.length
    } catch {
      // Losing the mirror is not worth failing an event over; the ring is still
      // the thing readers actually poll.
      this.mirrorBytes = 0
    }
  }
}

/** Parses a `--categories a,b` argument, dropping anything unrecognised. */
export function parseCategories(raw: string | undefined): EventCategory[] | undefined {
  if (!raw) return undefined
  const wanted = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s): s is EventCategory => (EVENT_CATEGORIES as readonly string[]).includes(s))
  return wanted.length ? wanted : undefined
}
