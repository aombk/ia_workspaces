// The inline-editor guard: what keeps a terminal from grabbing focus out of a
// rename field, and — the part that went wrong — what lets it have focus back.
//
// A rename input can leave without a `blur`: the rebuild that ends a rename
// throws the input away with the DOM around it. The guard used to be a counter,
// so that discarded input was never subtracted and `isEditing()` stayed true
// for the life of the window, with every terminal refusing focus from then on.
//
// No DOM library: `editing.ts` only ever adds listeners, reads `isConnected`
// and focuses, so a stub input is the real contract.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-editing-'))
const outfile = path.join(sandbox, 'editing.mjs')
await build({
  entryPoints: ['src/renderer/ui/editing.ts'],
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outfile,
})

const { attachInlineEditor, isEditing, beginEditing, endEditing } = await import(`file://${outfile}`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

/** Just enough input for the editor to wire itself to. */
function stubInput(value = 'name') {
  const handlers = new Map()
  return {
    value,
    isConnected: false,
    focus() {},
    select() {},
    addEventListener(type, fn) {
      handlers.set(type, fn)
    },
    fire(type, event = {}) {
      handlers.get(type)?.({ stopPropagation() {}, preventDefault() {}, ...event })
    },
  }
}

function attach(input) {
  const seen = { commits: [], cancels: 0 }
  attachInlineEditor(input, {
    onCommit: (v) => seen.commits.push(v),
    onCancel: () => seen.cancels++,
  })
  return seen
}

console.log('Inline editors')

check('an editor holds the keyboard while it is on screen', () => {
  const input = attachAndMount()
  assert.equal(isEditing(), true)
  input.fire('blur')
  assert.equal(isEditing(), false)
})

// The regression this file exists for.
check('an editor discarded without a blur stops holding it', () => {
  const input = attachAndMount()
  assert.equal(isEditing(), true)
  // What a rebuild does: the input goes with the DOM around it, and no event
  // is delivered to say so.
  input.isConnected = false
  assert.equal(isEditing(), false)
})

// An editor is built before it is inserted, and between those two moments it is
// as "not in the document" as a discarded one. Losing that case would let a
// terminal take focus out of a field the instant it appeared.
check('an editor that has not been inserted yet still holds it', () => {
  const input = stubInput()
  attach(input)
  assert.equal(input.isConnected, false)
  assert.equal(isEditing(), true)
  input.isConnected = true
  assert.equal(isEditing(), true)
  input.fire('blur')
  assert.equal(isEditing(), false)
})

check('Enter commits what was typed, once', () => {
  const input = attachAndMount()
  const seen = input.seen
  input.value = 'renamed'
  input.fire('keydown', { key: 'Enter' })
  // The blur that follows a commit must not commit a second time.
  input.fire('blur')
  assert.deepEqual(seen.commits, ['renamed'])
  assert.equal(isEditing(), false)
})

check('Escape cancels and commits nothing', () => {
  const input = attachAndMount()
  input.value = 'discarded'
  input.fire('keydown', { key: 'Escape' })
  assert.deepEqual(input.seen.commits, [])
  assert.equal(input.seen.cancels, 1)
  assert.equal(isEditing(), false)
})

check('clicking away commits, the way every rename field does', () => {
  const input = attachAndMount()
  input.value = 'typed'
  input.fire('blur')
  assert.deepEqual(input.seen.commits, ['typed'])
})

// `editorPane` holds the guard directly, around a text area that is not one of
// these. Both kinds have to count.
check('a held editor counts as editing on its own', () => {
  beginEditing()
  assert.equal(isEditing(), true)
  endEditing()
  assert.equal(isEditing(), false)
})

check('two editors at once release only when both are gone', () => {
  const first = attachAndMount()
  const second = attachAndMount()
  first.fire('blur')
  assert.equal(isEditing(), true)
  second.isConnected = false
  assert.equal(isEditing(), false)
})

function attachAndMount(value) {
  const input = stubInput(value)
  input.seen = attach(input)
  input.isConnected = true
  // Reading once records that it has been in the document, which is what tells
  // a discarded editor from one that is merely not inserted yet.
  isEditing()
  return input
}

console.log(`\n${passed} checks passed`)
fs.rmSync(sandbox, { recursive: true, force: true })
