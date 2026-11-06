/**
 * Notifications on your phone — and on a watch or band paired with it —
 * through one ntfy topic. See `shared/phoneNotify.ts` for the sending.
 *
 * Four events, each switched on or off in settings:
 * - a break comes up, and its countdown ends (`breakUpdate`);
 * - an agent asks you something, or finishes a turn (`agentUpdate`), and only
 *   while you are away from the computer: sitting at it, the sidebar already
 *   says so, and a band buzzing about what is on the screen in front of you is
 *   noise.
 *
 * A break that goes away early — put off, skipped, walked away from — cancels
 * its "break over", so the phone never says it for a break that did not run.
 */
import { currentExercise, type BreakState } from '../shared/moveBreaks'
import { exercise } from '../shared/exercises'
import { sendNtfy, type NtfyMessage } from '../shared/phoneNotify'
import type { PaneAgentState, Settings } from '../shared/types'

/** The same pane is told about at most once in this long. */
const PANE_COOLDOWN_MS = 30_000

export interface PaneInfo {
  workspace: string
  pane: string
}

export class PhoneNotifier {
  private dueId: string | null = null
  private endTimer: ReturnType<typeof setTimeout> | null = null
  /** Each pane's agent state as last seen, so only a change is told about. */
  private readonly agentStates = new Map<string, PaneAgentState['state']>()
  private readonly lastSent = new Map<string, number>()

  constructor(
    private readonly settings: () => Settings,
    /** Seconds since the last keyboard or mouse input, anywhere. */
    private readonly idleSec: () => number,
    /** Names for a pane, for the message; null when it is not known. */
    private readonly describe: (paneId: string) => PaneInfo | null
  ) {}

  /** Where messages go: the topic setting, or the one breaks used to have. */
  private target(): string {
    const s = this.settings() as Settings & { movePhoneNtfy?: unknown }
    const value = typeof s.phoneNtfy === 'string' && s.phoneNtfy.trim() ? s.phoneNtfy : s.movePhoneNtfy
    return typeof value === 'string' ? value.trim() : ''
  }

  breakUpdate(state: BreakState): void {
    const due = state.due
    if (!due) {
      this.dueId = null
      this.cancelEnd()
      return
    }
    if (due.id === this.dueId) return
    this.dueId = due.id
    this.cancelEnd()

    const min = state.settings.breakMin
    if (this.settings().phoneBreakStart !== false) {
      const name = exercise(currentExercise(due) ?? '')?.name
      this.send({
        title: 'Time to get up',
        body: `${min} minute${min === 1 ? '' : 's'}${name ? `: ${name}` : ''}`,
        tags: ['person_running'],
      })
    }
    const endAt = due.startedAt + min * 60_000
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      // Read when it ends, so switching it off during the break counts.
      if (this.settings().phoneBreakEnd !== false) {
        this.send({ title: 'Break over', body: 'Back to it.', tags: ['white_check_mark'] })
      }
    }, Math.max(0, endAt - Date.now()))
  }

  agentUpdate(agent: PaneAgentState): void {
    const before = this.agentStates.get(agent.paneId)
    this.agentStates.set(agent.paneId, agent.state)
    // First sight of a pane, after a start or a restore, is not news.
    if (before === undefined || before === agent.state) return

    const s = this.settings()
    const asks = agent.state === 'blocked' && !agent.answeredAt && s.phoneAgentAsks !== false
    const done = before === 'working' && (agent.state === 'idle' || agent.state === 'failed') && s.phoneAgentDone === true
    if (!asks && !done) return
    if (this.idleSec() < Math.max(0, s.phoneAwayMin ?? 2) * 60) return
    const now = Date.now()
    if (now - (this.lastSent.get(agent.paneId) ?? 0) < PANE_COOLDOWN_MS) return
    this.lastSent.set(agent.paneId, now)

    const info = this.describe(agent.paneId)
    const where = info ? `${info.workspace} · ${info.pane}` : 'An agent'
    if (asks) {
      this.send({
        title: `${where} is waiting for you`,
        body: agent.blockedReason || 'It has a question.',
        tags: ['raised_hand'],
      })
    } else {
      this.send({
        title: `${where} ${agent.state === 'failed' ? 'stopped with an error' : 'finished'}`,
        body: agent.state === 'failed' ? 'The turn ended badly.' : 'Its turn is done.',
        tags: [agent.state === 'failed' ? 'x' : 'checkered_flag'],
      })
    }
  }

  forgetPane(paneId: string): void {
    this.agentStates.delete(paneId)
    this.lastSent.delete(paneId)
  }

  dispose(): void {
    this.cancelEnd()
  }

  private cancelEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
  }

  private send(message: NtfyMessage): void {
    const target = this.target()
    if (!target) return
    // Nothing to do about a failure but not crash: everything sent here is on
    // the screen as well.
    void sendNtfy(target, message).catch(() => undefined)
  }
}

/** A pane's workspace and title from the saved document, for the message. */
export function describePane(doc: unknown, paneId: string): PaneInfo | null {
  const workspaces = (doc as { workspaces?: unknown } | null)?.workspaces
  if (!Array.isArray(workspaces)) return null
  for (const w of workspaces as Array<{ name?: unknown; tabs?: unknown }>) {
    for (const t of Array.isArray(w.tabs) ? (w.tabs as Array<{ customTitle?: unknown; panes?: unknown }>) : []) {
      for (const p of Array.isArray(t.panes) ? (t.panes as Array<Record<string, unknown>>) : []) {
        if (p.id !== paneId) continue
        const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')
        return {
          workspace: str(w.name) || 'workspace',
          pane: str(p.customTitle) || str(t.customTitle) || str(p.autoTitle) || 'terminal',
        }
      }
    }
  }
  return null
}
