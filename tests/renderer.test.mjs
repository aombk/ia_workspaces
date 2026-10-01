// Small renderer decisions that are cheaper to pin down here than on screen:
// when a tab's pane tree must be rebuilt, and when a pane drawn from shared
// state must be drawn again.
//
// Both are questions with a costly wrong answer in each direction. Rebuild a
// tree too often and every browser pane in it reloads its page; too rarely and
// a pane shows the wrong thing. Redraw a pane too often and a button is
// replaced under the cursor between press and release; too rarely and it is
// stale.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-renderer-'))
await build({
  entryPoints: { paneLayout: 'src/renderer/paneLayout.ts', redraw: 'src/renderer/redraw.ts' },
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outdir: out,
})
const { layoutSignature } = await import(`file://${out}/paneLayout.js`)
const { Redraw } = await import(`file://${out}/redraw.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

console.log('Pane trees')

const split = (sizes, kinds = ['terminal', 'browser']) => ({
  id: 't',
  customTitle: null,
  panes: [
    { id: 'a', kind: kinds[0], cwd: '/', autoTitle: '' },
    { id: 'b', kind: kinds[1], cwd: '/', autoTitle: '' },
  ],
  layout: {
    kind: 'split',
    direction: 'row',
    sizes,
    children: [
      { kind: 'leaf', paneId: 'a' },
      { kind: 'leaf', paneId: 'b' },
    ],
  },
  activePaneId: 'a',
})

// Dragging a divider resizes the built tree and writes the sizes back in
// place, without a rebuild — so the tree must not then look out of date.
check('resizing a split is not a new layout', () => {
  assert.equal(layoutSignature(split([0.5, 0.5])), layoutSignature(split([0.3, 0.7])))
})

check('a different arrangement, or a pane changing kind, is', () => {
  const base = layoutSignature(split([0.5, 0.5]))
  const turned = split([0.5, 0.5])
  turned.layout.direction = 'column'
  assert.notEqual(layoutSignature(turned), base)
  const swapped = split([0.5, 0.5])
  swapped.layout.children.reverse()
  assert.notEqual(layoutSignature(swapped), base)
  assert.notEqual(layoutSignature(split([0.5, 0.5], ['terminal', 'editor'])), base)
  const nested = split([0.5, 0.5])
  nested.layout.children[1] = {
    kind: 'split',
    direction: 'column',
    sizes: [0.5, 0.5],
    children: [{ kind: 'leaf', paneId: 'b' }, { kind: 'leaf', paneId: 'a' }],
  }
  assert.notEqual(layoutSignature(nested), base)
})

console.log('Redrawing panes')

/** Just enough element for `isShown`: connected, and whether anything above is hidden. */
const element = (shown = true) => ({
  isConnected: true,
  hidden: !shown,
  closest(selector) {
    assert.equal(selector, '[hidden]')
    return this.hidden ? this : null
  },
})

check('the same inputs do not redraw, different ones do', () => {
  const spans = []
  const redraw = new Redraw(element())
  redraw.drew(['/a', spans, 0])
  assert.equal(redraw.due(['/a', spans, 0]), false)
  // Compared by identity: a fresh read is a fresh array, even if it is equal.
  assert.equal(redraw.due(['/a', [], 0]), true)
  assert.equal(redraw.due(['/b', spans, 0]), true)
})

check('a hidden pane is never due, and catches up once shown', () => {
  const el = element(false)
  const redraw = new Redraw(el)
  redraw.drew(['/a'])
  assert.equal(redraw.due(['/b']), false)
  el.hidden = false
  assert.equal(redraw.due(['/b']), true)
})

check('a watcher saying its data moved makes the next look due', () => {
  const redraw = new Redraw(element())
  redraw.drew(['/a'])
  redraw.invalidate()
  assert.equal(redraw.due(['/a']), true)
})

check('an element not in the document is not shown', () => {
  const el = element()
  el.isConnected = false
  const redraw = new Redraw(el)
  assert.equal(redraw.due(['anything']), false)
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
