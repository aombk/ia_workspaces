/**
 * Which commands in a project are worth showing, and what to say about each.
 *
 * The runbook's whole content, extracted from the pane that used to be the only
 * thing drawing it. It is now a *view* inside the command-history box rather
 * than a tab of its own — the same commands, asked a different question — and
 * two places rendering one ranking from two copies of the rule is how they come
 * to disagree about which command is worst.
 *
 * Pure functions over `HistoryEntry`, in `shared/` so they can be exercised
 * without a document.
 */
import type { HistoryEntry } from './types'

/**
 * Runs before a command is ranked on its failure rate rather than its count.
 *
 * One run that failed is not a flaky command, it is a command you got wrong
 * once — and a project's list would otherwise be led by every typo ever made in
 * it. Below this, a command sorts on how often it is run.
 */
export const ENOUGH_RUNS = 3

/**
 * Path comparison as the filesystem means it, not as JavaScript does.
 *
 * Windows writes separators both ways round and does not care about case, so
 * the same folder arrives spelled three ways across a week of use.
 */
export function normPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Whether a command was run in this project, or anywhere below it. */
export function inProject(entry: { cwd?: string }, root: string): boolean {
  if (!root) return false
  const a = normPath(entry.cwd ?? '')
  const b = normPath(root)
  return a === b || a.startsWith(`${b}/`)
}

/**
 * Most worth showing first.
 *
 * How often it is run, except where it has run enough times for its failure
 * rate to mean anything — a command that fails half the time is more worth
 * seeing than one run twice as often that always works. Recency breaks ties,
 * because two commands run the same number of times are told apart by which one
 * you were using this morning.
 */
export function byRunbookRank(a: HistoryEntry, b: HistoryEntry): number {
  const aRuns = a.runs ?? 1
  const bRuns = b.runs ?? 1
  if (aRuns >= ENOUGH_RUNS && bRuns >= ENOUGH_RUNS) {
    const aRate = (a.fails ?? 0) / aRuns
    const bRate = (b.fails ?? 0) / bRuns
    if (aRate !== bRate) return bRate - aRate
  }
  return bRuns - aRuns || b.at - a.at
}

/**
 * How this command has been going: how much it is used, and how it went.
 *
 * The state comes first because it is the thing that changes what you do next.
 * A command that ended in an error last time says so before it says anything
 * about how popular it is.
 */
export function commandFacts(entry: HistoryEntry): string {
  const runs = entry.runs ?? 1
  const fails = entry.fails ?? 0
  const parts: string[] = []

  if (entry.lastCode !== undefined && entry.lastCode !== 0) parts.push(`failed (exit ${entry.lastCode})`)
  else if (fails) parts.push(`worked, failed ${fails} of ${runs}`)

  parts.push(runs === 1 ? 'once' : `${runs} times`)
  if (entry.lastMs !== undefined) parts.push(took(entry.lastMs))
  return parts.join(' · ')
}

/** A duration a person would say out loud. */
export function took(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 90) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}
