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
 * A real agent working steadily reports far more often than this window, so
 * nothing legitimate is cut short by it. It is a dead-man's switch, not a
 * timeout.
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

/** Just enough of a pane's agent state to decide. */
export interface AwakePane {
  paneId: string
  state: AgentRunState
  /** Epoch milliseconds of this pane's last report. */
  updatedAt: number
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
    const age = now - p.updatedAt
    return age <= STALE_REPORT_MS && age >= -FUTURE_TOLERANCE_MS
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
