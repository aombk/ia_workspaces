// The command history, and the part of it that is easy to get quietly wrong.
//
// The list deduplicates: running a command again removes the old row and puts a
// new one at the front. That was the whole of it while an entry was just a
// string, and it is a trap now that an entry carries a past — a command you run
// every morning must not report having been run once, and the outcome of the
// run that just started must not be inherited from the run before it.
//
// Both of those are invisible from the screen: the number is either right or
// plausibly wrong, which is the failure mode this file exists for.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-history-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { history: 'src/main/history.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const { CommandHistory } = await import(`file://${out}/history.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const CWD = 'C:\\work\\alpha'
const PANE = 'pane-1'

/** A fresh store on its own file, so no test can see another's entries. */
let n = 0
const fresh = () => new CommandHistory(path.join(out, `h${n++}.json`))

const only = (h) => {
  const all = h.recent(50)
  assert.equal(all.length, 1, `expected one entry, found ${all.length}`)
  return all[0]
}

check('a new command is one run and no failures', () => {
  const h = fresh()
  h.add('npm test', CWD, PANE)
  const entry = only(h)
  assert.equal(entry.runs, 1)
  assert.equal(entry.fails, 0)
  assert.equal(entry.lastCode, undefined, 'nothing has finished yet, and that is not success')
})

check('running the same command again counts both, and still one row', () => {
  const h = fresh()
  h.add('npm test', CWD, PANE)
  h.finish(PANE, 0, 1200)
  h.add('npm test', CWD, PANE)
  const entry = only(h)
  assert.equal(entry.runs, 2, 'the count survives the dedup that moves the row')
  assert.equal(entry.lastCode, undefined, 'the new run has not finished; the old code is not its own')
})

check('a failure is counted and remembered', () => {
  const h = fresh()
  h.add('npm run release', CWD, PANE)
  h.finish(PANE, 1, 400)
  const entry = only(h)
  assert.equal(entry.fails, 1)
  assert.equal(entry.lastCode, 1)
  assert.equal(entry.lastMs, 400)
})

check('failures accumulate across runs while success clears the last code', () => {
  const h = fresh()
  h.add('deploy', CWD, PANE)
  h.finish(PANE, 1, 100)
  h.add('deploy', CWD, PANE)
  h.finish(PANE, 1, 100)
  h.add('deploy', CWD, PANE)
  h.finish(PANE, 0, 100)
  const entry = only(h)
  assert.equal(entry.runs, 3)
  assert.equal(entry.fails, 2, 'the two that failed are still on the record')
  assert.equal(entry.lastCode, 0, 'and it worked the last time, which is the other half of the story')
})

check('the outcome lands on the pane that ran it, not on whatever is newest', () => {
  // The list is shared by every pane, so a slow build finishing after two other
  // panes have run something must not stamp its exit code onto one of theirs.
  const h = fresh()
  h.add('slow-build', CWD, 'pane-slow')
  h.add('ls', CWD, 'pane-other')
  h.finish('pane-slow', 2, 90_000)

  const [newest, older] = h.recent(50)
  assert.equal(newest.command, 'ls')
  assert.equal(newest.lastCode, undefined, 'the pane that did not finish is untouched')
  assert.equal(older.command, 'slow-build')
  assert.equal(older.lastCode, 2)
})

check("an entry with no folder is kept, but belongs to no project", () => {
  // Every entry recorded before the folder travelled with the line has an
  // empty `cwd`. They are still worth recalling, and they must not be filed
  // under some project by accident — a blank folder matches nothing, which is
  // what the runbook's own prefix test relies on.
  const h = fresh()
  h.add('mystery', '', PANE)
  const entry = only(h)
  assert.equal(entry.cwd, '')
  assert.equal(entry.command, 'mystery')
})

check('the same command in two folders is two entries', () => {
  const h = fresh()
  h.add('npm test', CWD, PANE)
  h.add('npm test', 'C:\\work\\beta', PANE)
  assert.equal(h.recent(50).length, 2, 'where it ran is part of what identifies it')
})

check('an outcome for a pane with nothing recorded is ignored, not a crash', () => {
  const h = fresh()
  h.finish('pane-nobody', 1, 10)
  assert.equal(h.recent(50).length, 0)
})

check('entries written before the counts existed are read as one clean run', () => {
  const file = path.join(out, 'legacy.json')
  fs.writeFileSync(
    file,
    JSON.stringify([{ command: 'old-command', cwd: CWD, at: Date.now(), paneId: PANE }]),
    'utf8'
  )
  const entry = new CommandHistory(file).recent(50)[0]
  assert.equal(entry.runs, 1)
  assert.equal(entry.fails, 0)
  assert.equal(entry.lastCode, undefined, 'an unknown outcome must never read as success')
})

check('a history file of NUL bytes is recovered, not read as empty', () => {
  // The same power-cut shape as the workspace document. This file holds the run
  // counts and outcomes, which cannot be reconstructed from anything else.
  const file = path.join(out, 'crash.json')
  const h = new CommandHistory(file)
  h.add('npm test', CWD, PANE)
  h.finish(PANE, 0, 100)
  h.flush()
  h.add('npm run release', CWD, PANE)
  h.flush()

  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size))
  const after = new CommandHistory(file).recent(50)
  assert.equal(after.length, 1, 'the previous version survives')
  assert.equal(after[0].command, 'npm test')
})

console.log(`\n${passed} checks passed`)
