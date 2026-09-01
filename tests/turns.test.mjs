// The turn index, against transcripts we wrote ourselves.
//
// What is being defended here is a *filter*, and a filter's failures are quiet
// by nature: a prompt list that has silently started including
// `<command-name>/clear</command-name>` looks exactly like one that has not
// until you scroll to it, and a turn that dropped an edit looks exactly like a
// turn that made none. So every fixture below is a line Claude Code really
// writes — the shapes were read off this machine's own transcripts — and each
// check names the thing that would otherwise pass unnoticed.
//
// Runs against a throwaway HOME so the real ~/.claude is never read.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-turns-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const outfile = path.join(sandbox, 'turns.mjs')
await build({
  entryPoints: ['src/main/turns.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

const { readTurnIndex, turnCost } = await import(`file://${outfile}`)

/** Where the app remembers its offsets — the app's own data folder, not HOME. */
const stateDir = path.join(sandbox, 'appdata')
fs.mkdirSync(stateDir, { recursive: true })

const projects = path.join(sandbox, '.claude', 'projects')
const PROJECT = 'C--work-alpha'
const CWD = 'C:\\work\\alpha'
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444'

function transcript(name) {
  const dir = path.join(projects, PROJECT)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${name}.jsonl`)
}

const line = (row) => `${JSON.stringify(row)}\n`

/**
 * A clock that always moves.
 *
 * Real transcripts are written a line at a time by a process doing work between
 * them, so their timestamps differ; a test writing five fixtures in a loop gets
 * the same millisecond five times and then asserts against whichever order the
 * sort happened to leave them in. That is a test that passes until it doesn't.
 */
let tick = Date.parse('2026-01-01T09:00:00.000Z')
const now = () => new Date((tick += 1000)).toISOString()

/** A prompt somebody typed, in the shape the current format writes it. */
function prompt(text, extra = {}) {
  return line({
    type: 'user',
    sessionId: SESSION,
    // A line's own id, overridable: a transcript is refused any line claiming a
    // conversation other than the one the file is named for, so a fixture
    // written into another file has to say so.
    cwd: CWD,
    gitBranch: 'main',
    timestamp: now(),
    origin: { kind: 'human' },
    promptSource: 'typed',
    message: { role: 'user', content: text },
    ...extra,
  })
}

/** An assistant reply, optionally calling tools. */
function reply({ session = SESSION, model = 'claude-opus-5', input = 0, output = 0, read = 0, tools = [] } = {}) {
  return line({
    type: 'assistant',
    sessionId: session,
    cwd: CWD,
    timestamp: now(),
    message: {
      model,
      content: tools.map((t) => ({ type: 'tool_use', name: t.name, input: t.input ?? {} })),
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
      },
    },
  })
}

/** The user-role line carrying a tool's result back. Never a prompt. */
function result(toolUseResult) {
  return line({
    type: 'user',
    sessionId: SESSION,
    cwd: CWD,
    timestamp: now(),
    message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] },
    toolUseResult,
  })
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

console.log('Reading a conversation')

await check('no transcripts at all reports none, not an empty conversation', async () => {
  const index = await readTurnIndex(stateDir)
  assert.equal(index.status, 'none')
  assert.deepEqual(index.turns, [])
})

const file = transcript(SESSION)

await check('a prompt starts a turn and the replies to it fold in', async () => {
  fs.writeFileSync(
    file,
    prompt('add a login form') +
      reply({ input: 10, output: 20, read: 1000 }) +
      reply({ input: 1, output: 2, read: 2000 })
  )
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.length, 1)
  const turn = index.turns[0]
  assert.equal(turn.prompt, 'add a login form')
  assert.equal(turn.n, 1)
  assert.equal(turn.branch, 'main')
  assert.equal(turn.cwd, CWD)
  // Summed over the turn: two replies, one thing asked for.
  assert.equal(turn.totals.output, 22)
  assert.equal(turn.totals.messages, 2)
})

await check('context is the last reply’s level, not the sum of every reply', async () => {
  // The failure this exists for: adding the context of forty replies produces a
  // number several times the size of any window that exists, and it looks
  // plausible right up until somebody notices a 900k context on a 200k model.
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns[0].context, 2001)
})

console.log('Telling a prompt from everything else')

await check('a tool result is not a prompt, however user-shaped the line is', async () => {
  fs.appendFileSync(file, result({ stdout: 'ok', stderr: '' }))
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.length, 1, 'a tool result must not open a turn')
})

await check('a line the harness generated is not something you typed', async () => {
  // Claude Code writes its own notifications as user turns and marks them. The
  // marking is the whole filter — see the note at the top of turns.ts.
  fs.appendFileSync(
    file,
    prompt('a task you started has finished', { origin: { kind: 'task-notification' }, promptSource: 'system' })
  )
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.length, 1)
})

await check('a queued prompt is still one you typed', async () => {
  fs.appendFileSync(file, prompt('and now the tests', { promptSource: 'queued' }))
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.length, 2)
  assert.equal(index.turns[0].prompt, 'and now the tests', 'newest first')
})

await check('a subagent’s prompt is not one of yours', async () => {
  fs.appendFileSync(file, prompt('search the codebase for X', { isSidechain: true }))
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.length, 2)
})

console.log('Transcripts written before prompts were marked')

const old = transcript('bbbbbbbb-1111-2222-3333-444444444444')

await check('slash-command plumbing is not a prompt', async () => {
  // No `origin` field at all: the older format, where the only thing to go on
  // is the shape of the text. This set is closed — every new transcript carries
  // the field — so a fixed list is honest here in a way it would not be for a
  // format still moving.
  const bare = (content, extra = {}) =>
    line({ type: 'user', sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: CWD, timestamp: now(), message: { role: 'user', content }, ...extra })
  fs.writeFileSync(
    old,
    bare('<command-name>/clear</command-name>') +
      bare('<local-command-stdout>Set model to Opus</local-command-stdout>') +
      bare('[Request interrupted by user for tool use]') +
      bare([{ type: 'text', text: '[Image: source: /tmp/shot.png]' }], { isMeta: true }) +
      bare('what does this function do?')
  )
  const index = await readTurnIndex(stateDir)
  const mine = index.turns.filter((t) => t.session.startsWith('bbbb'))
  assert.equal(mine.length, 1, 'only the sentence a person wrote')
  assert.equal(mine[0].prompt, 'what does this function do?')
})

console.log('What a turn did')

await check('a read is recorded from the call that asked for it', async () => {
  fs.appendFileSync(
    file,
    prompt('what is in config.ts?') +
      reply({ tools: [{ name: 'Read', input: { file_path: '/work/alpha/config.ts' } }, { name: 'Read', input: { file_path: '/work/alpha/config.ts' } }] })
  )
  const index = await readTurnIndex(stateDir)
  const turn = index.turns[0]
  assert.deepEqual(turn.read, ['/work/alpha/config.ts'], 'the same file twice is one file')
  assert.equal(turn.tools.Read, 2, 'but two reads')
})

await check('an edit is sized from its patch', async () => {
  fs.appendFileSync(
    file,
    prompt('rename the handler') +
      reply({ tools: [{ name: 'Edit', input: { file_path: '/work/alpha/app.ts' } }] }) +
      result({
        filePath: '/work/alpha/app.ts',
        structuredPatch: [{ lines: [' keep', '-gone', '+new', '+also new'] }],
      })
  )
  const index = await readTurnIndex(stateDir)
  assert.deepEqual(index.turns[0].edited, [{ path: '/work/alpha/app.ts', added: 2, removed: 1 }])
})

await check('a created file counts as written, not as unchanged', async () => {
  // The bug this is here for: a creation carries an *empty* patch — there is
  // nothing to diff a new file against — so a reader that asks about the patch
  // first reports that a file which did not exist a moment ago changed by
  // nothing at all.
  fs.appendFileSync(
    file,
    prompt('write the readme') +
      reply({ tools: [{ name: 'Write', input: { file_path: '/work/alpha/README.md' } }] }) +
      result({ type: 'create', filePath: '/work/alpha/README.md', content: 'one\ntwo\nthree', structuredPatch: [] })
  )
  const index = await readTurnIndex(stateDir)
  assert.deepEqual(index.turns[0].edited, [{ path: '/work/alpha/README.md', added: 3, removed: 0 }])
})

await check('a result that is neither a patch nor a creation changed nothing', async () => {
  fs.appendFileSync(
    file,
    prompt('read it back') + result({ filePath: '/work/alpha/README.md', someOtherShape: true })
  )
  const index = await readTurnIndex(stateDir)
  assert.deepEqual(index.turns[0].edited, [], 'guessing would put files in the list that nothing touched')
})

console.log('Reading the same file again')

await check('appending continues the open turn rather than rebuilding it', async () => {
  const before = await readTurnIndex(stateDir)
  const open = before.turns[0]
  fs.appendFileSync(file, reply({ output: 5 }))
  const after = await readTurnIndex(stateDir)
  assert.equal(after.turns.length, before.turns.length, 'no new turn appeared')
  assert.equal(after.turns[0].totals.output, open.totals.output + 5)
})

await check('a rewritten transcript is counted once, not on top of itself', async () => {
  const rewritten = transcript('cccccccc-1111-2222-3333-444444444444')
  const own = { sessionId: 'cccccccc-1111-2222-3333-444444444444' }
  fs.writeFileSync(rewritten, prompt('first', own) + prompt('second', own) + prompt('third', own))
  const before = await readTurnIndex(stateDir)
  assert.equal(before.turns.filter((t) => t.session.startsWith('cccc')).length, 3)

  // Shorter than what we already read: rewritten, so the offsets we hold
  // describe a file that no longer exists.
  fs.writeFileSync(rewritten, prompt('only one now', own))
  const after = await readTurnIndex(stateDir)
  const mine = after.turns.filter((t) => t.session.startsWith('cccc'))
  assert.equal(mine.length, 1)
  assert.equal(mine[0].prompt, 'only one now')
})

await check('history copied in from a fork is not listed twice', async () => {
  const forked = transcript('dddddddd-1111-2222-3333-444444444444')
  // Forking copies the history, and the copies keep the id they came from.
  fs.writeFileSync(forked, prompt('this belongs to the original') + prompt('so does this'))
  const index = await readTurnIndex(stateDir)
  assert.equal(index.turns.filter((t) => t.session.startsWith('dddd')).length, 0)
})

await check('a deleted transcript stops being listed', async () => {
  const doomed = transcript('eeeeeeee-1111-2222-3333-444444444444')
  fs.writeFileSync(doomed, prompt('temporary', { sessionId: 'eeeeeeee-1111-2222-3333-444444444444' }))
  const before = await readTurnIndex(stateDir)
  assert.equal(before.turns.filter((t) => t.session.startsWith('eeee')).length, 1)
  fs.unlinkSync(doomed)
  const after = await readTurnIndex(stateDir)
  assert.equal(after.turns.filter((t) => t.session.startsWith('eeee')).length, 0)
})

console.log('What the conversation says about itself')

await check('the name and the cost are Claude Code’s own, not ours', async () => {
  fs.appendFileSync(
    file,
    line({ type: 'ai-title', aiTitle: 'Login form work', sessionId: SESSION }) +
      line({ type: 'cost-state', sessionId: SESSION, totalCostUSD: 12.5 })
  )
  const index = await readTurnIndex(stateDir)
  const conversation = index.conversations.find((c) => c.id === SESSION)
  assert.equal(conversation.title, 'Login form work')
  assert.equal(conversation.reportedCost, 12.5)
})

await check('a later name replaces an earlier one', async () => {
  fs.appendFileSync(file, line({ type: 'ai-title', aiTitle: 'Login and signup', sessionId: SESSION }))
  const index = await readTurnIndex(stateDir)
  assert.equal(index.conversations.find((c) => c.id === SESSION).title, 'Login and signup')
})

console.log('The estimate, and where it stops')

await check('a turn on an unpriced model reports no cost rather than zero', async () => {
  const index = await readTurnIndex(stateDir)
  const turn = index.turns.find((t) => t.model === 'claude-opus-5')
  assert.ok(turn, 'a priced turn exists')
  assert.ok(turnCost(turn) !== null, 'and it has a price')
  assert.equal(turnCost({ ...turn, model: 'some-model-nobody-published' }), null)
  assert.equal(turnCost({ ...turn, model: null }), null, 'a turn nothing replied to has no model to price')
})

console.log(`\n${passed} checks passed`)
