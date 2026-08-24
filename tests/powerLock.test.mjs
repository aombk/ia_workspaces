// Whether the machine is allowed to sleep while an agent is running.
//
// This is a small function guarding an expensive mistake. Everything it decides
// is invisible while it is right — a laptop that suspends when it should, a
// laptop that stays up through a long build — and the two ways it can be wrong
// are both discovered hours later by somebody who is not looking for them: a
// run cut off halfway through, or a battery flat by morning.
//
// Two of the decisions in `powerLock.ts` are the kind a future reader will want
// to "fix", so they are pinned hardest here. A `'blocked'` agent does not hold
// the lock, because it has stopped and is waiting for a human who has walked
// away. And a `'working'` pane that has gone quiet for five minutes does not
// hold it either, because nothing expires `runDepth` and a crashed agent would
// otherwise keep the machine awake for the rest of the session. Both look like
// omissions from the outside. Both are the point.
//
// Bundled with esbuild so the real TypeScript runs, like every other suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-powerlock-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { powerLock: 'src/shared/powerLock.ts' },
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outdir: out,
})

const { shouldHoldAwake, KEEP_AWAKE_MODES, STALE_REPORT_MS } = await import(
  `file://${out}/powerLock.js`
)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

/** A plausible epoch — large enough that ages can be subtracted from it. */
const NOW = 1_700_000_000_000

const ON_BATTERY = true
const ON_MAINS = false

/** A pane that last reported `age` milliseconds ago. */
const pane = (paneId, state, age = 0) => ({ paneId, state, updatedAt: NOW - age })

/** Reported a second ago: as alive as a pane gets. */
const fresh = (paneId, state) => pane(paneId, state, 1000)

/** Reported once, long enough ago that the dead-man's switch has fired. */
const stale = (paneId, state) => pane(paneId, state, STALE_REPORT_MS + 1)

/**
 * The whole verdict at once, because the three fields are one contract.
 *
 * Asserting `hold` alone would let `holding` drift into carrying panes that are
 * not holding anything, which is the field the UI reads to say *why* the
 * machine is awake.
 */
const expect = (verdict, hold, reason, holding = []) => {
  assert.deepEqual(verdict, { hold, reason, holding })
}

// -------------------------------------------------------------- the shape of it
console.log('The constants')
{
  check('the three modes are the three modes, in the order the UI shows them', () => {
    // `'ac'` sits in the middle because it is the default and the sensible one;
    // a control that renders the list straight through depends on that order.
    assert.deepEqual([...KEEP_AWAKE_MODES], ['off', 'ac', 'on'])
  })

  check('the staleness window is five minutes', () => {
    // Longer than any real gap between an agent's reports, shorter than a
    // night. Written out rather than referenced so that changing the constant
    // has to be a deliberate act with a test edit attached.
    assert.equal(STALE_REPORT_MS, 5 * 60_000)
  })
}

// ------------------------------------------------------------------- precedence
//
// The order in the function is the whole design: the switch beats the power
// source, and the power source beats what the agents are doing. Each of these
// sets up a case where a later rule would have said something else, so a
// reordering cannot pass by accident.
console.log('What beats what')
{
  check('off beats everything, even a busy agent on mains', () => {
    // A user who turned the feature off is owed off. Not "off unless something
    // important is happening" — the machine is theirs.
    expect(shouldHoldAwake([fresh('a', 'working')], 'off', ON_MAINS, NOW), false, 'off')
  })

  check('off still says off when there is nothing running either', () => {
    // The reason must not collapse into `idle` when both would be false: the
    // user is told the switch is off, not that their machine is quiet.
    expect(shouldHoldAwake([], 'off', ON_MAINS, NOW), false, 'off')
    expect(shouldHoldAwake([fresh('a', 'idle')], 'off', ON_BATTERY, NOW), false, 'off')
  })

  check('battery beats a busy agent under the mains-only mode', () => {
    // The case the mode exists for. A laptop on its own battery is never held
    // open, however much work is in flight.
    expect(shouldHoldAwake([fresh('a', 'working')], 'ac', ON_BATTERY, NOW), false, 'battery')
  })

  check('battery is only consulted after the switch, never before it', () => {
    // Both rules would refuse here. The reason has to be the earlier one, or
    // the two checks have swapped and nobody would notice until a user under
    // `'off'` was told their battery was the problem.
    expect(shouldHoldAwake([fresh('a', 'working')], 'off', ON_BATTERY, NOW), false, 'off')
  })

  check('the power source is only consulted under the mains-only mode', () => {
    // `'on'` is the mode for somebody who knows what they are asking for.
    expect(
      shouldHoldAwake([fresh('a', 'working')], 'on', ON_BATTERY, NOW),
      true,
      'working',
      ['a']
    )
  })
}

