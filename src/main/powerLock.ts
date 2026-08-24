/**
 * Holding the machine awake while an agent is working.
 *
 * The Electron half. Everything that decides *whether* to hold it lives in
 * `shared/powerLock.ts` as a pure function over a list of panes — this file
 * owns the blocker itself, the mains-or-battery signal, and the clock. The
 * split is the point: the part with judgement in it can be tested without an
 * app, and the part that cannot be tested has no judgement in it.
 *
 * The problem being solved costs a whole night when it happens. An agent is
 * given a long job, the machine is left to get on with it, and it suspends ten
 * minutes later with the job a tenth done. Nothing is lost and nothing
 * happened, and you find out in the morning.
 *
 * ## One blocker, never two
 *
 * `powerSaveBlocker.start` hands back an id and will happily hand back a second
 * one. Two ids is a leak with no symptom — the machine simply stops sleeping
 * forever, and nobody notices a laptop *not* suspending until the battery is
 * flat. So there is exactly one id here at any moment, `stop` is only ever
 * called on an id that is live, and the field is cleared before the call rather
 * than after it so a throw cannot leave a dead id behind.
 *
 * ## Why there is a timer as well as events
 *
 * Staleness is the safety net — a pane that claims to be working but has gone
 * quiet stops counting after `STALE_REPORT_MS`. That is a fact about the
 * passage of time, and time does not raise an event. Without a timer, the last
 * agent state change would be the last evaluation, and a crashed agent would
 * hold the lock until the app was quit: precisely the failure the staleness
 * rule exists to prevent.
 */
import { powerMonitor, powerSaveBlocker } from 'electron'
import { shouldHoldAwake, type AwakeVerdict, type KeepAwakeMode } from '../shared/powerLock'
import type { PaneAgentState } from '../shared/types'

/**
 * How often the verdict is recomputed with nothing else prompting it.
 *
 * Fifteen seconds, chosen against the two deadlines it sits between. It has to
 * be well under the shortest sleep timer anybody sets — a minute, on the most
 * aggressive laptop — so that an agent starting work is covered before the
 * machine goes down. And it only has to be a fraction of `STALE_REPORT_MS`,
 * five minutes, for a dead agent to stop holding the lock promptly once its
 * report goes stale. Fifteen seconds clears both with room to spare, and the
 * work it does is filtering an array that is almost always empty.
 */
const POLL_MS = 15_000

export interface PowerLockStatus extends AwakeVerdict {
  /**
   * Whether this machine can actually be held awake.
   *
   * Not a platform check. Linux needs a session manager over DBus and quietly
   * does nothing without one, so the only honest test is to ask for a blocker
   * and then ask whether it took. Reported rather than hidden, because a lock
   * we do not really hold is worth saying out loud — the alternative is a user
   * who trusts a promise the app is not keeping.
   */
  supported: boolean
}

export class PowerLock {
  /** The live blocker, or null. Never more than one. */
  private id: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Set once a blocker has been asked for and refused. See `supported`. */
  private refused = false
  private last: AwakeVerdict = { hold: false, reason: 'idle', holding: [] }

  constructor(
    private readonly panes: () => PaneAgentState[],
    private readonly mode: () => KeepAwakeMode,
    private readonly now: () => number = () => Date.now()
  ) {
    this.timer = setInterval(() => this.evaluate(), POLL_MS)
    // Unreferenced so this interval alone can never be the reason the process
    // stays alive. A wake lock that keeps the app running would be a joke at
    // its own expense.
    this.timer.unref?.()

    // A power source that changes is the one event that must not wait for the
    // poll: unplugging a laptop under `'ac'` should drop the lock there and
    // then, while the user is still holding the cable and able to connect the
    // two events.
    powerMonitor.on('on-ac', this.evaluate)
    powerMonitor.on('on-battery', this.evaluate)
    // Belt and braces. The machine is going down anyway — if it is going down
    // with our blocker still registered, that is a state worth not being in.
    powerMonitor.on('suspend', this.release)

    this.evaluate()
  }

  /**
   * Recompute and act. Safe to call as often as anything likes: it is a filter
   * over a short array and a comparison, and it only touches the blocker when
   * the answer actually changed.
   */
  evaluate = (): void => {
    if (this.disposed) return

    const verdict = shouldHoldAwake(
      this.panes().map((p) => ({ paneId: p.paneId, state: p.state, updatedAt: p.updatedAt })),
      this.mode(),
      powerMonitor.onBatteryPower,
      this.now()
    )
    this.last = verdict

    if (verdict.hold) this.acquire()
    else this.release()
  }

  private acquire(): void {
    if (this.id !== null) return

    // `prevent-app-suspension` and not `prevent-display-sleep`. The screen is
    // allowed to go dark — we are keeping the machine running, not the monitor
    // lit, and holding a display up all night to watch a build run is a
    // different feature and a worse one.
    const id = powerSaveBlocker.start('prevent-app-suspension')

    // Asked rather than assumed, because this is where Linux tells the truth:
    // with no session manager to talk to, `start` returns an id for a blocker
    // that was never established. An id we cannot rely on is worse than none,
    // so it is stopped immediately and the answer remembered.
    if (!powerSaveBlocker.isStarted(id)) {
      this.refused = true
      try {
        powerSaveBlocker.stop(id)
      } catch {
        // Nothing to undo — it was never started. Swallowed because the only
        // thing a throw here could mean is the same "no" said twice.
      }
      return
    }

    this.refused = false
    this.id = id
  }

  /** Idempotent, and safe to call from a shutdown path that may run twice. */
  release = (): void => {
    const id = this.id
    if (id === null) return
    // Cleared first, so a throw inside `stop` cannot leave this object
    // believing it still owns a blocker it has already let go of.
    this.id = null
    try {
      powerSaveBlocker.stop(id)
    } catch {
      // Already stopped, or the process is on its way down. Either way there is
      // no blocker left to worry about, which is the outcome we wanted.
    }
  }

  /** What is being held and why, for anything that wants to show it. */
  status(): PowerLockStatus {
    return { ...this.last, supported: !this.refused }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    powerMonitor.off('on-ac', this.evaluate)
    powerMonitor.off('on-battery', this.evaluate)
    powerMonitor.off('suspend', this.release)
    this.release()
  }
}
