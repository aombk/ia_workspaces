// Which panes may have their shell taken away.
//
// Every condition in `mayRelease` is a way of being wrong about somebody's
// work, and the cost is not symmetric: failing to release a pane costs some
// memory, releasing the wrong one ends a process a person was relying on. So
// each refusal gets its own check, and the one case that is allowed is the
// narrow one — an agent conversation, off screen, saying nothing.
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-idle-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { idle: 'src/shared/idleShells.ts' },
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outdir: out,
})
const { mayRelease, panesToRelease } = await import(`file://${out}/idle.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const NOW = 1_000_000_000
const AFTER = 30 * 60 * 1000

/** An agent pane, off screen for an hour, saying nothing: the one that goes. */
const idleAgent = (over = {}) => ({
  spawned: true,
  hibernated: false,
  disposed: false,
  deferred: true,
  deferredAt: NOW - 60 * 60 * 1000,
  resumable: true,
  indicator: null,
  ...over,
})

console.log('Releasing an idle shell')
{
  check('an agent pane off screen past the delay is released', () => {
    assert.equal(mayRelease(idleAgent(), AFTER, NOW), true)
  })

  check('0 minutes turns the whole thing off', () => {
    assert.equal(mayRelease(idleAgent(), 0, NOW), false)
  })

  check('a pane on screen is never released, however long it has been quiet', () => {
    assert.equal(mayRelease(idleAgent({ deferred: false, deferredAt: 0 }), AFTER, NOW), false)
  })

  check('off screen, but not for long enough yet', () => {
    const recent = idleAgent({ deferredAt: NOW - AFTER + 1 })
    assert.equal(mayRelease(recent, AFTER, NOW), false)
    // And the boundary itself counts as reached.
    assert.equal(mayRelease(idleAgent({ deferredAt: NOW - AFTER }), AFTER, NOW), true)
  })

  // The licence for the whole feature is that the conversation comes back. A
  // plain shell holds an ssh session, a half-typed command, a folder three
  // levels down — none of which a transcript restores.
  check('a shell with nothing to resume is left alone', () => {
    assert.equal(mayRelease(idleAgent({ resumable: false }), AFTER, NOW), false)
  })

  check('an agent that is working keeps its shell', () => {
    assert.equal(mayRelease(idleAgent({ indicator: 'working' }), AFTER, NOW), false)
  })

  // The subtle one: blocked reads as idle everywhere else in the app, and is
  // exactly when taking the shell away would be rudest — a question is on
  // screen waiting for an answer that is meant to go back into that shell.
  check('an agent waiting on an answer keeps its shell', () => {
    assert.equal(mayRelease(idleAgent({ indicator: 'blocked' }), AFTER, NOW), false)
  })

  check('output still arriving keeps its shell', () => {
    assert.equal(mayRelease(idleAgent({ indicator: 'active' }), AFTER, NOW), false)
  })

  check('a pane with no shell, or already asleep, is not released twice', () => {
    assert.equal(mayRelease(idleAgent({ spawned: false }), AFTER, NOW), false)
    assert.equal(mayRelease(idleAgent({ hibernated: true }), AFTER, NOW), false)
    assert.equal(mayRelease(idleAgent({ disposed: true }), AFTER, NOW), false)
  })

  check('the sweep picks out exactly the qualifying panes', () => {
    const panes = [
      idleAgent({ paneId: 'a' }),
      idleAgent({ paneId: 'b', indicator: 'working' }),
      idleAgent({ paneId: 'c', resumable: false }),
      idleAgent({ paneId: 'd' }),
    ]
    assert.deepEqual(
      panesToRelease(panes, AFTER, NOW).map((p) => p.paneId),
      ['a', 'd']
    )
  })
}

console.log(`\n${passed} checks passed`)