// ------------------------------------------------------------------- the modes
console.log('The modes')
{
  const panes = [fresh('a', 'working')]

  check('on ignores the power source entirely', () => {
    // Same verdict on both, asserted as the same object rather than two
    // separate expectations, because "identical" is the claim being made.
    const battery = shouldHoldAwake(panes, 'on', ON_BATTERY, NOW)
    const mains = shouldHoldAwake(panes, 'on', ON_MAINS, NOW)
    assert.deepEqual(battery, mains)
    expect(battery, true, 'working', ['a'])
  })

  check('ac on mains behaves exactly like on', () => {
    // The stated reason `'ac'` is the default: every desktop is on mains, so
    // the default has to be indistinguishable from `'on'` there.
    assert.deepEqual(
      shouldHoldAwake(panes, 'ac', ON_MAINS, NOW),
      shouldHoldAwake(panes, 'on', ON_MAINS, NOW)
    )
  })

  check('ac and on agree about everything except the battery', () => {
    // Swept across the states so the equivalence is a property rather than one
    // lucky pane.
    for (const state of ['blocked', 'working', 'idle', 'unknown']) {
      const set = [fresh('a', state)]
      assert.deepEqual(
        shouldHoldAwake(set, 'ac', ON_MAINS, NOW),
        shouldHoldAwake(set, 'on', ON_MAINS, NOW),
        state
      )
    }
  })

  check('every mode is handled and none falls through to a surprise', () => {
    // A loop over the exported list rather than three hand-written cases, so a
    // fourth mode added to `KEEP_AWAKE_MODES` fails here until it is decided
    // about, instead of silently taking the `'on'` branch.
    const REASONS = new Set(['off', 'battery', 'idle', 'stale', 'working'])
    for (const mode of KEEP_AWAKE_MODES) {
      for (const onBattery of [ON_BATTERY, ON_MAINS]) {
        for (const panes of [[], [fresh('a', 'working')], [stale('a', 'working')]]) {
          const v = shouldHoldAwake(panes, mode, onBattery, NOW)
          const label = `${mode} ${onBattery ? 'battery' : 'mains'} ${panes.length}`
          assert.ok(REASONS.has(v.reason), `${label} -> ${v.reason}`)
          assert.equal(typeof v.hold, 'boolean', label)
          assert.ok(Array.isArray(v.holding), label)
          // The one invariant that spans every branch: nothing is named as
          // holding the lock unless the lock is being held.
          if (!v.hold) assert.deepEqual(v.holding, [], label)
        }
      }
    }
    // And the expected verdict for each mode with a genuinely busy pane, so the
    // sweep above cannot pass by every mode returning the same thing.
    const busy = [fresh('a', 'working')]
    expect(shouldHoldAwake(busy, 'off', ON_MAINS, NOW), false, 'off')
    expect(shouldHoldAwake(busy, 'ac', ON_BATTERY, NOW), false, 'battery')
    expect(shouldHoldAwake(busy, 'ac', ON_MAINS, NOW), true, 'working', ['a'])
    expect(shouldHoldAwake(busy, 'on', ON_BATTERY, NOW), true, 'working', ['a'])
  })
}

