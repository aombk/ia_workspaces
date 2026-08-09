/**
 * Active→idle detection from PTY output volume.
 *
 * The shell-integration markers in `shells.ts` tell us exactly when a *command*
 * starts and ends, which is what the "command finished" alert wants. They are
 * useless for an agent: Claude Code takes the screen, runs for ten minutes
 * without ever returning to a prompt, and the only observable difference
 * between "thinking" and "waiting for you" is that the bytes stop.
 *
 * So this watches throughput and nothing else:
 *   active — more than ACTIVE_THRESHOLD bytes inside ACTIVE_WINDOW_MS
 *   idle   — no output for `idleMs` after having been active
 *
 * Nothing is pattern-matched, so it works the same for Claude Code, Codex, a
 * webpack watch, or `cmd.exe`, which has no shell integration at all. That is
 * the point: this is the one activity signal every pane can produce.
 */

interface PaneState {
  bytes: number
  windowStart: number
  active: boolean
  /** An active→idle already fired; suppressed until a fresh burst re-arms. */
  notified: boolean
  /** onActive already fired for this cycle — dedupes the IPC chatter. */
  activeFired: boolean
  idleTimer: NodeJS.Timeout | null
  lastReschedule: number
}

export interface ActivityHooks {
  /** A pane began producing sustained output. */
  onActive(paneId: string): void
  /** A pane that had been active has gone quiet. Fires once per cycle. */
  onIdle(paneId: string): void
}

/** Sustained output means more than this many bytes inside the window. */
const ACTIVE_THRESHOLD = 2000
const ACTIVE_WINDOW_MS = 3000
/**
 * Rescheduling the idle timer on every chunk is pure churn under heavy output.
 * Throttling it bounds the detection skew at idleMs + this, which is noise
 * against an idle window measured in seconds.
 */
const RESCHEDULE_THROTTLE_MS = 100

export class ActivityMonitor {
  private readonly panes = new Map<string, PaneState>()

  constructor(
    private readonly hooks: ActivityHooks,
    /** Read per use so changing the setting takes effect without a restart. */
    private readonly idleMs: () => number
  ) {}

  start(paneId: string): void {
    this.panes.set(paneId, {
      bytes: 0,
      windowStart: Date.now(),
      active: false,
      notified: false,
      activeFired: false,
      idleTimer: null,
      lastReschedule: 0,
    })
  }

  /**
   * Arm a cycle from a submitted line rather than from throughput.
   *
   * Passive detection needs 2 KB before it will call a pane active, so a short
   * agent reply — "Done." and back to waiting — would never start a cycle and
   * the pane would stay stuck in whatever state it was in. An Enter keystroke
   * is proof a turn began, so the next byte out is enough. No callback fires
   * until output actually arrives.
   */
  beginTurn(paneId: string): void {
    const s = this.panes.get(paneId)
    if (!s) return
    if (s.idleTimer) clearTimeout(s.idleTimer)
    s.bytes = 0
    s.windowStart = Date.now()
    s.active = true
    s.notified = false
    s.activeFired = false
    s.idleTimer = null
    s.lastReschedule = 0
  }

  feed(paneId: string, byteCount: number): void {
    const s = this.panes.get(paneId)
    if (!s) return

    const now = Date.now()
    if (now - s.windowStart > ACTIVE_WINDOW_MS) {
      s.bytes = 0
      s.windowStart = now
    }
    s.bytes += byteCount

    if (!s.active && !s.notified && s.bytes > ACTIVE_THRESHOLD) s.active = true

    // A new burst after a completed cycle re-arms rather than staying quiet.
    if (s.notified && s.bytes > ACTIVE_THRESHOLD) {
      s.notified = false
      s.active = true
    }

    if (!s.active) return

    if (!s.activeFired) {
      s.activeFired = true
      this.hooks.onActive(paneId)
    }

    if (!s.idleTimer || now - s.lastReschedule >= RESCHEDULE_THROTTLE_MS) {
      if (s.idleTimer) clearTimeout(s.idleTimer)
      s.lastReschedule = now
      s.idleTimer = setTimeout(() => {
        if (!s.active) return
        s.active = false
        s.notified = true
        s.activeFired = false
        s.idleTimer = null
        // Start the next cycle's measurement from zero. Leaving the count
        // standing means that when the idle wait is shorter than the
        // measurement window — which a low `idleSeconds` allows — the tally is
        // still above the threshold, and the first byte after going quiet
        // re-arms the pane without anything resembling a new burst.
        s.bytes = 0
        s.windowStart = Date.now()
        this.hooks.onIdle(paneId)
      }, Math.max(1000, this.idleMs()))
    }
  }

  isActive(paneId: string): boolean {
    return this.panes.get(paneId)?.active ?? false
  }

  stop(paneId: string): void {
    const s = this.panes.get(paneId)
    if (s?.idleTimer) clearTimeout(s.idleTimer)
    this.panes.delete(paneId)
  }
}
