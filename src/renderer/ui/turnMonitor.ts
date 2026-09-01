/**
 * The turn index, kept current and shared by everything that draws from it.
 *
 * The sibling of `tokenMonitor.ts` and built the same way, for the same reason:
 * three separate features want the same scan, and three features each asking
 * for their own would be three answers that can disagree about what happened
 * ten seconds ago. This module holds one answer and hands it out.
 *
 * **It refreshes when a turn ends, not only on the clock.** A minute's poll is
 * right for token totals, which nobody watches, and wrong for the strip under a
 * pane that has just this second finished replying — a summary of the last turn
 * that arrives forty seconds late is a summary of nothing, because by then you
 * have already scrolled up to read it yourself. The store says when an agent
 * stops working; that is the moment worth reading the file again, and it costs
 * one incremental read of one transcript that has grown by a few kilobytes.
 *
 * **It draws none of it.** `promptsPane.ts` formats the search, `terminals.ts`
 * formats the strip, and `palette.ts` formats the file list — which is what let
 * each of them be tried and changed without the reading moving.
 */
import { backend } from '../../backend'
import { store } from '../state'
import type { AgentTurn, TurnIndex } from '../../shared/types'

/**
 * The unattended cadence.
 *
 * A minute, matching the token monitor, and for the same reason: local files
 * whose offsets are already parsed, so the cost of asking is close to nothing —
 * but nothing here is live enough that a stale minute misleads anybody. Every
 * refresh that matters is triggered rather than waited for.
 */
const POLL_MS = 60 * 1000

/**
 * How long to wait after an agent stops before reading.
 *
 * The transcript is written by another process, and "the agent said it has
 * finished" and "the last line of the reply is on the disk" are not the same
 * instant. A second is far longer than that gap and far shorter than anybody's
 * attention, and it also collapses the burst of six panes finishing together
 * into one read rather than six.
 */
const AFTER_TURN_MS = 1000

let latest: TurnIndex | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let settle: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

export function initTurnMonitor(): void {
  void refresh()
  // Coming back to the window is when you are most likely to be looking, and
  // most likely to have just finished a conversation somewhere else.
  window.addEventListener('focus', () => void refresh())
  store.onAgentRunEnded(() => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      void refresh()
    }, AFTER_TURN_MS)
  })
}

/**
 * The last index, or null before the first.
 *
 * Null is not empty and is drawn differently — the first scan reads every
 * transcript on the disk, and "still reading" must not look like "you have
 * never said anything".
 */
export function latestTurns(): TurnIndex | null {
  return latest
}

/** Called whenever a new index lands, for anything that draws one. */
export function watchTurns(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Asks now rather than waiting for the poll. */
export function refreshTurnsNow(): void {
  void refresh()
}

async function refresh(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  try {
    latest = await backend().claudeTurns()
  } catch {
    // A host that has not ported the call, or a read that failed. The last good
    // index stays on screen rather than blanking — nothing here is live enough
    // for a stale record to mislead anyone.
  }
  byFile = null
  for (const fn of listeners) fn()
  timer = setTimeout(() => void refresh(), POLL_MS)
}

/**
 * Turns grouped by the transcript they came from, built once per index.
 *
 * Every per-pane question is "what happened in *this* conversation", and
 * answering it by filtering a few thousand turns on every keystroke is the kind
 * of cost that only shows up on the machine of whoever has used the app
 * longest. Rebuilt when the index changes and not before.
 */
let byFile: Map<string, AgentTurn[]> | null = null

function grouped(): Map<string, AgentTurn[]> {
  if (byFile) return byFile
  const out = new Map<string, AgentTurn[]>()
  for (const turn of latest?.turns ?? []) {
    const list = out.get(turn.file)
    if (list) list.push(turn)
    else out.set(turn.file, [turn])
  }
  byFile = out
  return out
}

/**
 * A pane's own turns, newest first.
 *
 * Addressed by the transcript's path rather than by the session id, because
 * that is what a pane records — see `AgentSession.transcript`, and the argument
 * there for why an id on its own is a claim rather than a conversation.
 */
export function turnsOfTranscript(file: string | undefined): AgentTurn[] {
  if (!file) return []
  return grouped().get(file) ?? []
}

/** The most recent turn of a pane's conversation, or null if it has had none. */
export function lastTurn(file: string | undefined): AgentTurn | null {
  return turnsOfTranscript(file)[0] ?? null
}

/**
 * Every file this pane's agent has opened, most recently touched first.
 *
 * Written files come before read ones at the same recency, on the grounds that
 * the question behind this list is almost always "the thing it just changed"
 * rather than "the thing it glanced at on the way".
 */
export function filesTouched(file: string | undefined): { path: string; wrote: boolean }[] {
  const seen = new Map<string, boolean>()
  for (const turn of turnsOfTranscript(file)) {
    for (const edit of turn.edited) seen.set(edit.path, true)
    for (const path of turn.read) if (!seen.has(path)) seen.set(path, false)
  }
  return [...seen].map(([path, wrote]) => ({ path, wrote }))
}

/** The conversation a transcript belongs to, for its name and its own cost. */
export function conversationOf(file: string | undefined) {
  if (!file) return null
  return latest?.conversations.find((c) => c.file === file) ?? null
}