// -------------------------------------------------------- only working holds it
//
// The heart of the design. Three of the four states release the machine, and
// the one that surprises people is `'blocked'`.
console.log('What an agent has to be doing')
{
  check('a working agent holds the machine awake', () => {
    expect(shouldHoldAwake([fresh('a', 'working')], 'on', ON_MAINS, NOW), true, 'working', ['a'])
  })

  check('a blocked agent lets the machine sleep', () => {
    // Deliberate, and the case most likely to be mistaken for a bug. A pane
    // parked on a permission prompt has stopped: it is waiting for a human, and
    // the notification fired precisely because that human left. Holding the
    // laptop open to wait for somebody who is not in the room is backwards —
    // the machine sleeps and the prompt is still there when they get back.
    expect(shouldHoldAwake([fresh('a', 'blocked')], 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('an idle agent lets the machine sleep', () => {
    expect(shouldHoldAwake([fresh('a', 'idle')], 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('an agent in an unknown state lets the machine sleep', () => {
    // `'unknown'` is a pane that has never said anything about itself. The safe
    // reading of silence is "not running", because the alternative is a machine
    // held awake by a pane nobody ever taught to report.
    expect(shouldHoldAwake([fresh('a', 'unknown')], 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('a room full of stopped agents still lets the machine sleep', () => {
    // Volume is not activity. Ten blocked panes are ten people-shaped waits.
    const panes = [
      fresh('a', 'blocked'),
      fresh('b', 'blocked'),
      fresh('c', 'idle'),
      fresh('d', 'unknown'),
      fresh('e', 'blocked'),
    ]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('one working agent beside a blocked one still holds it', () => {
    // And names only itself. A blocked pane must not be swept into `holding`
    // by proximity — the list is shown to the user as the reason the machine is
    // up, and a name in it that is not doing anything is a lie they can see.
    const panes = [fresh('a', 'blocked'), fresh('b', 'working')]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['b'])
  })
}

// ------------------------------------------------------------------ staleness
//
// The dead-man's switch. Nothing expires `runDepth`, so a pane whose agent was
// killed reads `'working'` forever; as a badge that is a small lie, as a wake
// lock it is a machine that never sleeps again and fails silently. These are
// the checks that keep the lock sceptical while the badge stays optimistic.
console.log('Panes that have gone quiet')
{
  check('a working pane that has said nothing for too long does not hold it', () => {
    expect(shouldHoldAwake([stale('a', 'working')], 'on', ON_MAINS, NOW), false, 'stale')
  })

  check('stale is its own reason, not folded into idle', () => {
    // The two want different things from whoever reads them. `idle` is a system
    // at rest; `stale` is a pane that is probably lying to the sidebar, and the
    // person looking at it may want to go and check on it.
    const gone = shouldHoldAwake([stale('a', 'working')], 'on', ON_MAINS, NOW)
    const quiet = shouldHoldAwake([fresh('a', 'idle')], 'on', ON_MAINS, NOW)
    assert.equal(gone.reason, 'stale')
    assert.equal(quiet.reason, 'idle')
    assert.notEqual(gone.reason, quiet.reason)
  })

  check('a report exactly at the window still counts', () => {
    // The boundary in the generous direction: the comparison is `<=`, so a pane
    // heard from exactly five minutes ago is still working. Pinned because an
    // off-by-one here drops a live agent, and the symptom is a machine that
    // sleeps mid-run every few minutes.
    const panes = [pane('a', 'working', STALE_REPORT_MS)]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['a'])
  })

  check('one millisecond past the window does not', () => {
    // And the other side of the same boundary, so the pair fixes the comparison
    // exactly rather than merely somewhere in the neighbourhood.
    const panes = [pane('a', 'working', STALE_REPORT_MS + 1)]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), false, 'stale')
  })

  check('a pane that has never reported is stale, not special', () => {
    // `updatedAt: 0` is the epoch, which is how a pane that has never been
    // heard from arrives. It goes through the same arithmetic as everything
    // else — there is no "never reported" branch to get wrong — and comes out
    // as what it is: a claim of work with nothing behind it.
    const never = { paneId: 'a', state: 'working', updatedAt: 0 }
    expect(shouldHoldAwake([never], 'on', ON_MAINS, NOW), false, 'stale')
  })

  check('staleness is only asked about panes claiming to work', () => {
    // An idle pane that has not reported in a week is not stale, it is idle.
    // Nothing claimed otherwise, so there is nothing to be sceptical about.
    expect(shouldHoldAwake([stale('a', 'idle')], 'on', ON_MAINS, NOW), false, 'idle')
    expect(shouldHoldAwake([stale('a', 'blocked')], 'on', ON_MAINS, NOW), false, 'idle')
    expect(shouldHoldAwake([stale('a', 'unknown')], 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('a single fresh worker outvotes any number of stale ones', () => {
    // Staleness is per pane, not a property of the set. One agent genuinely
    // running is enough, and the crashed panes around it neither help nor
    // hinder it.
    const panes = [
      stale('a', 'working'),
      stale('b', 'working'),
      fresh('c', 'working'),
      stale('d', 'working'),
    ]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['c'])
  })
}

// -------------------------------------------------------------- the holding list
//
// `holding` is not decoration: it is what turns "awake" into "awake because
// these two panes are working", which is a claim a user can check rather than
// one they have to trust. So it is asserted exactly, in both directions.
console.log('Who is named as holding it')
{
  check('holding names every fresh worker and nothing else', () => {
    const panes = [
      fresh('a', 'working'),
      fresh('b', 'blocked'),
      fresh('c', 'working'),
      stale('d', 'working'),
      fresh('e', 'idle'),
      fresh('f', 'unknown'),
    ]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['a', 'c'])
  })

  check('holding keeps the order the panes arrived in', () => {
    // Two filters in sequence, both order-preserving. Worth pinning because the
    // list is rendered as-is and a set-shaped rewrite would reshuffle the names
    // under the user on every re-render.
    const panes = [fresh('z', 'working'), fresh('m', 'idle'), fresh('a', 'working')]
    assert.deepEqual(shouldHoldAwake(panes, 'on', ON_MAINS, NOW).holding, ['z', 'a'])
  })

  check('holding is empty for every reason that refuses', () => {
    // An empty list is part of the contract for all four refusals, not just the
    // convenient ones — a caller that trusts `holding` to be meaningful should
    // never be handed a name alongside `hold: false`.
    const cases = [
      ['off', [fresh('a', 'working')], 'off', ON_MAINS],
      ['battery', [fresh('a', 'working')], 'ac', ON_BATTERY],
      ['idle', [fresh('a', 'blocked'), fresh('b', 'idle')], 'on', ON_MAINS],
      ['stale', [stale('a', 'working')], 'on', ON_MAINS],
    ]
    for (const [reason, panes, mode, onBattery] of cases) {
      const v = shouldHoldAwake(panes, mode, onBattery, NOW)
      assert.equal(v.reason, reason)
      assert.equal(v.hold, false, reason)
      assert.deepEqual(v.holding, [], reason)
    }
  })

  check('hold and a non-empty holding always travel together', () => {
    // Stated as the invariant rather than case by case: `hold` is true exactly
    // when somebody is named, across every combination this suite can build.
    for (const mode of KEEP_AWAKE_MODES) {
      for (const onBattery of [ON_BATTERY, ON_MAINS]) {
        for (const panes of [
          [],
          [fresh('a', 'working')],
          [stale('a', 'working')],
          [fresh('a', 'blocked'), fresh('b', 'working')],
          [fresh('a', 'idle'), stale('b', 'working')],
        ]) {
          const v = shouldHoldAwake(panes, mode, onBattery, NOW)
          assert.equal(v.hold, v.holding.length > 0, `${mode} ${onBattery} ${panes.length}`)
          assert.equal(v.hold, v.reason === 'working', `${mode} ${onBattery} ${panes.length}`)
        }
      }
    }
  })

  check('the caller cannot reach in and change the panes it was given', () => {
    // The verdict is read and then thrown away by `main/powerLock.ts`, but the
    // pane list belongs to the agent-state store. Nothing here should be
    // mutating it, and a filter that turned into a splice would be silently
    // eating panes out of the sidebar.
    const panes = [fresh('a', 'working'), fresh('b', 'blocked')]
    const before = JSON.parse(JSON.stringify(panes))
    shouldHoldAwake(panes, 'on', ON_MAINS, NOW)
    assert.deepEqual(panes, before)
  })
}

// ----------------------------------------------------------------- mixed sets
console.log('A whole workspace at once')
{
  check('a realistic spread of panes resolves to the working ones', () => {
    // What an afternoon actually looks like: something running, something
    // waiting on a person, something finished, and one pane whose agent died
    // three hours ago and never said so.
    const panes = [
      pane('build', 'working', 2_000),
      pane('review', 'blocked', 30_000),
      pane('notes', 'idle', 600_000),
      pane('ghost', 'working', 3 * 60 * 60 * 1000),
      pane('scratch', 'unknown', 0),
      pane('tests', 'working', STALE_REPORT_MS - 1),
    ]
    expect(shouldHoldAwake(panes, 'ac', ON_MAINS, NOW), true, 'working', ['build', 'tests'])
  })

  check('the same spread on battery under ac never looks at any of it', () => {
    // The same input, one plug pulled: the answer is the power source and the
    // panes are not consulted at all.
    const panes = [pane('build', 'working', 2_000), pane('review', 'blocked', 30_000)]
    expect(shouldHoldAwake(panes, 'ac', ON_BATTERY, NOW), false, 'battery')
  })

  check('losing the last fresh worker turns the lock off', () => {
    // The transition that matters at runtime: the same set a moment later, with
    // the one live pane gone quiet. `working` becomes `stale`, not `idle`,
    // because the pane is still claiming to run.
    const panes = [stale('a', 'working'), pane('b', 'working', STALE_REPORT_MS)]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['b'])
    // One millisecond of wall clock later, nothing else changed.
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW + 1), false, 'stale')
  })

  check('many panes are all counted, not just the first match', () => {
    const panes = Array.from({ length: 50 }, (_, i) =>
      fresh(`p${i}`, i % 3 === 0 ? 'working' : 'idle')
    )
    const v = shouldHoldAwake(panes, 'on', ON_MAINS, NOW)
    assert.equal(v.hold, true)
    assert.equal(v.holding.length, 17)
    assert.equal(v.holding[0], 'p0')
    assert.equal(v.holding.at(-1), 'p48')
  })
}

// ----------------------------------------------------------------- edge cases
console.log('Edges')
{
  check('no panes at all is idle', () => {
    // The state at launch, and after the last pane closes. Nothing is running,
    // so nothing is held — and the reason says so rather than reporting a
    // problem there is no evidence of.
    expect(shouldHoldAwake([], 'on', ON_MAINS, NOW), false, 'idle')
    expect(shouldHoldAwake([], 'ac', ON_MAINS, NOW), false, 'idle')
  })

  check('a clock that went backwards is believed only so far', () => {
    // Wall clock time moves, and it moves for exactly the reason this feature
    // exists: a machine resuming from suspend corrects itself against a time
    // server. That leaves reports stamped ahead of `now`, whose age is
    // negative — and negative is comfortably inside any upper bound, so
    // without a floor a future-stamped pane reads as fresh forever and holds
    // the machine open with it. The dead-man's switch would have a hole in it
    // precisely where it is most needed.
    //
    // So the window is bounded at both ends. Ordinary skew is believed, on the
    // grounds that a report from a moment in the future is a pane that just
    // spoke.
    const skewed = { paneId: 'a', state: 'working', updatedAt: NOW + 30_000 }
    expect(shouldHoldAwake([skewed], 'on', ON_MAINS, NOW), true, 'working', ['a'])

    // A stamp that is not skew but nonsense is treated as what it is: a pane
    // whose clock cannot be trusted to tell us when it stops talking.
    const wild = { paneId: 'a', state: 'working', updatedAt: NOW + 10 * 365 * 86_400_000 }
    expect(shouldHoldAwake([wild], 'on', ON_MAINS, NOW), false, 'stale')

    // A backwards clock cannot resurrect a pane that was not working.
    const blocked = { paneId: 'b', state: 'blocked', updatedAt: NOW + 30_000 }
    expect(shouldHoldAwake([blocked], 'on', ON_MAINS, NOW), false, 'idle')
  })

  check('duplicate pane ids are reported as many times as they appear', () => {
    // Pane ids are unique upstream, so this is documenting rather than blessing
    // the behaviour: the function counts entries, it does not deduplicate. If a
    // duplicate ever reaches the UI as two identical names, the fix belongs
    // where the list was built, not here.
    const panes = [fresh('a', 'working'), fresh('a', 'working'), fresh('a', 'idle')]
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ['a', 'a'])
  })

  check('a pane id may be any string the app can produce', () => {
    // Ids are opaque here — nothing parses them — so an empty one or one full
    // of punctuation must travel through untouched rather than being dropped.
    const ids = ['', 'pane-1', 'a/b', '日本語', '  ']
    const panes = ids.map((id) => fresh(id, 'working'))
    expect(shouldHoldAwake(panes, 'on', ON_MAINS, NOW), true, 'working', ids)
  })

  check('a now of zero is still just arithmetic', () => {
    // The shape a test double or an uninitialised timer hands over. A pane
    // stamped at the epoch is fresh relative to it, which is consistent even if
    // it is nobody's real clock.
    const at = (updatedAt) => [{ paneId: 'a', state: 'working', updatedAt }]
    expect(shouldHoldAwake(at(0), 'on', ON_MAINS, 0), true, 'working', ['a'])
    expect(shouldHoldAwake(at(-STALE_REPORT_MS - 1), 'on', ON_MAINS, 0), false, 'stale')
  })

  check('the same inputs always give the same answer', () => {
    // No clock of its own, no state between calls. This is what makes the
    // decision testable at all, and it is worth one check that it stays true.
    const panes = [fresh('a', 'working'), stale('b', 'working'), fresh('c', 'blocked')]
    const first = shouldHoldAwake(panes, 'ac', ON_MAINS, NOW)
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(shouldHoldAwake(panes, 'ac', ON_MAINS, NOW), first)
    }
  })
}

console.log(`\n${passed} checks passed`)
