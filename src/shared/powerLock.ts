/**
 * Whether a working agent should be holding the machine awake.
 *
 * The decision, and only the decision. `main/powerLock.ts` owns the Electron
 * side — the blocker itself, and the mains/battery signal — and asks this. The
 * split is worth it because everything that can actually go wrong here is
 * arithmetic over a list of panes, and none of it needs a running app to prove.
 *
 * ## What holds the machine up
 *
 * `'working'`, and nothing else. The three states are the ones an agent
 * declares over `iaw report-agent`, and the interesting one is `'blocked'`:
 * an agent parked on a permission prompt has *stopped*. It is waiting for a
 * human, and the human has left the room — that is why the notification fired.
 * Holding a laptop open to wait for somebody who is not there is exactly
 * backwards, so a blocked pane releases the lock and the machine sleeps with
 * the notification waiting on the other side of it.
 *
 * `'idle'` and `'unknown'` are the easy ones: nothing is running, so nothing
 * is held.
 *
 * ## Why a pane can be working and still not count
 *
 * Nothing expires `runDepth` in `main/agentState.ts`. A pane whose agent was
 * killed, or crashed, or whose `runEnd` hook never arrived, reads `'working'`
 * for the rest of the session. As a badge in the sidebar that is a small lie.
 * As a wake lock it is a machine that never sleeps again, and it fails silently
 * — nobody notices a laptop *not* suspending until the battery is flat.
 *
 * So a pane is only counted while its last report is recent. The badge stays
 * optimistic and the lock is made sceptical, which is the right way round: the
 * cost of a badge being wrong is a wrong word on screen, and the cost of the
 * lock being wrong is somebody's morning.
 *
 * It is a dead-man's switch, not a timeout.
 *
 * ## Why a report is not the only sign of life
 *
 * That rule used to rest on an assumption — that an agent working steadily
 * reports far more often than the window — and the assumption was wrong in the
 * direction that costs a night. Claude Code's hooks fire at the *edges* of a
 * turn and nowhere in the middle: `UserPromptSubmit` opens one, `Stop` closes
 * it, `Notification` fires when it wants a human. A turn that spends twenty
 * minutes on one long tool call reports at minute zero and then says nothing at
 * all, so five minutes in it read as stale and the machine was free to
 * suspend — with the agent working and the job a tenth done, which is the exact
 * scenario this whole feature exists to prevent.
 *
 * So a pane is fresh if *either* clock is: its last report, or the last byte
 * its terminal produced. Output is the signal `activityMonitor.ts` already
 * watches, for the same reason it is the right one here — "the only observable
 * difference between thinking and waiting for you is that the bytes stop". An
 * agent that is working prints something; an agent that has hung prints
 * nothing, and neither clock moves.
 *
 * `MAX_SILENT_RUN_MS` is the ceiling on that. Output alone cannot hold the lock
 * forever, because a pane whose turn never closed — an interrupted run, a
 * `Stop` hook that never fired — could otherwise be kept alive indefinitely by
 * whatever else is printing in that terminal, which is a laptop that never
 * sleeps again. Past the ceiling, only a report will do.
 */
import type { AgentRunState } from './types'

export const KEEP_AWAKE_MODES = ['off', 'ac', 'on'] as const

/**
 * `'ac'` is the middle value on purpose — it is the default, and it is the one
 * that means "do the obvious thing": every desktop is on mains, so it behaves
 * as `'on'` there, and a laptop is never held open on its own battery.
 */
export type KeepAwakeMode = (typeof KEEP_AWAKE_MODES)[number]

/**
 * How long a pane may go without reporting before it stops holding the lock.
 *
 * Five minutes, which is far longer than any agent's gap between reports and
 * far shorter than a night. It is the difference between "this run is quiet"
 * and "nothing is coming back".
 */
export const STALE_REPORT_MS = 5 * 60_000

/**
 * How far ahead of `now` a report may be stamped and still be believed.
 *
 * The staleness rule is a dead-man's switch, and without this it has a hole in
 * exactly the place this feature lives. `now - updatedAt` goes negative for a
 * future-stamped report, and a negative number is comfortably under any
 * threshold — so a pane whose timestamp is ahead of the clock reads as fresh
 * forever, and holds the machine open with it.
 *
 * That is not hypothetical here. The clock moves backwards when a machine
 * resumes and corrects itself against a time server, and resuming is precisely
 * what this code is in the business of. A minute absorbs the ordinary skew of
 * a correction while still catching a stamp that is simply wrong.
 */
