/**
 * Which panes may have their shell taken away to get the memory back.
 *
 * An agent left sitting at its prompt is the most expensive idle thing this app
 * hosts. Measured on the machine this was written on: `claude.exe` alone holds
 * 470–570 MB, and each one drags a per-session MCP server (≈59 MB) and a
 * conhost (≈9 MB) along with it, so three panes nobody is looking at were
 * costing 1.5 GB of a 15 GB machine — enough to push it into paging, which is
 * what "a few terminals make it crawl" actually is.
 *
 * None of that is lost by ending the shell, *if* the conversation can be
 * re-entered: Claude Code writes its transcript as it goes and the pane already
 * records which conversation it is having, so `claude --resume <id>` — the same
 * line a restored pane types after the app restarts — brings it back. So a pane
 * that qualifies here keeps its screen, its folder and its place, and gives up
 * only the processes.
 *
 * The decision is here, on its own, because every condition in it is a way of
 * being wrong about somebody's work, and each one deserves to be read and
 * tested by itself.
 */

/** What is known about one pane when the sweep runs. */
export interface IdlePane {
  /** Has a shell running right now. Nothing to release otherwise. */
  spawned: boolean
  /** Already asleep, or on its way out. */
  hibernated: boolean
  disposed: boolean
  /** Off screen — the pane's tab is not the one being looked at. */
  deferred: boolean
  /** When it went off screen. Zero while visible. */
  deferredAt: number
  /**
   * A conversation that can be resumed, or null.
   *
   * This is the whole licence for the feature. A plain shell holds things that
   * only exist in it — an ssh session, a half-typed command, a server bound to
   * a port, a `cd` three folders deep — and none of that comes back from a
   * transcript, so a plain shell is never released. An agent pane is released
   * precisely because re-entering it is a line of typing.
   */
  resumable: boolean
  /**
   * What the pane's agent last declared, or observed activity.
   *
   * `working` is obvious. `blocked` is the subtle one: it means the agent asked
   * the user a question and is waiting, which reads as idle everywhere else in
   * the app and is exactly when taking the shell away would be rudest — the
   * question is on screen, unanswered, and the answer is expected to go back
   * into that shell. `active` is output still arriving.
   *
   * `failed` is the one that does **not** hold a shell open. It says the last
   * turn ended badly, and it stays true until a new turn begins — so treating
   * it like the others would mean a pane that fell over this morning can never
   * be reclaimed, which is precisely the pane most worth reclaiming. The
   * verdict survives the shell: it lives in the agent record, not in the
   * process.
   */
  indicator: 'blocked' | 'working' | 'failed' | 'active' | null
}

/**
 * Should this pane's shell be released now?
 *
 * `afterMs` of 0 or less turns the whole thing off, which is what the setting's
 * 0 means and why the check is first.
 */
export function mayRelease(pane: IdlePane, afterMs: number, now: number): boolean {
  if (afterMs <= 0) return false
  if (!pane.spawned || pane.hibernated || pane.disposed) return false
  if (!pane.resumable) return false
  // Never the pane on screen. Someone is looking at it, and "idle" for a thing
  // being looked at means reading it, not abandoning it.
  if (!pane.deferred || !pane.deferredAt) return false
  if (pane.indicator !== null && pane.indicator !== 'failed') return false
  return now - pane.deferredAt >= afterMs
}

/** The panes to release, from everything mounted. Pure, so it can be tested. */
export function panesToRelease<T extends IdlePane>(
  panes: Iterable<T>,
  afterMs: number,
  now: number
): T[] {
  const out: T[] = []
  for (const pane of panes) if (mayRelease(pane, afterMs, now)) out.push(pane)
  return out
}
