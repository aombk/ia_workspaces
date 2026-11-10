/**
 * Reads a pane's Claude conversation for the find bar — see
 * `shared/conversationSearch.ts` for why the terminal's own buffer is not
 * enough.
 *
 * Kept read incrementally, like the other transcript readers: a find bar asks
 * on every keystroke, and a long conversation is tens of megabytes, so each
 * file is read once and then only for what has been appended since.
 */
import path from 'node:path'
import { readAppended, transcriptsRoot, type Scanned } from './transcripts'
import { human } from './turns'
import {
  appendMessage,
  findInConversation,
  messageOf,
  type ConversationFind,
  type ConversationMessage,
} from '../shared/conversationSearch'

/** Hits sent back. A query matching more is a query to make longer, and the count says so. */
const LIMIT = 300
/** Conversations kept in memory. A find bar is used on the pane in front of you, rarely more. */
const KEEP = 6

interface Entry {
  scanned?: Scanned
  messages: ConversationMessage[]
}

const cache = new Map<string, Entry>()

/**
 * Only Claude Code's own transcripts. The path arrives from a window, and a
 * window asking to read an arbitrary file is not a request this answers.
 */
function isTranscript(file: string): boolean {
  const root = path.resolve(transcriptsRoot()) + path.sep
  const full = path.resolve(file)
  const under = process.platform === 'win32' ? full.toLowerCase().startsWith(root.toLowerCase()) : full.startsWith(root)
  return under && full.toLowerCase().endsWith('.jsonl')
}

export async function searchConversation(file: string, query: string): Promise<ConversationFind | null> {
  if (typeof file !== 'string' || typeof query !== 'string' || !isTranscript(file)) return null
  const key = path.resolve(file)
  const entry = cache.get(key) ?? { messages: [] }
  try {
    const read = await readAppended(
      key,
      entry.scanned,
      (line) => {
        let row: unknown
        try {
          row = JSON.parse(line)
        } catch {
          return
        }
        const message = messageOf(row, human)
        if (message) appendMessage(entry.messages, message)
      },
      () => {
        entry.messages = []
      }
    )
    if (read) entry.scanned = read.scanned
  } catch {
    return null
  }
  // Most recently asked last, so the oldest is the one let go.
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > KEEP) cache.delete(cache.keys().next().value!)
  return findInConversation(entry.messages, query, LIMIT)
}
