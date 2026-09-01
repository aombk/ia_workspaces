/**
 * The small search language the prompt explorer takes.
 *
 * Deliberately small. The temptation with a search box over a few thousand
 * records is to grow it a grammar — boolean groups, field-scoped full text,
 * ranges — and the honest observation is that nobody remembers the grammar of a
 * box they open twice a month. What people do remember is what every search box
 * they have ever used does: type some words, quote a phrase, put a minus in
 * front of the one you do not want. That is most of this.
 *
 * The three filters that are not that — `project:`, `after:`, `before:` — earn
 * their place because they answer the question that the words cannot: the
 * words find "notarisation" in four projects across two years, and the only
 * thing that narrows it is knowing roughly where or roughly when.
 *
 * In `shared/` rather than beside the pane so it can be exercised without a
 * document — the parsing is where the mistakes are, and they are the kind that
 * look like a search that simply found nothing.
 */
import type { AgentTurn } from './types'

export interface Span {
  from: number
  to: number
}

export interface Query {
  /** Every one of these must appear, case-insensitively. */
  words: string[]
  /** Each of these must appear as written, in that order. */
  phrases: string[]
  /** None of these may appear. */
  without: string[]
  /** Substring of the folder the prompt was sent in. */
  project: string | null
  /** Inclusive bounds, in ms, or null for unbounded. */
  after: number | null
  before: number | null
  /** Whether the prompt had to carry a picture. */
  withImage: boolean
  /** Where the positive terms matched in a piece of text, for marking it up. */
  spans(text: string): Span[]
}

/**
 * Parses the box's contents.
 *
 * Never throws and never reports a syntax error. A search box that refuses to
 * search because of a stray quote is a box that punishes typing quickly, and
 * everything unrecognised here has an obvious reading as "look for this word" —
 * so that is what it gets.
 */
export function parseQuery(raw: string): Query {
  const words: string[] = []
  const phrases: string[] = []
  const without: string[] = []
  let project: string | null = null
  let after: number | null = null
  let before: number | null = null
  let withImage = false

  for (const token of tokenize(raw)) {
    if (token.quoted) {
      if (token.text) phrases.push(token.text)
      continue
    }
    const text = token.text
    if (!text) continue

    if (text.startsWith('-') && text.length > 1) {
      without.push(text.slice(1).toLowerCase())
      continue
    }

    const colon = text.indexOf(':')
    if (colon > 0) {
      const field = text.slice(0, colon).toLowerCase()
      const value = text.slice(colon + 1)
      if (field === 'project' && value) {
        project = value.toLowerCase()
        continue
      }
      if (field === 'after') {
        const at = day(value)
        if (at !== null) {
          after = at
          continue
        }
      }
      if (field === 'before') {
        const at = day(value)
        if (at !== null) {
          // The end of that day rather than its start: "before:2026-02-01"
          // meaning "not on the first of February" is the reading nobody has.
          before = at + 86_400_000 - 1
          continue
        }
      }
      if (field === 'has' && value.toLowerCase() === 'image') {
        withImage = true
        continue
      }
      // A colon that is not one of ours — a URL, a time, a Windows path — is a
      // word. Falling through rather than dropping it is what keeps the box
      // honest about text it does not understand.
    }

    words.push(text.toLowerCase())
  }

  const positives = [...phrases, ...words]
  return {
    words,
    phrases,
    without,
    project,
    after,
    before,
    withImage,
    spans: (text: string) => spansOf(text, positives),
  }
}

/** Whether a turn satisfies every part of the query. */
export function matches(turn: AgentTurn, query: Query): boolean {
  const text = turn.prompt.toLowerCase()

  for (const word of query.words) if (!text.includes(word)) return false
  for (const phrase of query.phrases) if (!text.includes(phrase.toLowerCase())) return false
  for (const word of query.without) if (text.includes(word)) return false

  if (query.project && !turn.cwd.toLowerCase().includes(query.project)) return false
  if (query.after !== null && turn.at < query.after) return false
  if (query.before !== null && turn.at > query.before) return false
  if (query.withImage && !turn.images) return false

  return true
}

/**
 * Splits on spaces, except inside double quotes.
 *
 * An unclosed quote runs to the end of the input rather than being an error,
 * which is what a box being typed into looks like for as long as it takes to
 * type the closing one.
 */
function tokenize(raw: string): { text: string; quoted: boolean }[] {
  const out: { text: string; quoted: boolean }[] = []
  let current = ''
  let quoted = false
  let inQuotes = false

  const push = () => {
    if (current || quoted) out.push({ text: current, quoted })
    current = ''
    quoted = false
  }

  for (const ch of raw) {
    if (ch === '"') {
      if (inQuotes) {
        inQuotes = false
        quoted = true
        push()
      } else {
        push()
        inQuotes = true
      }
      continue
    }
    if (!inQuotes && /\s/.test(ch)) {
      push()
      continue
    }
    current += ch
  }
  if (inQuotes) quoted = true
  push()
  return out
}

/**
 * A `YYYY-MM-DD` as the start of that day in the machine's own timezone.
 *
 * Local rather than UTC, deliberately: "after:2026-01-15" means the day the
 * person had, and parsing it as UTC moves the boundary by up to a day for
 * anybody who is not on it.
 */
function day(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isFinite(at.getTime()) ? at.getTime() : null
}

/**
 * Where the positive terms appear, merged and in order.
 *
 * Overlaps are merged rather than drawn twice — searching "form" and "forms"
 * would otherwise open a mark inside a mark, and the result is not a nesting
 * problem so much as a highlight that visibly doubles back on itself.
 */
function spansOf(text: string, terms: string[]): Span[] {
  if (!terms.length || !text) return []
  const hay = text.toLowerCase()
  const found: Span[] = []

  for (const term of terms) {
    if (!term) continue
    const needle = term.toLowerCase()
    let at = hay.indexOf(needle)
    while (at !== -1) {
      found.push({ from: at, to: at + needle.length })
      at = hay.indexOf(needle, at + needle.length)
    }
  }

  found.sort((a, b) => a.from - b.from || b.to - a.to)
  const merged: Span[] = []
  for (const span of found) {
    const last = merged[merged.length - 1]
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to)
    else merged.push({ ...span })
  }
  return merged
}
