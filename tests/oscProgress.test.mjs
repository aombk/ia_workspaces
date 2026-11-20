// Terminal progress reports — OSC 9;4 — and the job they become on the pane.
//
// Three layers, each checked on its own. The parser, strictly: `OSC 9` is
// shared by a dozen ConEmu subcommands and by iTerm2's notifications, and a
// progress bar appearing because somebody's notification began "4;" would be
// the scanner inventing a job. The mapping: which report does what to the
// `osc` job, and in particular that only a bar the program itself filled is
// ever called done. And the gate that keeps a program redrawing its bar a
// hundred times a second from touching the job a hundred times a second.
//
// Bundled with esbuild so the real TypeScript runs, like every other suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-osc-progress-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { progress: 'src/main/oscProgress.ts', scanner: 'src/main/oscScanner.ts', jobs: 'src/shared/jobs.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})

const P = await import(`file://${out}/progress.js`)
const { OscScanner } = await import(`file://${out}/scanner.js`)
const J = await import(`file://${out}/jobs.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

/** A scanner whose events are written down, in order. */
function scanner() {
  const seen = []
  const s = new OscScanner({
    onBell: () => seen.push(['bell']),
    onTitle: (t) => seen.push(['title', t]),
    onCwd: (c) => seen.push(['cwd', c]),
    onNotify: (t, b) => seen.push(['notify', t, b]),
    onProgress: (p) => seen.push(['progress', p]),
    onPromptStart: () => {},
    onCommandStart: () => {},
    onCommandEnd: () => {},
    onCommandLine: () => {},
  })
  return { s, seen }
}

console.log('parsing')

await check('the five states, with and without a percentage', () => {
  assert.deepEqual(P.parseOscProgress('4;1;42'), { state: 1, pct: 42 })
  assert.deepEqual(P.parseOscProgress('4;0'), { state: 0 })
  assert.deepEqual(P.parseOscProgress('4;0;0'), { state: 0, pct: 0 })
  assert.deepEqual(P.parseOscProgress('4;0;'), { state: 0 }, 'a stray separator reads the same')
  assert.deepEqual(P.parseOscProgress('4;2'), { state: 2 })
  assert.deepEqual(P.parseOscProgress('4;2;80'), { state: 2, pct: 80 })
  assert.deepEqual(P.parseOscProgress('4;3;0'), { state: 3, pct: 0 })
  assert.deepEqual(P.parseOscProgress('4;4;55'), { state: 4, pct: 55 })
  assert.deepEqual(P.parseOscProgress('4;1;250'), { state: 1, pct: 100 }, 'over 100 is held at 100')
})

await check('anything less exact is not a progress report', () => {
  for (const bad of ['4', '4;', '4;5;10', '4;1;abc', '4;1;-5', '4;1;12.5', '4;1;1000', '4;1;50;x', '4;;50', '4; 1;50', '41;1;50']) {
    assert.equal(P.parseOscProgress(bad), null, bad)
  }
})

await check('the scanner sends 9;4 to progress, across split reads and either terminator', () => {
  const { s, seen } = scanner()
  s.push('before\x1b]9;4;1;')
  s.push('37\x07after\x1b]9;4;3;0\x1b\\')
  assert.deepEqual(seen, [
    ['progress', { state: 1, pct: 37 }],
    ['progress', { state: 3, pct: 0 }],
  ])
})

await check("ConEmu's other 9;n and iTerm2's notifications are not mistaken for progress", () => {
  const { s, seen } = scanner()
  s.push('\x1b]9;9;"/tmp/x"\x07') // cwd
  s.push('\x1b]9;4 tasks finished\x07') // a notification that happens to start with 4
  s.push('\x1b]9;4;9;10\x07') // 9;4 that is not one we can read: dropped, as before
  s.push('\x1b]9;1;500\x07') // ConEmu sleep — already a notification before this change
  assert.deepEqual(seen, [
    ['cwd', '/tmp/x'],
    ['notify', 'Terminal', '4 tasks finished'],
    ['notify', 'Terminal', '1;500'],
  ])
})

console.log('mapping onto the pane job')

const T0 = 1_700_000_000_000
/** Feeds progress reports through the mapping into a job list, as the pty manager does. */
function drive(steps, title = 'cargo build') {
  let jobs = []
  for (const [at, progress] of steps) {
    const current = jobs.find((j) => j.id === P.OSC_JOB_ID)
    for (const report of P.oscProgressReports(current, progress, title)) {
      const res = J.applyJobReport(jobs, report, T0 + at)
      assert.ok(!('error' in res), `rejected: ${JSON.stringify(report)} — ${res.error}`)
      jobs = res.jobs
    }
  }
  return jobs
}
const osc = (jobs) => jobs.find((j) => j.id === P.OSC_JOB_ID)

await check('the first report starts a job named for the command; later ones update it', () => {
  const jobs = drive([
    [0, { state: 1, pct: 10 }],
    [1000, { state: 1, pct: 20 }],
  ])
  assert.equal(jobs.length, 1)
  assert.equal(osc(jobs).title, 'cargo build')
  assert.equal(osc(jobs).fraction, 0.2)
  assert.equal(osc(jobs).startedAt, T0)
})

await check('0 removes the bar without a verdict, unless it had reached 100%', () => {
  assert.deepEqual(drive([[0, { state: 1, pct: 60 }], [1000, { state: 0 }]]), [])
  const full = drive([[0, { state: 1, pct: 99 }], [500, { state: 1, pct: 100 }], [1000, { state: 0 }]])
  assert.equal(osc(full).state, 'done')
  assert.deepEqual(drive([[0, { state: 0 }]]), [], 'clearing nothing makes nothing')
})

await check('2 is an error while running; cleared while still in error, it is a failure', () => {
  const erring = drive([[0, { state: 1, pct: 30 }], [1000, { state: 2 }]])
  assert.equal(osc(erring).state, 'running')
  assert.equal(osc(erring).phase, 'error')
  assert.equal(osc(erring).fraction, 0.3, 'no percentage keeps the last one')
  const recovered = drive([[0, { state: 2, pct: 30 }], [1000, { state: 1, pct: 40 }], [2000, { state: 0 }]])
  assert.deepEqual(recovered, [], 'recovered and cleared short of 100%: just gone')
  const failed = drive([[0, { state: 1, pct: 30 }], [1000, { state: 2 }], [2000, { state: 0 }]])
  assert.equal(osc(failed).state, 'failed')
  assert.match(osc(failed).reason, /reported an error/)
})

await check('3 is indeterminate: no fraction, whatever pr says', () => {
  const jobs = drive([[0, { state: 1, pct: 40 }], [1000, { state: 3, pct: 0 }]])
  assert.equal(osc(jobs).phase, 'indeterminate')
  assert.equal(osc(jobs).fraction, undefined)
  assert.equal(J.jobRow(osc(jobs), T0 + 1000).indeterminate, true)
})

await check('4 is paused, keeping its place', () => {
  const jobs = drive([[0, { state: 1, pct: 40 }], [1000, { state: 4 }]])
  assert.equal(J.jobRow(osc(jobs), T0 + 1000).state, 'paused')
  assert.equal(osc(jobs).fraction, 0.4)
})

await check('a bar set again after finishing is a new job, not a refused update', () => {
  const jobs = drive([
    [0, { state: 1, pct: 100 }],
    [500, { state: 0 }],
    [1000, { state: 1, pct: 5 }],
  ])
  assert.equal(osc(jobs).state, 'running')
  assert.equal(osc(jobs).startedAt, T0 + 1000)
})

await check('the command ending ends the bar as clearing it would have', () => {
  const at = (job) => P.endReport(job).action
  const [running] = drive([[0, { state: 1, pct: 50 }]])
  assert.equal(at(running), 'clear')
  assert.equal(at(drive([[0, { state: 1, pct: 100 }]])[0]), 'done')
  assert.equal(at(drive([[0, { state: 2, pct: 50 }]])[0]), 'fail')
  assert.equal(at(drive([[0, { state: 3 }]])[0]), 'clear')
})

console.log('throttling')

await check('a burst in one state is held to one report per interval, and the last one lands', () => {
  let now = 0
  const sent = []
  const gate = new P.OscProgressGate((p) => sent.push(p), () => now)
  for (let pct = 1; pct <= 50; pct++) {
    gate.push({ state: 1, pct })
    now += 2 // fifty reports in a tenth of a second
  }
  assert.deepEqual(sent, [{ state: 1, pct: 1 }], 'the first goes at once')
  gate.flush()
  assert.deepEqual(sent.at(-1), { state: 1, pct: 50 }, 'the trailing edge carries the latest')
  assert.equal(sent.length, 2)
  gate.reset()
})

await check('a change of state is never held back', () => {
  let now = 0
  const sent = []
  const gate = new P.OscProgressGate((p) => sent.push(p), () => now)
  gate.push({ state: 1, pct: 10 })
  now += 1
  gate.push({ state: 1, pct: 11 }) // held
  now += 1
  gate.push({ state: 2 }) // news: goes now, and replaces what was held
  now += 1
  gate.push({ state: 0 })
  assert.deepEqual(sent, [{ state: 1, pct: 10 }, { state: 2 }, { state: 0 }])
  gate.flush()
  assert.equal(sent.length, 3, 'the held 11% was superseded, not sent late')
})

await check('after the interval, the next report goes straight through', () => {
  let now = 0
  const sent = []
  const gate = new P.OscProgressGate((p) => sent.push(p), () => now)
  gate.push({ state: 1, pct: 10 })
  now += P.OSC_PROGRESS_EVERY_MS
  gate.push({ state: 1, pct: 20 })
  assert.equal(sent.length, 2)
})

console.log(`\n${passed} checks passed`)
