// Flowcharts parsed and laid out, without a browser.
//
// The layout is arithmetic, which is why it lives apart from the drawing: a
// picture can only be checked by looking at it, and arithmetic can be checked
// here. The properties worth holding are the ones a reader would notice
// immediately and a developer never would — an arrow that points backwards, a
// box that overlaps another, a diagram that quietly lost a node.
//
// The other half is knowing when to refuse. A `mermaid` block this cannot draw
// must fall back to being shown as code, because a diagram that silently omits
// what it could not read is worse than the text it replaced.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-flow-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { flow: 'src/shared/flowchart.ts' },
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  outdir: out,
})
const { parseFlowchart, layoutFlowchart } = await import(`file://${out}/flow.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const lay = (source) => {
  const graph = parseFlowchart(source)
  assert.ok(graph, `expected this to parse:\n${source}`)
  return layoutFlowchart(graph)
}
const node = (chart, id) => chart.nodes.find((n) => n.id === id)

// --------------------------------------------------------------------- parse

check('a plain chain of boxes', () => {
  const graph = parseFlowchart(`flowchart TD
    A[Start] --> B[Middle]
    B --> C[End]`)
  assert.equal(graph.direction, 'TD')
  assert.equal(graph.nodes.size, 3)
  assert.equal(graph.nodes.get('A').label, 'Start')
  assert.equal(graph.edges.length, 2)
  assert.ok(graph.edges[0].arrow)
})

check('every shape the brackets can ask for', () => {
  const graph = parseFlowchart(`flowchart LR
    A[box] --> B(round)
    B --> C([stadium])
    C --> D{diamond}
    D --> E((circle))`)
  assert.equal(graph.nodes.get('A').shape, 'box')
  assert.equal(graph.nodes.get('B').shape, 'round')
  assert.equal(graph.nodes.get('C').shape, 'stadium')
  assert.equal(graph.nodes.get('D').shape, 'diamond')
  assert.equal(graph.nodes.get('E').shape, 'circle')
})

check('the three line styles, and a line with no arrow', () => {
  const graph = parseFlowchart(`flowchart TD
    A --> B
    B --- C
    C -.-> D
    D ==> E`)
  assert.deepEqual(
    graph.edges.map((e) => e.style),
    ['solid', 'solid', 'dotted', 'thick']
  )
  assert.deepEqual(
    graph.edges.map((e) => e.arrow),
    [true, false, true, true]
  )
})

check('edge labels, written either way round', () => {
  const graph = parseFlowchart(`flowchart TD
    A{ok?} -->|yes| B[go]
    A -- no --> C[stop]`)
  assert.equal(graph.edges[0].label, 'yes')
  assert.equal(graph.edges[1].label, 'no')
})

check('a node declared once is remembered at every later mention', () => {
  // Mermaid works this way and people rely on it: give the shape once, then
  // use the bare id everywhere after.
  const graph = parseFlowchart(`flowchart TD
    A[Full name] --> B
    B --> A`)
  assert.equal(graph.nodes.get('A').label, 'Full name')
})

check('a bare id is its own label', () => {
  const graph = parseFlowchart('flowchart TD\n  build --> test')
  assert.equal(graph.nodes.get('build').label, 'build')
})

check('quotes around a label are stripped, so punctuation survives', () => {
  const graph = parseFlowchart('flowchart TD\n  A["a, b and c"] --> B')
  assert.equal(graph.nodes.get('A').label, 'a, b and c')
})

// -------------------------------------------------------------------- refuse

check('what it cannot draw, it refuses outright', () => {
  for (const source of [
    'sequenceDiagram\n  A->>B: hi',
    'stateDiagram-v2\n  [*] --> Still',
    'flowchart TD\n  subgraph one\n    A --> B\n  end',
    'flowchart TD\n  A --> B\n  style A fill:#f9f',
    'pie title Pets\n  "Dogs": 386',
    '',
    'not a diagram at all',
  ]) {
    assert.equal(parseFlowchart(source), null, `should have refused: ${JSON.stringify(source)}`)
  }
})

// -------------------------------------------------------------------- layout

check('an arrow never points backwards up the diagram', () => {
  // The property a reader notices instantly. Ranks are longest-path so that a
  // node always sits below everything that leads to it.
  const chart = lay(`flowchart TD
    A --> B
    A --> C
    B --> D
    C --> D`)
  for (const edge of chart.edges) {
    assert.ok(
      node(chart, edge.to).y > node(chart, edge.from).y,
      `${edge.from} -> ${edge.to} went upwards`
    )
  }
})

check('a diamond gets its branches side by side, not stacked', () => {
  const chart = lay(`flowchart TD
    A{ok?} -->|yes| B[go]
    A -->|no| C[stop]`)
  assert.equal(node(chart, 'B').y, node(chart, 'C').y, 'both branches sit on one rank')
  assert.notEqual(node(chart, 'B').x, node(chart, 'C').x, 'and beside each other')
})

check('no two boxes overlap', () => {
  const chart = lay(`flowchart TD
    A[one] --> B[two]
    A --> C[three]
    A --> D[four]
    B --> E[five]
    C --> E
    D --> E`)
  for (const a of chart.nodes) {
    for (const b of chart.nodes) {
      if (a === b) continue
      const apart =
        a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
      assert.ok(apart, `${a.id} and ${b.id} overlap`)
    }
  }
})

check('left-to-right lays out along the other axis', () => {
  const chart = lay('flowchart LR\n  A --> B --> C'.replace(' --> C', '\n  B --> C'))
  assert.ok(node(chart, 'B').x > node(chart, 'A').x, 'B is to the right of A')
  assert.equal(node(chart, 'A').y, node(chart, 'B').y, 'and on the same line')
})

check('a cycle is drawn rather than hanging', () => {
  // Longest-path ranking walks the graph; a loop that revisits a node has to
  // stop, or this never returns.
  const chart = lay(`flowchart TD
    A --> B
    B --> C
    C --> A`)
  assert.equal(chart.nodes.length, 3)
  assert.equal(chart.edges.length, 3)
  assert.ok(chart.edges.every((e) => e.points.length >= 2), 'every line got a route')
})

check('a node pointing at itself does not break the ranking', () => {
  const chart = lay('flowchart TD\n  A --> A\n  A --> B')
  assert.equal(chart.nodes.length, 2)
  assert.ok(node(chart, 'B').y > node(chart, 'A').y)
})

check('a longer label makes a wider box', () => {
  const chart = lay('flowchart TD\n  A[x] --> B[a much longer label here]')
  assert.ok(node(chart, 'B').width > node(chart, 'A').width)
})

check('every line starts and ends on a border, not in the middle of a box', () => {
  const chart = lay('flowchart TD\n  A[from] --> B[to]')
  const [edge] = chart.edges
  const from = node(chart, 'A')
  const to = node(chart, 'B')
  const start = edge.points[0]
  const end = edge.points[edge.points.length - 1]

  assert.ok(Math.abs(start.y - (from.y + from.height)) < 0.01, 'leaves the bottom of the first')
  assert.ok(Math.abs(end.y - to.y) < 0.01, 'arrives at the top of the second')
})

check('the diagram reports a size that contains it', () => {
  const chart = lay(`flowchart TD
    A[one] --> B[two]
    A --> C[a wider one]`)
  for (const n of chart.nodes) {
    assert.ok(n.x >= -0.01 && n.y >= -0.01, `${n.id} sits outside the top-left`)
    assert.ok(n.x + n.width <= chart.width + 0.01, `${n.id} runs past the right edge`)
    assert.ok(n.y + n.height <= chart.height + 0.01, `${n.id} runs past the bottom`)
  }
})

console.log(`\n${passed} checks passed`)