const FUTURE_TOLERANCE_MS = 60_000

/**
 * How long a run may go without a single report and still be believed, while
 * its terminal keeps producing output.
 *
 * An hour. A genuine turn longer than this that has fired no hook at all —
 * no `Notification`, no nested `Stop`, nothing — is not a turn that is still
 * running; it is a refcount that never came down. The ceiling bounds the worst
 * case at an hour of lost sleep instead of a whole night, and in ordinary use
 * nothing comes close to reaching it.
 */
export const MAX_SILENT_RUN_MS = 60 * 60_000

/** Just enough of a pane's agent state to decide. */
export interface AwakePane {
  paneId: string
  state: AgentRunState
  /** Epoch milliseconds of this pane's last report. */
  updatedAt: number
  /**
   * Epoch milliseconds of the last byte this pane's terminal produced.
   *
   * Optional because it is a fact about a terminal and this function is also
   * asked about panes in the abstract. Absent is treated as "never", which
   * leaves the decision exactly where it was before output was consulted.
   */
  lastOutputAt?: number
}

/**
 * Why the lock is, or is not, being held. Carried so the reason can be shown
 * rather than inferred — "awake because two panes are working" is a thing a
 * user can check, and "awake" on its own is a thing they have to trust.
 */
export type AwakeReason =
  /** The feature is switched off. */
  | 'off'
  /** Mains-only, and this machine is on battery. */
  | 'battery'
  /** Nothing is running. */
  | 'idle'
  /** Something says it is running, but has not said anything for too long. */
  | 'stale'
  /** Held. */
  | 'working'

/**
 * The verdict as anything outside the main process sees it.
 *
 * `AwakeVerdict` plus the one fact only the host knows: whether this machine
 * can be held awake at all. Linux without a session manager refuses the
 * blocker, and a lock we do not really hold is worth saying out loud rather
 * than drawing as if it were held.
 */
export interface PowerLockState extends AwakeVerdict {
  supported: boolean
}

export interface AwakeVerdict {
  hold: boolean
  reason: AwakeReason
  /** Panes counted as working *and* fresh — the ones actually holding it. */
  holding: string[]
}

/**
 * The whole decision.
 *
 * Order matters and is deliberate: the switch beats the power source, and the
 * power source beats what the agents are doing. A user who set `'off'` is owed
 * `'off'` without any part of this consulting a pane, and a laptop on battery
 * under `'ac'` is owed sleep no matter how busy it is.
 */
export function shouldHoldAwake(
  panes: readonly AwakePane[],
  mode: KeepAwakeMode,
  onBattery: boolean,
  now: number
): AwakeVerdict {
  if (mode === 'off') return { hold: false, reason: 'off', holding: [] }
  if (mode === 'ac' && onBattery) return { hold: false, reason: 'battery', holding: [] }

  const working = panes.filter((p) => p.state === 'working')
  if (!working.length) return { hold: false, reason: 'idle', holding: [] }

  // Bounded at both ends. Too old is a pane that has stopped talking; too far
  // ahead is a clock that cannot be trusted to tell us when it stops.
  const fresh = working.filter((p) => {
    const said = now - p.updatedAt
    const printed = p.lastOutputAt ? now - p.lastOutputAt : Number.POSITIVE_INFINITY
    // The more recent of the two, which for a future-stamped clock is the more
    // negative — so the tolerance below still sees the one worth catching.
    const age = Math.min(said, printed)
    if (age > STALE_REPORT_MS || age < -FUTURE_TOLERANCE_MS) return false
    // Output can carry a quiet turn, but only so far: past the ceiling the pane
    // has to have said something itself.
    return said <= MAX_SILENT_RUN_MS
  })
  if (!fresh.length) {
    // Something claims to be working and nothing has been heard from it. Said
    // as its own reason rather than folded into `idle`, because the two want
    // different things from whoever is reading: `idle` is the system at rest,
    // and this is a pane that is probably lying to the sidebar.
    return { hold: false, reason: 'stale', holding: [] }
  }

  return { hold: true, reason: 'working', holding: fresh.map((p) => p.paneId) }
}
