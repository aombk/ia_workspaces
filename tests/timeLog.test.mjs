// Time recorded by watching, rather than by being told.
//
// The whole value of this over a tracker with a start button is that it is
// right without anybody remembering anything — which means the edges have to be
// right, and the edges are all about *not* recording. A laptop closed at six
// must not log until nine the next morning. Clicking through four workspaces
// must not produce four sessions. Losing focus must stop the clock.
//
// Every one of those is a case where the honest answer is a smaller number, and
// a tracker that rounds its own numbers up is a tracker nobody believes twice.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-time-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { time: 'src/main/timeLog.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const { TimeLog, HEARTBEAT_MS } = await import(`file://${out}/time.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const A = 'C:\\work\\alpha'
const B = 'C:\\work\\beta'
const MIN = 60_000

let n = 0
const fresh = () => new TimeLog(path.join(out, `t${n++}.json`))

/** Beats every `HEARTBEAT_MS` from `at`, for `minutes`. Returns the final clock. */
function work(log, cwd, name, at, minutes) {
  const until = at + minutes * MIN
  for (let t = at; t <= until; t += HEARTBEAT_MS) log.beat(cwd, name, t)
  return until
}

const total = (log, at) =>
  log.all(at).reduce((sum, s) => sum + (s.end - s.start), 0)

check('a stretch of work is recorded without being started', () => {
  const log = fresh()
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  const end = work(log, A, 'alpha', t0, 30)
  log.close(end)

  const spans = log.all(end)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].cwd, A)
  assert.ok(Math.abs(spans[0].end - spans[0].start - 30 * MIN) < HEARTBEAT_MS)
})

check('losing focus stops the clock', () => {
  const log = fresh()
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  const end = work(log, A, 'alpha', t0, 10)
  // An empty folder is "nothing is being worked on" — the same call, so no
  // caller has to remember a second one.
  log.beat('', '', end)

  const after = end + 4 * 60 * MIN
  log.beat('', '', after)
  assert.ok(
    Math.abs(total(log, after) - 10 * MIN) < HEARTBEAT_MS,
    'four hours away from the window are four hours nobody worked'
  )
})

check('a lid closed at six does not record until nine the next morning', () => {
  // The case that matters most, and the one a naive implementation gets
  // catastrophically wrong: heartbeats simply stop, and the next one arrives
  // fifteen hours later.
  const log = fresh()
  const evening = Date.UTC(2026, 7, 22, 17, 30, 0)
  const end = work(log, A, 'alpha', evening, 20)

  const morning = Date.UTC(2026, 7, 23, 9, 0, 0)
  // Long enough to count as a session at all — a couple of beats would be
  // fifteen seconds, which is correctly beneath the floor.
  const later = work(log, A, 'alpha', morning, 5)

  const spans = log.all(later)
  assert.equal(spans.length, 2, 'two sessions, not one enormous one')
  const longest = Math.max(...spans.map((s) => s.end - s.start))
  assert.ok(longest < 25 * MIN, `the evening session stayed itself, got ${longest / MIN}m`)
  assert.ok(spans[0].end <= end + HEARTBEAT_MS * 3, 'it ended when it was last heard from')
  assert.ok(
    spans[1].start >= morning,
    'and the morning session began in the morning, not overnight'
  )
})

check('switching project ends one stretch and starts another', () => {
  const log = fresh()
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  const mid = work(log, A, 'alpha', t0, 20)
  const end = work(log, B, 'beta', mid + HEARTBEAT_MS, 10)
  log.close(end)

  const spans = log.all(end)
  assert.equal(spans.length, 2)
  assert.deepEqual(
    spans.map((s) => s.cwd),
    [A, B]
  )
})

check('clicking through workspaces is not four sessions of work', () => {
  const log = fresh()
  let t = Date.UTC(2026, 7, 22, 9, 0, 0)
  for (const cwd of [A, B, A, B]) {
    log.beat(cwd, 'x', t)
    t += 3000 // three seconds on each
  }
  log.close(t)
  assert.equal(log.all(t).length, 0, 'nothing under half a minute is a session')
})

check('the running stretch is included, or the pane looks frozen', () => {
  const log = fresh()
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  const now = work(log, A, 'alpha', t0, 5)
  assert.equal(log.all(now).length, 1, 'today\u2019s total must include what is happening now')
})

check('a renamed project keeps one session under its newest name', () => {
  const log = fresh()
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  let t = t0
  for (; t <= t0 + 5 * MIN; t += HEARTBEAT_MS) log.beat(A, 'old name', t)
  for (; t <= t0 + 10 * MIN; t += HEARTBEAT_MS) log.beat(A, 'new name', t)
  log.close(t)

  const spans = log.all(t)
  assert.equal(spans.length, 1, 'a rename is not a new project')
  assert.equal(spans[0].name, 'new name')
})

check('the log survives a restart', () => {
  const file = path.join(out, 'restart.json')
  const log = new TimeLog(file)
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  const end = work(log, A, 'alpha', t0, 40)
  log.close(end)
  log.flush()

  const after = new TimeLog(file).all(end)
  assert.equal(after.length, 1)
  assert.ok(Math.abs(after[0].end - after[0].start - 40 * MIN) < HEARTBEAT_MS)
})

check('a log of NUL bytes is recovered from the backup', () => {
  const file = path.join(out, 'crash.json')
  const log = new TimeLog(file)
  const t0 = Date.UTC(2026, 7, 22, 9, 0, 0)
  let end = work(log, A, 'alpha', t0, 40)
  log.close(end)
  log.flush()

  const log2 = new TimeLog(file)
  end = work(log2, B, 'beta', end + MIN, 15)
  log2.close(end)
  log2.flush()

  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size))
  assert.equal(new TimeLog(file).all(end).length, 1, 'the previous version survives')
})

console.log(`\n${passed} checks passed`)
