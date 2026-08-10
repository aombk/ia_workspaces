/**
 * Deciding which surviving sessions nothing can reach any more.
 *
 * Its own module, and pure, because this is the one judgement in the broker
 * design that ends a process the user did not ask to end. Getting it wrong in
 * one direction leaks a shell; getting it wrong in the other kills a build
 * somebody is waiting on. That asymmetry is why every condition here is a
 * reason to leave a session alone, and only the conjunction of all of them
 * ends one.
 */
import type { SessionSummary } from '../host/protocol'

/**
 * How old an unreferenced session must be before it can be judged abandoned.
 *
 * The workspace document is written shortly *after* a pane is created, and this
 * decision reads that document. In the gap, a pane the user opened one second
 * ago is indistinguishable from one abandoned last week. Five minutes is far
 * wider than the gap and far narrower than the age of a real orphan.
 */
export const ORPHAN_GRACE_MS = 5 * 60 * 1000

/** The fields of a session this decision looks at. */
export type OrphanCandidate = Pick<SessionSummary, 'id' | 'attached' | 'startedAt'>

/**
 * Whether a session can no longer be reached by any pane.
 *
 * - **referenced** — the workspace document still names this pane, so it may be
 *   shown again at any time, including by a workspace that is not open now.
 * - **attached** — another instance of the app is reading it this moment.
 *   Whatever the document says, something is using it.
 * - **young** — see `ORPHAN_GRACE_MS`. A pane that has not reached the document
 *   yet is not an orphan, it is new.
 */
export function isOrphan(
  session: OrphanCandidate,
  live: ReadonlySet<string>,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS
): boolean {
  if (live.has(session.id)) return false
  if (session.attached > 0) return false
  // `<=`, so a session exactly at the boundary is spared. The comparison could
  // as easily go the other way; it goes this way because everything else in
  // this module does, and because the two outcomes are not equally bad — a
  // shell that lives five minutes longer than it might have costs nothing.
  if (now - session.startedAt <= graceMs) return false
  return true
}

/**
 * The sessions a sweep should end.
 *
 * An empty `live` set returns nothing at all. That case is not "no panes exist,
 * so everything is an orphan" — it is indistinguishable from a workspace
 * document that failed to load, and the cost of being wrong is every shell the
 * user has. A genuinely empty install has no sessions to sweep anyway.
 */
export function selectOrphans<T extends OrphanCandidate>(
  sessions: readonly T[],
  live: ReadonlySet<string>,
  now: number,
  graceMs: number = ORPHAN_GRACE_MS
): T[] {
  if (live.size === 0) return []
  return sessions.filter((s) => isOrphan(s, live, now, graceMs))
}
