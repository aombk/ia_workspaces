/**
 * A break on your phone: one notification when it comes up and one when its
 * countdown ends, for a watch or band that buzzes for the phone's
 * notifications. See `shared/phoneNotify.ts`.
 *
 * Fed every break state main publishes. A new break is told at once and its
 * end scheduled; a break that goes away early — put off, skipped, walked away
 * from — cancels the end, so the phone never says "break over" for a break
 * that did not run.
 */
import { currentExercise, type BreakState } from '../shared/moveBreaks'
import { exercise } from '../shared/exercises'
import { sendNtfy } from '../shared/phoneNotify'

export class BreakBuzz {
  private dueId: string | null = null
  private endTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * The settings, read fresh each time: where "get up" goes, blank for nothing,
   * and where "break over" goes, blank for the same place. Two topics let the
   * phone give each its own sound or vibration.
   */
  constructor(
    private readonly target: () => string,
    private readonly endTarget: () => string
  ) {}

  update(state: BreakState): void {
    const due = state.due
    if (!due) {
      this.dueId = null
      this.cancel()
      return
    }
    if (due.id === this.dueId) return
    this.dueId = due.id
    this.cancel()
    if (!this.target().trim()) return

    const min = state.settings.breakMin
    const name = exercise(currentExercise(due) ?? '')?.name
    this.send(this.target(), 'Time to get up', `${min} minute${min === 1 ? '' : 's'}${name ? `: ${name}` : ''}`, ['person_running'])
    const endAt = due.startedAt + min * 60_000
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      this.send(this.endTarget().trim() || this.target(), 'Break over', 'Back to it.', ['white_check_mark'])
    }, Math.max(0, endAt - Date.now()))
  }

  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
  }

  private send(target: string, title: string, body: string, tags: string[]): void {
    // Nothing to do about a failure here but not crash: the break itself is on
    // screen either way.
    void sendNtfy(target, { title, body, tags }).catch(() => undefined)
  }
}
