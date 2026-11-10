/**
 * Find in a Claude conversation — what was said in it, not what is on screen.
 *
 * The terminal's own find searches the terminal's buffer, and for Claude Code
 * that buffer is often not the conversation. In its full-screen view Claude
 * Code draws on the alternate screen and keeps the scrolling to itself, so the
 * terminal holds one screenful and nothing above it: a find there "finds
 * nothing" for anything older than the last page. Without the full-screen view
 * it still redraws whole regions as it goes, and a resize or a clear takes the
 * older lines with it.
 *
 * The conversation itself is on disk, whole, in the transcript the pane's
 * session already points at. So for a Claude pane the find bar reads that
 * instead: your prompts and Claude's replies, nothing it generated for itself
 * and none of the tool traffic in between.
 *
 * Pure: `main/conversationSearch.ts` reads the file and feeds lines in here.
 */

/** `summary` is the recap Claude Code writes when it compacts a conversation. */
export type Speaker = 'you' | 'claude' | 'summary'

export interface ConversationMessage {
  who: Speaker
  /** Epoch ms, or 0 when the line carried no usable timestamp. */
  at: number
  text: string
  /** The API message a reply belongs to, so its pieces join into one. */
  messageId?: string
}

export interface ConversationHit {
  who: Speaker
  at: number
  text: string
  /** How many times the query occurs in this message. */
  count: number
}

export interface ConversationFind {
  /** Newest first, at most the limit asked for. */
  hits: ConversationHit[]
  /** Messages that matched — may be more than `hits` holds. */
  messages: number
  /** Occurrences across every matching message. */
  matches: number
  /** Messages in the conversation, matching or not. */
  total: number
}

/** A message longer than this is cut, so one pasted log cannot make a hit list megabytes long. */
const MAX_TEXT = 20_000

/**
 * The text of one transcript row, if it is something a person would call part
 * of the conversation. `human` is the prompt filter `main/turns.ts` already
 * applies — what you typed, as opposed to what Claude Code typed for you.
 */
export function messageOf(
  row: any,
  human: (row: any) => { text: string } | null
): ConversationMessage | null {
  if (!row || typeof row !== 'object' || row.isSidechain) return null
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) || 0 : 0

  if (row.type === 'user') {
    if (row.isCompactSummary && typeof row.message?.content === 'string') {
      return { who: 'summary', at, text: row.message.content.trim() }
    }
    const prompt = human(row)
    return prompt ? { who: 'you', at, text: prompt.text } : null
  }

  if (row.type === 'assistant') {
    const content = row.message?.content
    if (!Array.isArray(content)) return null
    const parts: string[] = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    const text = parts.join('\n').trim()
    if (!text) return null
    const id = typeof row.message?.id === 'string' ? row.message.id : undefined
    return { who: 'claude', at, text, messageId: id }
  }

  return null
}

/**
 * Adds a message to a conversation. A reply written out in several rows — one
 * per content block, as Claude Code records them — joins the one before it.
 */
export function appendMessage(into: ConversationMessage[], message: ConversationMessage): void {
  const last = into[into.length - 1]
  if (last && message.who === 'claude' && last.who === 'claude' && message.messageId && last.messageId === message.messageId) {
    last.text = `${last.text}\n\n${message.text}`
    return
  }
  into.push(message)
}

/** How many times `needle` (already lower-cased) occurs in `hay`. */
function occurrences(hay: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at < 0) return count
    count++
    from = at + needle.length
  }
}

/**
 * The messages containing `query`, newest first. Case-insensitive and
 * literal, the way a find bar is: what you type is what is looked for, with no
 * syntax to trip over.
 */
export function findInConversation(messages: ConversationMessage[], query: string, limit: number): ConversationFind {
  const needle = query.trim().toLowerCase()
  const result: ConversationFind = { hits: [], messages: 0, matches: 0, total: messages.length }
  if (!needle) return result

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const count = occurrences(message.text.toLowerCase(), needle)
    if (!count) continue
    result.messages++
    result.matches += count
    if (result.hits.length < limit) {
      const text = message.text.length > MAX_TEXT ? `${message.text.slice(0, MAX_TEXT)}\n[…cut]` : message.text
      result.hits.push({ who: message.who, at: message.at, text, count })
    }
  }
  return result
}

/**
 * Splits text into plain and matching pieces, for drawing with the matches
 * marked. Case-insensitive, like the search that found them.
 */
export function markPieces(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const out: { text: string; match: boolean }[] = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at < 0) break
    if (at > from) out.push({ text: text.slice(from, at), match: false })
    out.push({ text: text.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < text.length) out.push({ text: text.slice(from), match: false })
  return out
}

/**
 * A short piece of a message around its first match, on one line, so a list of
 * hits can be scanned by eye.
 */
export function snippetOf(text: string, query: string, width = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const needle = query.trim().toLowerCase()
  const at = needle ? flat.toLowerCase().indexOf(needle) : -1
  if (flat.length <= width) return flat
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}
