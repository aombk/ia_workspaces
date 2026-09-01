/**
 * The words a turn is described in, said once.
 *
 * Two places draw a turn — the strip under a pane that has just finished one,
 * and the row in the prompt explorer — and they are the same facts at two
 * sizes. Formatted here so they cannot drift into two vocabularies for one
 * thing, which is how "3 files" in one place and "3 changed" in another come to
 * mean subtly different counts that nobody ever reconciles.
 *
 * The figures themselves are `tokenMonitor.ts`'s: this module decides what to
 * say and in what order, and that one decides what a number looks like.
 */
import { COST_CAVEAT, money, tokenCount } from './tokenMonitor'
import { CACHE_MULTIPLIERS, priceFor } from '../../shared/types'
import type { AgentTurn } from '../../shared/types'

/** One thing said about a turn. `quiet` is drawn dimmer — context, not news. */
export interface TurnFact {
  text: string
  title?: string
  quiet?: boolean
}

/**
 * A model id as the thing people call it.
 *
 * `claude-opus-5[1m]` is the string the API answered with and is the right one
 * to keep in the record; it is the wrong one to put in a strip six words long.
 * The version suffixes are dropped and the variant in brackets is kept, since
 * a million-token context is the part of that name that changes what you expect
 * of it.
 */
export function modelName(model: string | null): string {
  if (!model) return 'no reply'
  const variant = /\[([^\]]+)\]/.exec(model)?.[1]
  const base = model
    .replace(/\[[^\]]*\]/, '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-latest$/, '')
  return variant ? `${base} ${variant}` : base
}

/** `4m 12s`, or null when the turn never finished. */
export function howLong(turn: AgentTurn): string | null {
  if (turn.endedAt === null || !turn.at) return null
  const seconds = Math.round((turn.endedAt - turn.at) / 1000)
  if (seconds < 1) return null
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/**
 * What this turn would have cost at API prices, or null on an unpriced model.
 *
 * Re-derived rather than carried on the record: prices change, and a cost
 * frozen into the index at the moment it was written would be a number that
 * silently disagrees with every other dollar figure in the app.
 *
 * The rates and the multipliers are the published ones, from the same constants
 * the token pane prices whole projects with — five classes of token at five
 * rates, because adding them first and pricing the total is the arithmetic that
 * made a project look like it had spent two billion of something.
 */
export function costOf(turn: AgentTurn): number | null {
  if (!turn.model) return null
  const price = priceFor(turn.model)
  if (!price) return null
  const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000
  return (
    per(turn.totals.input, price.input) +
    per(turn.totals.output, price.output) +
    per(turn.totals.cacheWrite5m, price.input * CACHE_MULTIPLIERS.write5m) +
    per(turn.totals.cacheWrite1h, price.input * CACHE_MULTIPLIERS.write1h) +
    per(turn.totals.cacheRead, price.input * CACHE_MULTIPLIERS.read)
  )
}

/**
 * The turn, as a strip of facts, in the order they answer questions.
 *
 * Which model, how full the window is, what it changed, what it ran, how long
 * it took, what it would have cost — narrowing from "what was this" to "what
 * did it cost me", which is the order people read them in and the order that
 * lets the tail be cut off in a narrow pane without losing the point.
 *
 * The money carries a `~` and the caveat every dollar figure in this app
 * carries: a subscription does not bill per token.
 */
export function describeTurn(turn: AgentTurn): TurnFact[] {
  const facts: TurnFact[] = []
  const cost = costOf(turn)

  facts.push({ text: modelName(turn.model), quiet: true })

  if (turn.context) {
    facts.push({
      text: `${tokenCount(turn.context)} ctx`,
      title:
        'What the model was carrying on its last reply — the window in use, not what this turn added.',
    })
  }

  const added = turn.edited.reduce((n, e) => n + e.added, 0)
  const removed = turn.edited.reduce((n, e) => n + e.removed, 0)
  if (turn.edited.length) {
    const files = turn.edited.length === 1 ? '1 file' : `${turn.edited.length} files`
    facts.push({
      text: `${files} +${added}/-${removed}`,
      title: turn.edited.map((e) => `${e.path} +${e.added}/-${e.removed}`).join('\n'),
    })
  }

  if (turn.read.length) {
    facts.push({
      text: `${turn.read.length} read`,
      quiet: true,
      title: turn.read.join('\n'),
    })
  }

  // The tools, busiest first, and only the two that ran most. A turn with nine
  // kinds of tool call in it produces a strip nobody can read, and the long tail
  // of one-offs is never the thing that explains where the time went.
  const tools = Object.entries(turn.tools).sort((a, b) => b[1] - a[1])
  if (tools.length) {
    facts.push({
      text: tools
        .slice(0, 2)
        .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
        .join(' '),
      quiet: true,
      title: tools.map(([name, n]) => `${name} ×${n}`).join('\n'),
    })
  }

  const took = howLong(turn)
  if (took) facts.push({ text: took, quiet: true })

  if (cost !== null) facts.push({ text: `~${money(cost)}`, title: COST_CAVEAT })

  return facts
}
