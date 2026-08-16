/**
 * Which agent conversation a pane is having, and whether it can be re-entered.
 *
 * Two decisions, both about the same awkward fact: the id Claude Code reports
 * is issued before the conversation it names exists. `SessionStart` fires at
 * startup — a prompt nobody has typed into yet — and the transcript that makes
 * a conversation resumable is not written until the first turn completes. An id
 * on its own is therefore a claim, not a conversation.
 *
 * Left unchecked, that produced two failures a restored pane showed you
 * directly. A pane where Claude Code was started and never spoken to recorded
 * an id for a conversation that was never saved, and came back typing
 * `claude --resume <id>` at Claude Code's own "No conversation found with
 * session ID". And because that empty session's id overwrote whatever the pane
 * had recorded before it, the real conversation it had been having was lost
 * along with it.
 *
 * Refusing those ids outright then produced the opposite failure, and it is the
 * one that lasted: a pane that moved on to a second conversation — a fresh
 * `claude`, or a `/clear` — reported an id whose transcript did not exist yet,
 * was refused, and went on resuming the *previous* conversation every time the
 * app opened. `UserPromptSubmit` was the answer to that, and it is a hook the
 * user has to have installed; anyone whose integration predates it never got
 * one. So a refused id is now held beside the record and settled against the
 * disk later, which needs no hook at all. See `settle`.
 *
 * Kept here rather than in `ptyManager` because both are decisions rather than
 * plumbing, and a decision that can be read on its own can be tested on its own.
 */
import { existsSync } from 'node:fs'
import { AGENT_SESSION_TTL_MS, type AgentSession } from '../shared/types'

/**
 * How often a conversation re-reporting the same id is written through.
 *
 * `at` exists to keep a conversation you are still having from ageing out of a
 * fortnight-long TTL, and five minutes of granularity serves that exactly as
 * well as one write per prompt — which is what this would otherwise be, now
 * that submitting a prompt is one of the events that reports an id.
 */
export const RECORD_REFRESH_MS = 5 * 60 * 1000

/** What a hook told us about the conversation running in a pane. */
export interface SessionReport {
  id: string
  /** Where Claude Code says this conversation is written. */
  transcript?: string
  /** The hook that reported it, e.g. `SessionStart`, `UserPromptSubmit`. */
  hookEvent?: string
}

/** Whether a file is there. Injected so the decisions can be tested. */
type Exists = (path: string) => boolean

/**
 * The record to keep for a pane, or null to leave it as it is.
 *
 * An id displaces a *different* one already recorded on one of two grounds:
 * its transcript is on disk, or the user has just submitted a prompt to it,
 * which is a conversation beginning in earnest. A session that has neither said
 * anything nor written anything is not evidence about which conversation a pane
 * is having, and it does not get to overwrite one that is.
 *
 * A pane with nothing recorded yet takes whatever it is offered: there is
 * nothing to lose, the transcript path it carries is where the conversation
 * will be written if it becomes one, and `resumeCommand` looks for that file
 * before typing anything.
 */
export function acceptSession(
  known: AgentSession | undefined,
  report: SessionReport,
  now: number,
  exists: Exists = existsSync
): AgentSession | null {
  if (!report.id) return null

  // Any claim held from an earlier `SessionStart` that has since written its
  // transcript is settled first: it is a conversation now, and the one this
  // pane is having.
  const current = settle(known, exists)

  if (current && current.id !== report.id) {
    const written = Boolean(report.transcript && exists(report.transcript))
    const speaking = report.hookEvent === 'UserPromptSubmit'
    if (!written && !speaking) {
      // Refused, but not discarded. An id with a transcript path is a claim
      // that can be checked later, and checking it later is what keeps a pane
      // that started a second conversation from resuming the first one for
      // ever. Without a path there is nothing to check, so the old rule stands.
      if (report.transcript && current.pending?.id !== report.id) {
        return { ...current, pending: { id: report.id, transcript: report.transcript, at: now } }
      }
      return changed(known, current)
    }
  }

  // The same conversation saying so again is worth writing through only to
  // keep its TTL fresh, and not on every prompt.
  if (current && current.id === report.id && now - current.at < RECORD_REFRESH_MS) {
    return changed(known, current)
  }

  // Whatever was being held is dropped here: this id is evidence and that one
  // was not, so there is no longer a question for it to answer.
  return {
    tool: 'claude',
    id: report.id,
    at: now,
    // Kept even when the file is not there yet: this is where Claude Code says
    // the conversation goes, and whether it arrived is a question for the
    // moment we would resume it rather than for now.
    ...(report.transcript ? { transcript: report.transcript } : {}),
  }
}

/**
 * The record with a held claim promoted, if its transcript has appeared.
 *
 * A transcript arriving is not something anything tells us about — Claude Code
 * writes the file when the first turn completes and fires no hook to say so —
 * so the question is asked wherever the record is read instead. That makes this
 * work on the hooks a user already has installed: `SessionStart` alone is
 * enough, where before a pane that never saw a `UserPromptSubmit` could hold a
 * stale id until it aged out a fortnight later.
 *
 * The claim's own timestamp comes with it, so the TTL runs from when the
 * conversation started rather than from whenever we happened to notice.
 */
function settle(known: AgentSession | undefined, exists: Exists): AgentSession | undefined {
  const claim = known?.pending
  if (!known || !claim || !exists(claim.transcript)) return known
  return { tool: 'claude', id: claim.id, at: claim.at, transcript: claim.transcript }
}

/** The settled record when settling changed it, and nothing to write when not. */
function changed(known: AgentSession | undefined, current: AgentSession): AgentSession | null {
  return current === known ? null : current
}

/**
 * The line that re-enters a recorded conversation, or null for none.
 *
 * `--resume <id>` and not `--continue`: continue means "the newest session in
 * this folder", which is the wrong answer the moment two panes are open on one
 * project. The id is checked against the shape Claude Code issues rather than
 * interpolated blind — it ends up on a command line, and this one is
 * reconstructed from a file on disk.
 *
 * The transcript is checked for the same reason the id is: a conversation whose
 * file has gone cannot be re-entered, and Claude Code says so in the pane.
 * Claude Code's own retention sweep deletes old transcripts, a project folder
 * can be moved out from under one, and a session can be recorded moments before
 * it is killed mid-turn. A pane that opens at a clean prompt is a better answer
 * than one that opens at an error. Records written before the transcript was
 * carried have nothing to check and are taken at their word; they age out.
 *
 * A held claim is settled here too, and this is the moment it matters most: the
 * app is starting, the conversation that claim named has been written for
 * hours, and resuming the record it was refused by would reopen the one before
 * it. See `settle`.
 */
export function resumeCommand(
  known: AgentSession | undefined,
  now: number,
  exists: Exists = existsSync
): string | null {
  const session = settle(known, exists)
  if (!session || session.tool !== 'claude') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(session.id)) return null
  if (now - session.at > AGENT_SESSION_TTL_MS) return null
  if (session.transcript && !exists(session.transcript)) return null
  return `claude --resume ${session.id}`
}
