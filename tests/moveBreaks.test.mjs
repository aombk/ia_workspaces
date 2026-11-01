// Movement breaks: when you count as sitting, when a break is owed, and what
// gets you out of one. All of it is `BreakClock`, a state machine over the
// clock and the system's idle time, so every case here is a few numbers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-breaks-'))
await build({
  entryPoints: { breaks: 'src/shared/moveBreaks.ts', exercises: 'src/shared/exercises.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})
const B = await import(`file://${out}/breaks.js`)
const E = await import(`file://${out}/exercises.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const MIN = 60_000
const on = { enabled: true, everyMin: 25, breakMin: 5, equipment: [], avoid: [] }
const clock = () => new B.BreakClock((posture, n) => E.pickRoutine(posture, n), () => 'id')

/** Sits at the machine — input every few seconds — from `from` for `minutes`. */
function sit(c, from, minutes, settings = on) {
  let raised = false
  for (let t = from; t <= from + minutes * MIN; t += 10_000) raised = c.tick(t, 3, settings).raised || raised
  return raised
}

console.log('When a break is owed')

check('25 minutes at the machine raises one', () => {
  const c = clock()
  assert.equal(sit(c, 0, 24), false)
  assert.equal(sit(c, 24 * MIN, 2), true)
  assert.ok(c.state().due)
})

check('it is not raised while nobody is at the machine', () => {
  const c = clock()
  sit(c, 0, 24.9)
  // Owed now, but the last input was two minutes ago.
  assert.equal(c.tick(25.5 * MIN, 120, on).raised, false)
  assert.equal(c.state().due, null)
  // Back at the keyboard: now it is.
  assert.equal(c.tick(26 * MIN, 1, on).raised, true)
})

check('being away as long as a break starts the count again', () => {
  const c = clock()
  sit(c, 0, 20)
  c.tick(26 * MIN, 6 * 60, on)
  assert.equal(c.state().sittingSince, null)
  assert.equal(sit(c, 27 * MIN, 20), false)
})

check('locking the machine starts the count again', () => {
  const c = clock()
  sit(c, 0, 20)
  c.away()
  assert.equal(sit(c, 20 * MIN, 20), false)
})

check('switched off, nothing is counted or raised', () => {
  const c = clock()
  assert.equal(sit(c, 0, 60, { ...on, enabled: false }), false)
  assert.equal(c.state().sittingSince, null)
})

check('settings from the document are kept within sense', () => {
  assert.deepEqual(B.readBreakSettings({}), { enabled: true, everyMin: 25, breakMin: 5, equipment: [], avoid: [] })
  assert.deepEqual(B.readBreakSettings({ moveBreaks: false, moveEveryMin: 0, moveBreakMin: 99, moveEquipment: ['band', 3], moveAvoid: 'knees' }), {
    enabled: false,
    everyMin: 5,
    breakMin: 30,
    equipment: ['band'],
    avoid: [],
  })
})

console.log('Getting out of one')

const due = () => {
  const c = clock()
  sit(c, 0, 25.5)
  return { c, at: 26 * MIN }
}

check('done is refused before the countdown has run', () => {
  const { c, at } = due()
  c.choose(at, 'standing')
  assert.equal(c.finish(at + 2 * MIN, 'done'), null)
  assert.ok(c.state().due)
  const record = c.finish(at + 5 * MIN, 'done')
  assert.equal(record.outcome, 'done')
  assert.equal(c.state().due, null)
  assert.equal(c.state().sittingSince, at + 5 * MIN)
})

check('done is refused without a posture chosen at all', () => {
  const { c, at } = due()
  assert.equal(c.finish(at + 10 * MIN, 'done'), null)
})

check('skipping is allowed at any time', () => {
  const { c, at } = due()
  assert.equal(c.finish(at, 'skipped').outcome, 'skipped')
})

check('walking away from the screen ends it as a break', () => {
  const { c, at } = due()
  const result = c.tick(at + 5 * MIN, 5 * 60, on)
  assert.equal(result.ended.outcome, 'away')
  assert.equal(c.state().due, null)
})

check('"not now" works once, then comes back five minutes later without it', () => {
  const { c, at } = due()
  assert.equal(c.snooze(at), true)
  assert.equal(c.state().due, null)
  assert.equal(c.tick(at + 4 * MIN, 2, on).raised, false)
  assert.equal(c.tick(at + 5 * MIN, 2, on).raised, true)
  assert.equal(c.state().due.snoozed, true)
  assert.equal(c.snooze(at + 5 * MIN), false)
})

console.log('The exercises')

check('a break has one exercise a minute and ends with a walk or with eyes', () => {
  const standing = E.pickRoutine('standing', 5)
  assert.equal(standing.length, 5)
  assert.equal(standing.at(-1), 'walk')
  assert.equal(new Set(standing).size, 5)
  const seated = E.pickRoutine('seated', 5)
  assert.equal(seated.at(-1), 'eyes')
  assert.ok(seated.every((id) => E.exercise(id).posture === 'seated'))
})

check('equipment is only suggested to someone who has it', () => {
  for (let i = 0; i < 30; i++) {
    for (const id of E.pickRoutine('standing', 5)) assert.equal(E.exercise(id).equipment, undefined, id)
  }
})

check('with equipment, one minute of every break uses it', () => {
  for (let i = 0; i < 30; i++) {
    const routine = E.pickRoutine('standing', 5, { equipment: ['band'] })
    assert.ok(routine.some((id) => E.exercise(id).equipment === 'band'), routine.join())
    assert.ok(routine.every((id) => !E.exercise(id).equipment || E.exercise(id).equipment === 'band'))
  }
})

check('nothing that loads a part being spared is ever suggested', () => {
  const all = { equipment: E.EQUIPMENT.map((e) => e.id), avoid: ['knees', 'shoulders'] }
  for (let i = 0; i < 50; i++) {
    for (const posture of ['standing', 'seated']) {
      for (const id of E.pickRoutine(posture, 5, all)) {
        const strain = E.exercise(id).strain ?? []
        assert.ok(!strain.includes('knees') && !strain.includes('shoulders'), id)
      }
    }
  }
})

check('avoiding everything still leaves a break: the walk, or resting the eyes', () => {
  const avoid = E.STRAINS.map((s) => s.id)
  assert.deepEqual(E.pickRoutine('standing', 3, { avoid }), ['walk', 'walk', 'walk'])
  assert.deepEqual(E.pickRoutine('seated', 2, { avoid }), ['eyes', 'eyes'])
})

check('every exercise names known equipment and strains', () => {
  const gear = new Set(E.EQUIPMENT.map((e) => e.id))
  const strains = new Set(E.STRAINS.map((s) => s.id))
  for (const ex of E.EXERCISES) {
    if (ex.equipment) assert.ok(gear.has(ex.equipment), ex.id)
    for (const s of ex.strain ?? []) assert.ok(strains.has(s), ex.id)
  }
  // Every piece of equipment has something to do with it.
  for (const id of gear) assert.ok(E.EXERCISES.some((ex) => ex.equipment === id), id)
})

check('every pose names every joint', () => {
  const joints = Object.keys(E.EXERCISES[0].poses[0]).sort()
  for (const ex of E.EXERCISES) {
    assert.ok(ex.poses.length >= 2, ex.id)
    for (const pose of ex.poses) assert.deepEqual(Object.keys(pose).sort(), joints, ex.id)
  }
})

console.log(`\n${passed} checks passed`)
