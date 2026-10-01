// What the renderer's save may and may not overwrite.
//
// Main records the window's position and size into the store when it moves;
// the renderer sends the whole document on every save, carrying the bounds it
// read at launch. Before the merge below, every save after a move put the old
// bounds back, and the app reopened where it had first opened rather than where
// it was left.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-rendererstate-'))
await build({
  entryPoints: { state: 'src/main/rendererState.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})
const { mergeRendererState } = await import(`file://${out}/state.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

console.log('Saving the renderer’s document')

check('the window main recorded survives a save from the renderer', () => {
  const held = { workspaces: [], window: { x: 40, y: 60, width: 1111, height: 777 } }
  const sent = { workspaces: [{ id: 'w' }], window: { x: 0, y: 0, width: 1360, height: 860 } }
  const merged = mergeRendererState(held, sent)
  assert.deepEqual(merged.window, held.window)
  // Everything else is the renderer's, and arrives as it sent it.
  assert.deepEqual(merged.workspaces, sent.workspaces)
})

check('before main has recorded any window, the renderer’s is kept', () => {
  const sent = { window: { width: 900, height: 600 } }
  assert.deepEqual(mergeRendererState({}, sent).window, sent.window)
  assert.deepEqual(mergeRendererState(null, sent).window, sent.window)
})

check('the merge does not change what it was given', () => {
  const held = { window: { width: 1 } }
  const sent = { window: { width: 2 }, a: 1 }
  mergeRendererState(held, sent)
  assert.deepEqual(sent, { window: { width: 2 }, a: 1 })
})

check('anything that is not a document is refused', () => {
  for (const bad of [null, undefined, 3, 'x', []]) assert.equal(mergeRendererState({}, bad), null)
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
