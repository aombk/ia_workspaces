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
// No waiting for a pause, unless a check says otherwise: most of these are about the clock.
const on = { enabled: true, everyMin: 25, breakMin: 5, equipment: [], avoid: [], waitMin: 0 }
const patient = { ...on, waitMin: 20 }
const clock = () => new B.BreakClock((posture) => E.pickChoices(posture), () => 'id')

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
  assert.deepEqual(B.readBreakSettings({}), { enabled: true, everyMin: 25, breakMin: 5, equipment: [], avoid: [], waitMin: 20 })
  assert.deepEqual(B.readBreakSettings({ moveBreaks: false, moveEveryMin: 0, moveBreakMin: 99, moveEquipment: ['band', 3], moveAvoid: 'knees' }), {
    enabled: false,
    everyMin: 5,
    breakMin: 30,
    equipment: ['band'],
    avoid: [],
    waitMin: 20,
  })
  assert.equal(B.readBreakSettings({ moveWaitMin: 0 }).waitMin, 0)
})

console.log('Waiting for a pause')

check('owed while you are typing, it waits', () => {
  const c = clock()
  assert.equal(sit(c, 0, 30, patient), false)
  assert.equal(c.state().waiting, true)
  assert.equal(c.state().due, null)
})

check('the first pause in typing brings it', () => {
  const c = clock()
  sit(c, 0, 30, patient)
  assert.equal(c.tick(30.2 * MIN, B.PAUSE_SEC, patient).raised, true)
  assert.equal(c.state().waiting, false)
})

check('a pause before it is owed does nothing', () => {
  const c = clock()
  sit(c, 0, 10, patient)
  assert.equal(c.tick(10.2 * MIN, 30, patient).raised, false)
  assert.equal(c.state().waiting, false)
})

check('no pause at all: it comes anyway once the wait is up', () => {
  const c = clock()
  assert.equal(sit(c, 0, 44.5, patient), false)
  assert.equal(sit(c, 44.5 * MIN, 1, patient), true)
})

check('switching workspace or leaving the app brings an owed break', () => {
  const c = clock()
  sit(c, 0, 10, patient)
  assert.equal(c.pause(10 * MIN), false)
  sit(c, 10 * MIN, 17, patient)
  assert.equal(c.pause(27 * MIN), true)
  assert.ok(c.state().due)
})

check('a break put off with "not now" comes back on time, pause or not', () => {
  const c = clock()
  sit(c, 0, 26, patient)
  c.tick(26.1 * MIN, 25, patient)
  assert.ok(c.snooze(26.1 * MIN))
  assert.equal(c.pause(27 * MIN), false)
  assert.equal(c.tick(31.2 * MIN, 2, patient).raised, true)
})

console.log('Getting out of one')

const due = () => {
  const c = clock()
  sit(c, 0, 25.5)
  return { c, at: c.state().due.startedAt }
}

check('the countdown starts as soon as the break comes up, standing', () => {
  const { c } = due()
  const d = c.state().due
  assert.equal(d.startedAt, d.raisedAt)
  assert.equal(d.posture, 'standing')
})

check('done is refused before the countdown has run', () => {
  const { c, at } = due()
  assert.equal(c.finish(at + 2 * MIN, 'done'), null)
  assert.ok(c.state().due)
  const record = c.finish(at + 5 * MIN, 'done')
  assert.equal(record.outcome, 'done')
  assert.equal(c.state().due, null)
  assert.equal(c.state().sittingSince, at + 5 * MIN)
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

check('a break offers one exercise, and "another" moves to a different one', () => {
  const { c, at } = due()
  const first = B.currentExercise(c.state().due)
  assert.ok(E.exercise(first))
  assert.equal(c.another(), true)
  const second = B.currentExercise(c.state().due)
  assert.notEqual(second, first)
  // The countdown is left alone.
  assert.equal(c.state().due.startedAt, at)
})

check('"another" goes round every exercise that suits and back to the first', () => {
  const { c } = due()
  const seen = new Set()
  const count = c.state().due.standing.length
  for (let i = 0; i < count; i++) {
    seen.add(B.currentExercise(c.state().due))
    c.another()
  }
  assert.equal(seen.size, count)
  assert.equal(B.currentExercise(c.state().due), c.state().due.standing[0])
})

check('switching to seated mid-break shows a seated one and keeps the countdown', () => {
  const { c, at } = due()
  assert.equal(c.lean('seated'), true)
  assert.equal(E.exercise(B.currentExercise(c.state().due)).posture, 'seated')
  assert.equal(c.state().due.startedAt, at)
  assert.equal(c.lean('seated'), false)
  assert.equal(c.finish(at + 5 * MIN, 'seated').outcome, 'seated')
})

check('the order is a fair shuffle: each exercise first about equally often', () => {
  const all = E.pickChoices('standing')
  const firsts = new Map()
  const runs = all.length * 400
  for (let n = 0; n < runs; n++) {
    const first = E.pickChoices('standing')[0]
    firsts.set(first, (firsts.get(first) ?? 0) + 1)
  }
  assert.equal(firsts.size, all.length)
  for (const [id, count] of firsts) assert.ok(count > 250 && count < 550, `${id} ${count}`)
})

check("the previous break's exercise never comes first; the rest stay equally likely", () => {
  const all = E.pickChoices('standing')
  const firsts = new Map()
  const runs = (all.length - 1) * 400
  for (let n = 0; n < runs; n++) {
    const list = E.pickChoices('standing', {}, Math.random, 'squat')
    assert.notEqual(list[0], 'squat')
    assert.equal(list.at(-1), 'squat')
    firsts.set(list[0], (firsts.get(list[0]) ?? 0) + 1)
  }
  assert.equal(firsts.size, all.length - 1)
  for (const [id, count] of firsts) assert.ok(count > 250 && count < 550, `${id} ${count}`)
})

check('a finished break records which exercise it was', () => {
  const { c, at } = due()
  const offered = B.currentExercise(c.state().due)
  assert.equal(c.finish(at, 'skipped').exercise, offered)
})

check('equipment is only suggested to someone who has it', () => {
  for (const id of E.pickChoices('standing')) assert.equal(E.exercise(id).equipment, undefined, id)
})

check('with equipment, its exercises are among the choices', () => {
  const choices = E.pickChoices('standing', { equipment: ['band'] })
  assert.ok(choices.includes('bandpull') && choices.includes('bandrow'))
  assert.ok(choices.every((id) => !E.exercise(id).equipment || E.exercise(id).equipment === 'band'))
})

check('nothing that loads a part being spared is ever suggested', () => {
  const all = { equipment: E.EQUIPMENT.map((e) => e.id), avoid: ['knees', 'shoulders'] }
  for (const posture of ['standing', 'seated']) {
    for (const id of E.pickChoices(posture, all)) {
      const strain = E.exercise(id).strain ?? []
      assert.ok(!strain.includes('knees') && !strain.includes('shoulders'), id)
    }
  }
})

check('avoiding everything still leaves a break: the walk, or resting the eyes', () => {
  const avoid = E.STRAINS.map((s) => s.id)
  assert.deepEqual(E.pickChoices('standing', { avoid }), ['walk'])
  assert.deepEqual(E.pickChoices('seated', { avoid }), ['eyes'])
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
