// Long-running jobs declared over `iaw job`, and the strip that shows them.
//
// Everything a row says is decided without a window — which jobs are still
// shown, when one has gone stale, whether there is a time left and what it is —
// so it is all checked here, against a clock that moves only when told to.
//
// The rules pinned hardest are the ones that keep the strip honest. No time
// left until there is a rate behind it. No time left once a job goes quiet.
// A quiet job says how long it has been quiet, rather than holding its bar up.
// Each of those looks like something missing from the outside, and each is the
// point.
//
// Bundled with esbuild so the real TypeScript runs, like every other suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-jobs-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { jobs: 'src/shared/jobs.ts', registry: 'src/main/jobs.ts', cli: 'src/main/cli.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})

const J = await import(`file://${out}/jobs.js`)
const { JobRegistry, EMIT_EVERY_MS } = await import(`file://${out}/registry.js`)
const { buildJobReport } = await import(`file://${out}/cli.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A plausible epoch — large enough that ages can be subtracted from it. */
const T0 = 1_700_000_000_000

/** Applies reports in order, each at its own time, and returns the jobs. */
function run(...steps) {
  let jobs = []
  for (const [at, report] of steps) {
    const res = J.applyJobReport(jobs, report, T0 + at)
    assert.ok(!('error' in res), `rejected: ${JSON.stringify(report)} — ${res.error}`)
    jobs = res.jobs
  }
  return jobs
}

const start = (extra = {}) => ({ action: 'start', id: 'r', title: 'render v2 portrait', ...extra })
const upd = (extra) => ({ action: 'update', id: 'r', ...extra })

console.log('state')

await check('start makes a running job with the title it was given', () => {
  const [job] = run([0, start({ total: 500 })])
  assert.equal(job.state, 'running')
  assert.equal(job.title, 'render v2 portrait')
  assert.equal(job.total, 500)
  assert.equal(job.fraction, undefined, 'no progress has been reported yet')
})

await check('--done counts toward --total; --pct stands on its own', () => {
  const [counted] = run([0, start({ total: 500 })], [1000, upd({ done: 125 })])
  assert.equal(counted.fraction, 0.25)
  assert.equal(counted.done, 125)

  const [pct] = run([0, start()], [1000, upd({ pct: 40 })])
  assert.equal(pct.fraction, 0.4)
  assert.equal(pct.done, undefined)
})

await check('a count with no total has no fraction rather than an invented one', () => {
  const [job] = run([0, start()], [1000, upd({ done: 1234 })])
  assert.equal(job.fraction, undefined)
  const row = J.jobRow(job, T0 + 1000)
  assert.equal(row.pct, undefined)
  assert.equal(row.count, '1234')
})

await check('percentages outside 0–100 are clamped, and done never passes total', () => {
  const [over] = run([0, start()], [1000, upd({ pct: 140 })])
  assert.equal(over.fraction, 1)
  const [past] = run([0, start({ total: 10 })], [1000, upd({ done: 12 })])
  assert.equal(past.fraction, 1)
})

await check('done fills the bar, whatever the last update managed to say', () => {
  const [job] = run([0, start({ total: 10 })], [1000, upd({ done: 7 })], [2000, { action: 'done', id: 'r' }])
  assert.equal(job.state, 'done')
  assert.equal(job.fraction, 1)
  assert.equal(job.done, 10)
})

await check('a failure keeps its bar where it stopped, and its reason', () => {
  const [job] = run(
    [0, start({ total: 10 })],
    [1000, upd({ done: 7 })],
    [2000, { action: 'fail', id: 'r', reason: 'ffmpeg exited 1' }]
  )
  assert.equal(job.state, 'failed')
  assert.equal(job.fraction, 0.7)
  const row = J.jobRow(job, T0 + 2000)
  assert.equal(row.state, 'failed')
  assert.equal(row.note, 'ffmpeg exited 1')
})

await check('the next job starting on the pane clears an old failure', () => {
  const jobs = run(
    [0, start()],
    [1000, { action: 'fail', id: 'r', reason: 'x' }],
    [2000, { action: 'start', id: 'other', title: 'upload' }]
  )
  assert.deepEqual(jobs.map((j) => j.id), ['other'])
})

await check('…but leaves a finished-and-fine job to fade on its own clock', () => {
  const jobs = run(
    [0, start()],
    [1000, { action: 'done', id: 'r' }],
    [2000, { action: 'start', id: 'other', title: 'upload' }]
  )
  assert.deepEqual(jobs.map((j) => j.id).sort(), ['other', 'r'])
})

await check('an update for a job nobody started starts it, titled by its id', () => {
  const [job] = run([0, { action: 'update', id: 'loose', pct: 10 }])
  assert.equal(job.title, 'loose')
  assert.equal(job.state, 'running')
})

await check('an update to a finished job is refused rather than reviving it', () => {
  const jobs = run([0, start()], [1000, { action: 'done', id: 'r' }])
  const res = J.applyJobReport(jobs, upd({ pct: 50 }), T0 + 2000)
  assert.match(res.error, /already finished/)
})

await check('starting the same id again begins afresh', () => {
  const jobs = run([0, start()], [5000, upd({ pct: 80 })], [9000, start({ title: 'second pass' })])
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'second pass')
  assert.equal(jobs[0].fraction, undefined)
  assert.equal(jobs[0].startedAt, T0 + 9000)
})

await check('a pane cannot be buried in jobs; finished ones make room first', () => {
  const steps = []
  for (let i = 0; i < J.MAX_JOBS_PER_PANE; i++) steps.push([i, { action: 'start', id: `j${i}`, title: 't' }])
  const full = run(...steps)
  const refused = J.applyJobReport(full, { action: 'start', id: 'extra', title: 't' }, T0 + 100)
  assert.match(refused.error, /already has/)

  const oneDone = J.applyJobReport(full, { action: 'done', id: 'j0' }, T0 + 100).jobs
  const made = J.applyJobReport(oneDone, { action: 'start', id: 'extra', title: 't' }, T0 + 200)
  assert.ok(made.jobs.some((j) => j.id === 'extra'))
  assert.ok(!made.jobs.some((j) => j.id === 'j0'))
})

await check('long text is held to one bounded line', () => {
  const [job] = run([0, start({ title: 'a\nb', detail: 'x'.repeat(500) })])
  assert.equal(job.title, 'a b')
  assert.ok(job.detail.length <= 200)
})

console.log('time left')

await check('nothing until there are two updates', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 1000), null)
})

await check('nothing while two updates are only moments apart', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [1500, upd({ pct: 12 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 1500), null)
})

await check('from the measured rate once there is a few seconds of it', () => {
  // 10% → 30% in 4 s is 5% a second; 70% to go is 14 s.
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [5000, upd({ pct: 30 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 5000), 14_000)
  assert.equal(J.jobRow(jobs[0], T0 + 5000).eta, '~0:14 left')
})

await check('the rate is measured from the first update, not from start', () => {
  // Thirty seconds of setup, then steady work. Counting the setup would make
  // the rate a fifth of what it is.
  const jobs = run([0, start({ total: 100 })], [30_000, upd({ done: 0 })], [35_000, upd({ done: 50 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 35_000), 5_000)
})

await check('it counts down between updates, and stops at zero rather than going negative', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [5000, upd({ pct: 30 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 9000), 10_000)
  assert.equal(J.jobEtaMs(jobs[0], T0 + 25_000), 0)
})

await check('going backwards restarts the measurement rather than giving a negative speed', () => {
  const jobs = run(
    [0, start()],
    [1000, upd({ pct: 10 })],
    [5000, upd({ pct: 90 })],
    [6000, upd({ pct: 5 })]
  )
  assert.equal(jobs[0].samples, 1)
  assert.equal(J.jobEtaMs(jobs[0], T0 + 6000), null)
})

await check('no progress, no estimate', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [5000, upd({ pct: 10 })])
  assert.equal(J.jobEtaMs(jobs[0], T0 + 5000), null)
})

console.log('staleness')

await check('quiet for longer than its TTL, a job says so and drops its estimate', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [5000, upd({ pct: 30 })])
  const at = T0 + 5000 + J.DEFAULT_JOB_TTL_MS + 15_000
  const row = J.jobRow(jobs[0], at)
  assert.equal(row.state, 'stale')
  assert.equal(row.eta, undefined)
  assert.equal(row.note, 'no update for 45 s')
})

await check('a TTL of its own is honoured', () => {
  const jobs = run([0, start({ ttl: 5000 })], [1000, upd({ pct: 10 })])
  assert.equal(J.jobStale(jobs[0], T0 + 5900), false)
  assert.equal(J.jobStale(jobs[0], T0 + 6100), true)
})

await check('an update brings a stale job back', () => {
  const jobs = run([0, start()], [1000, upd({ pct: 10 })], [60_000, upd({ pct: 20 })])
  assert.equal(J.jobRow(jobs[0], T0 + 60_000).state, 'running')
})

await check('finished jobs are never stale', () => {
  const jobs = run([0, start()], [1000, { action: 'done', id: 'r' }])
  assert.equal(J.jobStale(jobs[0], T0 + 9000), false)
})

console.log('what is shown')

await check('done shows for ten seconds, then nothing', () => {
  const jobs = run([0, start()], [1000, { action: 'done', id: 'r' }])
  assert.equal(J.jobRows(jobs, T0 + 1000 + 9_000).length, 1)
  assert.equal(J.jobRows(jobs, T0 + 1000 + 10_000).length, 0)
})

await check('failed shows for two minutes', () => {
  const jobs = run([0, start()], [1000, { action: 'fail', id: 'r' }])
  assert.equal(J.jobRows(jobs, T0 + 1000 + 119_000).length, 1)
  assert.equal(J.jobRows(jobs, T0 + 1000 + 120_000).length, 0)
})

await check('a job silent for half an hour is taken to be gone', () => {
  const jobs = run([0, start()])
  assert.equal(J.jobRows(jobs, T0 + J.ABANDONED_AFTER_MS - 1000).length, 1)
  assert.equal(J.jobRows(jobs, T0 + J.ABANDONED_AFTER_MS).length, 0)
})

await check('a failure is drawn first, then running jobs oldest first, then finished ones', () => {
  const jobs = run(
    [0, { action: 'start', id: 'a', title: 'a' }],
    [1, { action: 'start', id: 'b', title: 'b' }],
    [2, { action: 'start', id: 'c', title: 'c' }],
    [3, { action: 'start', id: 'd', title: 'd' }],
    [4, { action: 'done', id: 'a' }],
    [5, { action: 'fail', id: 'd' }]
  )
  assert.deepEqual(J.jobRows(jobs, T0 + 10).map((r) => r.id), ['d', 'b', 'c', 'a'])
})

await check('elapsed is a clock, and stops when the job does', () => {
  const jobs = run([0, start()], [83_000, { action: 'done', id: 'r' }])
  assert.equal(J.jobRow(jobs[0], T0 + 90_000).elapsed, '1:23')
})

await check('clocks and silences read the way a person would say them', () => {
  assert.equal(J.formatClock(0), '0:00')
  assert.equal(J.formatClock(80_000), '1:20')
  assert.equal(J.formatClock(3_723_000), '1:02:03')
  assert.equal(J.formatSilence(45_000), '45 s')
  assert.equal(J.formatSilence(180_000), '3 min')
  assert.equal(J.formatSilence(3 * 3_600_000), '3 h')
})

console.log('registry')

await check('updates are coalesced; start, done and fail go out at once', async () => {
  let now = T0
  const sent = []
  const reg = new JobRegistry((paneId, jobs) => sent.push(jobs.map((j) => j.fraction)), () => now)

  assert.equal(reg.report('p', start()), null)
  assert.equal(sent.length, 1, 'start is sent immediately')

  // A burst of updates inside one window: the first goes, the rest fold into
  // one trailing message carrying the latest.
  now += EMIT_EVERY_MS
  reg.report('p', upd({ pct: 10 }))
  assert.equal(sent.length, 2)
  for (const pct of [11, 12, 13, 14]) {
    now += 10
    reg.report('p', upd({ pct }))
  }
  assert.equal(sent.length, 2, 'the burst is held')
  await sleep(EMIT_EVERY_MS + 50)
  assert.equal(sent.length, 3, 'and then sent once')
  assert.deepEqual(sent[2], [0.14])

  now += 10
  reg.report('p', { action: 'fail', id: 'r', reason: 'x' })
  assert.equal(sent.length, 4, 'a failure does not wait its turn')
})

await check('an error comes back to the caller and changes nothing', () => {
  const reg = new JobRegistry(() => {}, () => T0)
  reg.report('p', start())
  reg.report('p', { action: 'done', id: 'r' })
  assert.match(reg.report('p', upd({ pct: 5 })), /already finished/)
  assert.equal(reg.snapshot('p')[0].state, 'done')
})

await check('prune drops what has expired and says so', () => {
  let now = T0
  const sent = []
  const reg = new JobRegistry((paneId, jobs) => sent.push(jobs.length), () => now)
  reg.report('p', start())
  reg.report('p', { action: 'done', id: 'r' })
  now += J.DONE_LINGER_MS + 1
  reg.prune('p')
  assert.deepEqual(reg.snapshot('p'), [])
  assert.equal(sent.at(-1), 0)
})

await check('releasing a pane drops its jobs and announces the empty list', () => {
  const sent = []
  const reg = new JobRegistry((paneId, jobs) => sent.push([paneId, jobs.length]), () => T0)
  reg.report('p', start())
  reg.release('p')
  assert.deepEqual(sent.at(-1), ['p', 0])
  assert.deepEqual(reg.snapshot('p'), [])
})

console.log('command line')

await check('start takes a title, a total and a TTL in seconds', () => {
  const res = buildJobReport({ _: 'start', id: 'r', title: 'render', total: '500', ttl: '45' })
  assert.deepEqual(res.value, { action: 'start', id: 'r', title: 'render', total: 500, ttl: 45_000 })
})

await check('update needs --done or --pct', () => {
  assert.match(buildJobReport({ _: 'update', id: 'r' }).error, /--done N or --pct P/)
  assert.deepEqual(buildJobReport({ _: 'update', id: 'r', done: '3', detail: 'frame 3' }).value, {
    action: 'update',
    id: 'r',
    done: 3,
    detail: 'frame 3',
  })
})

await check('fail carries its reason', () => {
  assert.deepEqual(buildJobReport({ _: 'fail', id: 'r', reason: 'disk full' }).value, {
    action: 'fail',
    id: 'r',
    reason: 'disk full',
  })
})

await check('mistakes are refused on the line that made them', () => {
  assert.match(buildJobReport({ _: 'stop', id: 'r' }).error, /start, update, done or fail/)
  assert.match(buildJobReport({ _: 'start' }).error, /needs --id/)
  assert.match(buildJobReport({ _: 'start', id: 'true' }).error, /needs --id/)
  assert.match(buildJobReport({ _: 'start', id: 'r', total: '0' }).error, /--total/)
  assert.match(buildJobReport({ _: 'update', id: 'r', pct: 'lots' }).error, /--pct/)
  assert.match(buildJobReport({ _: 'update', id: 'r', done: '-1' }).error, /--done/)
  assert.match(buildJobReport({ _: 'start', id: 'r', ttl: 'soon' }).error, /--ttl/)
})

console.log(`\n${passed} checks passed`)
