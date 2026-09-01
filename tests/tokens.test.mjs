// The per-project token counter, against transcripts we wrote ourselves.
//
// Everything here is about a claim that cannot be checked by looking at the
// screen: a number is either right or plausibly wrong, and plausibly wrong is
// the failure mode this feature has. So the fixtures carry numbers chosen to
// make each rule visible on its own — a foreign session id, an appended line, a
// cache write in each of the two windows.
//
// Runs against a throwaway HOME so the real ~/.claude is never read.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-tokens-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const outfile = path.join(sandbox, 'tokenUsage.mjs')
await build({
  entryPoints: ['src/main/tokenUsage.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

const { readTokenUsage, totalOf } = await import(`file://${outfile}`)

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

/** One assistant turn, in the shape Claude Code writes it. */
function turn({ session = SESSION, model = 'claude-opus-5', input = 0, output = 0, read = 0, write5m = 0, write1h = 0, cwd = CWD, id = undefined } = {}) {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: session,
    cwd,
    timestamp: new Date().toISOString(),
    message: {
      ...(id ? { id } : {}),
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write5m + write1h,
        cache_creation: {
          ephemeral_5m_input_tokens: write5m,
          ephemeral_1h_input_tokens: write1h,
        },
      },
    },
  })}\n`
}

/** A line that is not an assistant turn, which must not be counted. */
function userTurn() {
  return `${JSON.stringify({ type: 'user', sessionId: SESSION, cwd: CWD, message: { role: 'user', content: 'hello' } })}\n`
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}

// A machine where Claude Code has never run reports "none" — which is a
// different answer from zero, and must not be dressed up as one.
await check('no transcripts at all reports none, not zero', async () => {
  const report = await readTokenUsage(stateDir)
  assert.equal(report.status, 'none')
  assert.deepEqual(report.projects, [])
})

const file = transcript(SESSION)

await check('counts every class of token, and only assistant turns', async () => {
  fs.writeFileSync(
    file,
    userTurn() +
      turn({ input: 10, output: 20, read: 30, write5m: 40, write1h: 50 }) +
      userTurn() +
      turn({ input: 1, output: 2, read: 3, write5m: 4, write1h: 5 })
  )
  const report = await readTokenUsage(stateDir)
  assert.equal(report.status, 'ok')
  assert.equal(report.projects.length, 1)
  const p = report.projects[0]
  // The real path from the line, not the mangled folder name it lives in.
  assert.equal(p.cwd, CWD)
  assert.equal(p.totals.input, 11)
  assert.equal(p.totals.output, 22)
  assert.equal(p.totals.cacheRead, 33)
  assert.equal(p.totals.cacheWrite5m, 44)
  assert.equal(p.totals.cacheWrite1h, 55)
  // Two assistant turns, not four lines.
  assert.equal(p.totals.messages, 2)
  assert.equal(totalOf(p.totals), 165)
})

await check('appending is counted once, not counted again', async () => {
  fs.appendFileSync(file, turn({ input: 100, output: 200 }))
  const report = await readTokenUsage(stateDir)
  const p = report.projects[0]
  // The first two turns are remembered rather than re-read; only the new one
  // is added. Re-reading would double everything above.
  assert.equal(p.totals.input, 111)
  assert.equal(p.totals.output, 222)
  assert.equal(p.totals.messages, 3)
})

await check('a half-written last line is not counted until it is finished', async () => {
  const partial = JSON.stringify({ type: 'assistant', sessionId: SESSION, cwd: CWD, message: { model: 'claude-opus-5', usage: { output_tokens: 7 } } })
  // No trailing newline: the writer is mid-flush.
  fs.appendFileSync(file, partial.slice(0, partial.length - 10))
  const during = await readTokenUsage(stateDir)
  assert.equal(during.projects[0].totals.messages, 3, 'an unfinished line must not be counted')

  fs.appendFileSync(file, `${partial.slice(partial.length - 10)}\n`)
  const after = await readTokenUsage(stateDir)
  assert.equal(after.projects[0].totals.messages, 4, 'and must be counted once it is')
  assert.equal(after.projects[0].totals.output, 229)
})

await check('one reply is counted once, however many blocks it was written as', async () => {
  // The bug this exists for, and it was not a rounding error: Claude Code
  // writes **one line per content block** — the thinking, the text, each tool
  // call — and stamps every one with the same `message.id` and the same
  // whole-reply `usage`. Summing the rows counted a reply once per block, which
  // measured on a real machine was output over-reported by 54% and cache reads
  // by 40%: a headline figure roughly double the truth, and published to other
  // machines as well as shown.
  // Its own folder, so these fixtures cannot disturb the totals the checks
  // above and below assert on — every transcript here shares one state dir.
  const here = 'C:\\work\\dedup'
  const session = '99999999-1111-2222-3333-444444444444'
  const file = transcript(session)
  const id = 'msg_01BlocksOfOneReply'
  const block = (extra) => turn({ session, cwd: here, id, output: 100, read: 500, ...extra })
  fs.writeFileSync(file, block() + block() + block())

  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === here)
  assert.equal(p.totals.output, 100, 'three blocks of one reply are one reply')
  assert.equal(p.totals.cacheRead, 500)
  assert.equal(p.totals.messages, 1)

  // A different id is a different reply, and counts.
  fs.appendFileSync(file, turn({ session, cwd: here, id: 'msg_01Second', output: 7 }))
  const after = await readTokenUsage(stateDir)
  const q = after.projects.find((x) => x.cwd === here)
  assert.equal(q.totals.output, 107)
  assert.equal(q.totals.messages, 2)
})

await check('a reply whose blocks straddle two scans is still counted once', async () => {
  // The reader is incremental, so the guard has to survive between runs: a
  // reply's blocks can land either side of the point where one scan stopped.
  const here = 'C:\\work\\straddle'
  const session = '88888888-1111-2222-3333-444444444444'
  const file = transcript(session)
  const id = 'msg_01Straddles'
  fs.writeFileSync(file, turn({ session, cwd: here, id, output: 50 }))
  const first = await readTokenUsage(stateDir)
  assert.equal(first.projects.find((x) => x.cwd === here).totals.output, 50)

  fs.appendFileSync(file, turn({ session, cwd: here, id, output: 50 }))
  const second = await readTokenUsage(stateDir)
  assert.equal(
    second.projects.find((x) => x.cwd === here).totals.output,
    50,
    'the second block of a reply already counted must add nothing'
  )
})

await check('history copied in from a forked session is not counted twice', async () => {
  const forked = transcript('bbbbbbbb-1111-2222-3333-444444444444')
  fs.writeFileSync(
    forked,
    // The copied history keeps the id of the conversation it came from...
    turn({ session: SESSION, input: 999, output: 999 }) +
      // ...and only the fork's own turns are this file's own.
      turn({ session: 'bbbbbbbb-1111-2222-3333-444444444444', input: 5, output: 6 })
  )
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === CWD)
  assert.equal(p.totals.input, 116, 'the copied 999 must not be counted')
  assert.equal(p.totals.output, 235)
})

await check('a line with no session id at all is still counted', async () => {
  // A format that stops writing the field must degrade to counting everything,
  // never to reporting a plausible zero.
  const orphan = transcript('cccccccc-1111-2222-3333-444444444444')
  const line = JSON.parse(turn({ input: 3, output: 4 }))
  delete line.sessionId
  fs.writeFileSync(orphan, `${JSON.stringify(line)}\n`)
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === CWD)
  assert.equal(p.totals.input, 119)
})

await check('cost is split into the five columns Anthropic publishes', async () => {
  const dir = path.join(sandbox, '.claude', 'projects', 'C--work-split')
  fs.mkdirSync(dir, { recursive: true })
  const id = 'ffffffff-1111-2222-3333-444444444444'
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    turn({
      session: id,
      cwd: 'C:\\work\\split',
      input: 1_000_000,
      output: 1_000_000,
      read: 1_000_000,
      write5m: 1_000_000,
      write1h: 1_000_000,
    })
  )
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === 'C:\\work\\split')
  // A round million of each class makes every figure the published rate itself,
  // so these five assertions are the price table read back.
  assert.equal(p.costs.input, 5, 'base input is $5/Mtok')
  assert.equal(p.costs.cacheWrite5m, 6.25, 'a 5m cache write is 1.25x that')
  assert.equal(p.costs.cacheWrite1h, 10, 'and an hour is 2x')
  assert.equal(p.costs.cacheRead, 0.5, 'a cache hit is a tenth')
  assert.equal(p.costs.output, 25, 'output is $25/Mtok')
  // The five must add up to the one figure shown beneath them, or the table
  // visibly does not balance.
  const sum =
    p.costs.input + p.costs.cacheWrite5m + p.costs.cacheWrite1h + p.costs.cacheRead + p.costs.output
  assert.ok(Math.abs(p.cost - sum) < 1e-9, `total ${p.cost} should equal the sum ${sum}`)
})

await check('a dated model id is priced as the model it is', async () => {
  // Transcripts from older builds name a snapshot — `claude-sonnet-4-5-20250929`
  // — and refusing to price it would report a model the user recognises as
  // unpriced. Longest prefix wins, so `claude-opus-4-1` is never served by a
  // shorter `claude-opus-4` at a different price.
  const dir = path.join(sandbox, '.claude', 'projects', 'C--work-dated')
  fs.mkdirSync(dir, { recursive: true })
  const id = 'a1a1a1a1-1111-2222-3333-444444444444'
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    turn({ session: id, cwd: 'C:\\work\\dated', model: 'claude-sonnet-4-5-20250929', output: 1_000_000 })
  )
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === 'C:\\work\\dated')
  assert.deepEqual(p.unpricedModels, [], 'a dated snapshot is not an unknown model')
  assert.equal(p.costs.output, 15, 'Sonnet 4.5 output is $15/Mtok')
})

await check('cost applies the cache multipliers, per model', async () => {
  const priced = path.join(sandbox, '.claude', 'projects', 'C--work-beta')
  fs.mkdirSync(priced, { recursive: true })
  const id = 'dddddddd-1111-2222-3333-444444444444'
  fs.writeFileSync(
    path.join(priced, `${id}.jsonl`),
    turn({ session: id, cwd: 'C:\\work\\beta', input: 1000, output: 1000, read: 1000, write5m: 1000, write1h: 1000 })
  )
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === 'C:\\work\\beta')
  // Opus 5 is $5 in / $25 out per million. A cache read is a tenth of input, a
  // five-minute write 1.25x and an hour's write 2x:
  //   (1000 + 100 + 1250 + 2000) * $5 + 1000 * $25, per million.
  const expected = ((1000 + 1000 * 0.1 + 1000 * 1.25 + 1000 * 2) * 5 + 1000 * 25) / 1_000_000
  assert.ok(Math.abs(p.cost - expected) < 1e-9, `cost ${p.cost} should be ${expected}`)
  assert.deepEqual(p.unpricedModels, [])
})

await check('an unknown model contributes tokens but is named, not priced', async () => {
  const dir = path.join(sandbox, '.claude', 'projects', 'C--work-gamma')
  fs.mkdirSync(dir, { recursive: true })
  const id = 'eeeeeeee-1111-2222-3333-444444444444'
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    turn({ session: id, cwd: 'C:\\work\\gamma', model: 'claude-from-the-future', input: 1000, output: 1000 })
  )
  const report = await readTokenUsage(stateDir)
  const p = report.projects.find((x) => x.cwd === 'C:\\work\\gamma')
  assert.equal(totalOf(p.totals), 2000, 'its tokens still count')
  assert.equal(p.cost, 0, 'but they are not priced at a guess')
  assert.deepEqual(p.unpricedModels, ['claude-from-the-future'], 'and it is named so the panel can say so')
})

await check('a deleted transcript stops being counted', async () => {
  fs.rmSync(path.join(sandbox, '.claude', 'projects', 'C--work-gamma'), { recursive: true, force: true })
  const report = await readTokenUsage(stateDir)
  assert.equal(
    report.projects.find((x) => x.cwd === 'C:\\work\\gamma'),
    undefined
  )
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
