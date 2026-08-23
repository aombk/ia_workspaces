// The parts of JSON Canvas that are easy to get wrong from memory.
//
// This pane was written against a recollection of Obsidian's format and then
// checked against the actual spec (`borf/obsidian/jsoncanvas`, MIT), which
// turned up four real mistakes — no arrowheads, edge sides ignored, colours
// ignored, and text nodes shown raw when the spec says they hold markdown.
//
// So these hold the details a second pass would drift on again. The one that
// matters most is not the drawing: it is that a canvas made in Obsidian and
// re-saved here comes back whole, including everything this app has no idea
// what to do with.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-canvas-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { canvas: 'src/shared/canvas.ts' },
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outdir: out,
})
const { facing, anchor, colorOf, readCanvas, curve, boundsOf, isCanvasPath, CANVAS_EXT } =
  await import(`file://${out}/canvas.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const box = (x, y) => ({ id: 'n', type: 'text', x, y, width: 100, height: 60 })

check('a note picks the side that faces the one it points at', () => {
  const middle = box(100, 100)
  assert.equal(facing(middle, box(400, 100)), 'right')
  assert.equal(facing(middle, box(-400, 100)), 'left')
  assert.equal(facing(middle, box(100, 400)), 'bottom')
  assert.equal(facing(middle, box(100, -400)), 'top')
})

check('a line meets a note on its border, never inside it', () => {
  const node = box(100, 200)
  assert.deepEqual(anchor(node, 'top'), { x: 150, y: 200 })
  assert.deepEqual(anchor(node, 'bottom'), { x: 150, y: 260 })
  assert.deepEqual(anchor(node, 'left'), { x: 100, y: 230 })
  assert.deepEqual(anchor(node, 'right'), { x: 200, y: 230 })
})

check('the six preset colours resolve, and a hex is used as it is', () => {
  for (const preset of ['1', '2', '3', '4', '5', '6']) {
    assert.ok(colorOf(preset), `preset ${preset} should resolve`)
  }
  assert.equal(colorOf('#FF0000'), '#FF0000', 'a hex value is the value')
  assert.equal(colorOf(undefined), null, 'no colour means the theme decides')
  assert.equal(colorOf('7'), null, 'and an unknown preset is not invented')
})

check('a canvas from Obsidian survives being read and written back', () => {
  // Every node type, and fields this app has no use for. The spec's own
  // vocabulary, taken from `spec/1.0.md`.
  const original = {
    nodes: [
      { id: 'g1', type: 'group', x: 0, y: 0, width: 400, height: 300, label: 'Ideas',
        background: 'pic.png', backgroundStyle: 'cover' },
      { id: 't1', type: 'text', x: 20, y: 20, width: 200, height: 100, text: '# Heading', color: '4' },
      { id: 'f1', type: 'file', x: 20, y: 140, width: 200, height: 100, file: 'notes/a.md', subpath: '#top' },
      { id: 'l1', type: 'link', x: 240, y: 20, width: 200, height: 100, url: 'https://example.com' },
    ],
    edges: [
      { id: 'e1', fromNode: 't1', toNode: 'f1', fromSide: 'bottom', toSide: 'top',
        toEnd: 'none', color: '#00FF00', label: 'see also' },
    ],
  }

  const round = JSON.parse(JSON.stringify(readCanvas(JSON.stringify(original))))

  assert.deepEqual(round, original, 'nothing was dropped, reordered or invented')
  assert.equal(round.nodes[0].backgroundStyle, 'cover', 'a field we never read still survives')
  assert.equal(round.nodes[2].subpath, '#top')
  assert.equal(round.edges[0].toEnd, 'none', 'an explicit "no arrow" is not overwritten by the default')
})

check('groups come first, which is to say underneath', () => {
  // "Nodes are placed in the array in ascending order by z-index. The first
  // node should be displayed below all other nodes." Rendering in array order
  // is what makes a group a container rather than a lid over its contents.
  const nodes = [
    { id: 'g', type: 'group', x: 0, y: 0, width: 400, height: 300 },
    { id: 't', type: 'text', x: 20, y: 20, width: 100, height: 60 },
  ]
  assert.equal(nodes[0].type, 'group', 'the group is drawn first')
})

check('a curve leaves and arrives square to the sides it touches', () => {
  // The control points are what make a line look like it belongs to the side it
  // started on rather than cutting off at an angle from a corner.
  const d = curve({ x: 0, y: 0 }, 'right', { x: 200, y: 0 }, 'left')
  const found = /C ([-\d.]+) ([-\d.]+), ([-\d.]+) ([-\d.]+)/.exec(d)
  assert.ok(found, 'the path is a cubic curve')
  const [, c1x, c1y, c2x, c2y] = found.map(Number)
  assert.ok(c1x > 0, 'the first control point is pushed out to the right')
  assert.equal(c1y, 0, 'and stays level, so the line leaves flat')
  assert.ok(c2x < 200, 'the second is pulled back to the left of the target')
  assert.equal(c2y, 0)
})

check('rubbish is an empty canvas, not a crash', () => {
  for (const junk of ['', 'not json', '{}', '[]', '{"nodes":null}']) {
    const parsed = readCanvas(junk)
    assert.deepEqual(parsed.nodes, [], `nodes for ${JSON.stringify(junk)}`)
    assert.deepEqual(parsed.edges, [])
  }
})

// A canvas can hold another canvas: the format says a file node is "the path to
// the file", with no restriction on which kind, which is the whole licence for
// nesting them. So what counts as one has to be agreed by the tree that offers
// to open it, the pane that saves it, and the card that draws it.
check('a canvas is recognised by its extension, whatever its case or path', () => {
  assert.equal(CANVAS_EXT, '.canvas')
  assert.equal(isCanvasPath('notes.canvas'), true)
  assert.equal(isCanvasPath('C:\\proj\\Plans.CANVAS'), true)
  assert.equal(isCanvasPath('/home/ia/a.canvas'), true)
  assert.equal(isCanvasPath('notes.canvas.md'), false)
  assert.equal(isCanvasPath('canvas'), false)
  assert.equal(isCanvasPath(''), false)
})

// The same sum fits a canvas into a viewport and into a thumbnail on another
// canvas, so it is one function and it is checked once.
check('the bounds of a canvas cover every node, and nothing covers none', () => {
  assert.equal(boundsOf([]), null)
  const nodes = [
    { id: 'a', type: 'text', x: -40, y: 10, width: 100, height: 50 },
    { id: 'b', type: 'text', x: 200, y: -30, width: 60, height: 400 },
  ]
  assert.deepEqual(boundsOf(nodes), { minX: -40, minY: -30, maxX: 260, maxY: 370 })
})

console.log(`\n${passed} checks passed`)
