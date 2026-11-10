// Find in a Claude conversation: what counts as said, and how matches are counted.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-convfind-'))
const outfile = path.join(sandbox, 'conversationSearch.mjs')
await build({
  entryPoints: ['src/shared/conversationSearch.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})
const { messageOf, appendMessage, findInConversation, markPieces, snippetOf } = await import(`file://${outfile}`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok ${name}`)
}

// The prompt filter is turns.ts's; here a stand-in that accepts string content.
const human = (row) => (typeof row.message?.content === 'string' ? { text: row.message.content } : null)
const at = '2026-11-08T10:00:00.000Z'

check('a prompt and a reply are messages; tool traffic and side chains are not', () => {
  assert.deepEqual(messageOf({ type: 'user', timestamp: at, message: { content: 'fix the build' } }, human), {
    who: 'you',
    at: Date.parse(at),
    text: 'fix the build',
  })
  const reply = messageOf(
    { type: 'assistant', timestamp: at, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Done.' }] } },
    human
  )
  assert.equal(reply.who, 'claude')
  assert.equal(reply.text, 'Done.')
  assert.equal(messageOf({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }, human), null)
  assert.equal(messageOf({ type: 'user', message: { content: [{ type: 'tool_result' }] } }, human), null)
  assert.equal(messageOf({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sub' }] } }, human), null)
  assert.equal(messageOf({ type: 'user', isCompactSummary: true, message: { content: 'recap' } }, human).who, 'summary')
  assert.equal(messageOf({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'text', text: 'dup' }] } }, human), null)
})

check('the pieces of one reply join; separate replies do not', () => {
  const list = []
  appendMessage(list, { who: 'claude', at: 1, text: 'one', messageId: 'a' })
  appendMessage(list, { who: 'claude', at: 2, text: 'two', messageId: 'a' })
  appendMessage(list, { who: 'claude', at: 3, text: 'three', messageId: 'b' })
  assert.deepEqual(list.map((m) => m.text), ['one\n\ntwo', 'three'])
})

check('matches are case-insensitive, counted, and newest first', () => {
  const messages = [
    { who: 'you', at: 1, text: 'Where is the Find bar?' },
    { who: 'claude', at: 2, text: 'No match here' },
    { who: 'claude', at: 3, text: 'find, find and FIND' },
  ]
  const r = findInConversation(messages, ' find ', 10)
  assert.equal(r.total, 3)
  assert.equal(r.messages, 2)
  assert.equal(r.matches, 4)
  assert.deepEqual(r.hits.map((h) => h.at), [3, 1])
  assert.equal(r.hits[0].count, 3)
  assert.equal(findInConversation(messages, '   ', 10).messages, 0)
})

check('the limit cuts the list, not the counts', () => {
  const messages = Array.from({ length: 50 }, (_, i) => ({ who: 'you', at: i, text: `item ${i}` }))
  const r = findInConversation(messages, 'item', 5)
  assert.equal(r.hits.length, 5)
  assert.equal(r.messages, 50)
})

check('marking keeps the text as written', () => {
  const pieces = markPieces('a Foo b foo', 'foo')
  assert.deepEqual(pieces, [
    { text: 'a ', match: false },
    { text: 'Foo', match: true },
    { text: ' b ', match: false },
    { text: 'foo', match: true },
  ])
  assert.equal(pieces.map((p) => p.text).join(''), 'a Foo b foo')
})

check('a snippet is centred on the first match', () => {
  const text = `${'x '.repeat(200)}needle${' y'.repeat(200)}`
  const s = snippetOf(text, 'needle', 60)
  assert.ok(s.includes('needle'))
  assert.ok(s.startsWith('…') && s.endsWith('…'))
  assert.equal(snippetOf('short\n text', 'x'), 'short text')
})

console.log(`\n${passed} checks passed`)
