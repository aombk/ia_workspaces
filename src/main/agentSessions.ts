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

  if (known && known.id !== report.id) {
    const written = Boolean(report.transcript && exists(report.transcript))
    const speaking = report.hookEvent === 'UserPromptSubmit'
    if (!written && !speaking) return null
  }

  // The same conversation saying so again is worth writing through only to
  // keep its TTL fresh, and not on every prompt.
  if (known && known.id === report.id && now - known.at < RECORD_REFRESH_MS) return null

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
 */
export function resumeCommand(
  session: AgentSession | undefined,
  now: number,
  exists: Exists = existsSync
): string | null {
  if (!session || session.tool !== 'claude') return null
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(session.id)) return null
  if (now - session.at > AGENT_SESSION_TTL_MS) return null
  if (session.transcript && !exists(session.transcript)) return null
  return `claude --resume ${session.id}`
}
