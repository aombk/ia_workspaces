/**
 * Flowcharts written as text, laid out without a dependency.
 *
 * A diagram beside the code is worth having, and the two ways to get one are
 * both wrong for this app. A drawing tool means a binary blob that git cannot
 * diff and nobody edits after the first week. Mermaid — whose syntax this
 * borrows — is the right idea and the wrong package here: a megabyte and dozens
 * of transitive dependencies, in a project whose entire runtime dependency list
 * is one terminal library. The markdown renderer, the diff view and the commit
 * graph are all hand-rolled for the same reason.
 *
 * So this reads the part of mermaid's flowchart syntax people actually write,
 * and lays it out. Text in, geometry out, no DOM — which is what makes it
 * testable, and what keeps the drawing in one small file next to it.
 *
 * **What it does not do**, said plainly so nobody discovers it in an editor:
 * subgraphs, styling directives, class definitions, sequence and state and
 * every other mermaid diagram type. A `mermaid` block using those renders as
 * the code it is rather than as a wrong picture — see `parseFlowchart`.
 */

/** How a node is drawn, taken from the brackets around its label. */
export type NodeShape = 'box' | 'round' | 'stadium' | 'diamond' | 'circle'

/** How an edge is drawn. Mermaid's three line styles. */
export type EdgeStyle = 'solid' | 'dotted' | 'thick'

export interface FlowNode {
  id: string
  label: string
  shape: NodeShape
  /** Distance from a root, which becomes the row (or column) it sits in. */
  rank: number
  /** Position within the rank, decided by the crossing-reduction pass. */
  order: number
  x: number
  y: number
  width: number
  height: number
}

export interface FlowEdge {
  from: string
  to: string
  label: string
  style: EdgeStyle
  /** False for `---`, which joins without asserting a direction. */
  arrow: boolean
  /** Where the line goes, source border to target border. */
  points: { x: number; y: number }[]
}

export interface Flowchart {
  direction: 'TD' | 'LR'
  nodes: FlowNode[]
  edges: FlowEdge[]
  width: number
  height: number
}

/** A parsed graph, before anything knows where it sits. */
export interface FlowGraph {
  direction: 'TD' | 'LR'
  nodes: Map<string, { label: string; shape: NodeShape }>
  edges: { from: string; to: string; label: string; style: EdgeStyle; arrow: boolean }[]
}

/** Roughly how wide a character is, so a label can be sized without a DOM. */
const CHAR_W = 7.2
const PAD_X = 14
const MIN_W = 46
const ROW_H = 34

/** Between ranks, and between neighbours in a rank. */
const RANK_GAP = 52
const NODE_GAP = 24

/** Anything past this is a diagram nobody can read anyway, and a layout that crawls. */
const MAX_NODES = 200

/**
 * Reads the flowchart, or answers null for anything this does not draw.
 *
 * Null is the important half. A `mermaid` block holding a sequence diagram, or
 * a flowchart using subgraphs, must fall back to being shown as code — a
 * renderer that quietly drops what it does not understand produces a diagram
 * that is confidently missing a box, which is worse than no diagram at all.
 */
export function parseFlowchart(source: string): FlowGraph | null {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'))
  if (!lines.length) return null

  const header = /^(?:flowchart|graph)\s+(TD|TB|LR|RL|BT)\b/i.exec(lines[0])
  if (!header) return null

  // `TB` is mermaid's other name for top-down. `BT` and `RL` are the same
  // layouts reversed, and are rare enough that drawing them the familiar way
  // round beats not drawing them: the boxes and arrows are still right.
  const up = header[1].toUpperCase()
  const direction = up === 'LR' || up === 'RL' ? 'LR' : 'TD'

  const graph: FlowGraph = { direction, nodes: new Map(), edges: [] }

  for (const line of lines.slice(1)) {
    // Anything this does not understand stops the whole diagram rather than
    // being skipped, for the reason in the doc comment above.
    if (/^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i.test(line)) return null

    const edge = readEdge(line)
    if (edge) {
      define(graph, edge.left)
      define(graph, edge.right)
      graph.edges.push({
        from: idOf(edge.left),
        to: idOf(edge.right),
        label: edge.label,
        style: edge.style,
        arrow: edge.arrow,
      })
      continue
    }

    // A node on its own line, declaring a shape or a label without an edge.
    if (/^[A-Za-z0-9_-]+(\[|\(|\{|$)/.test(line)) {
      define(graph, line)
      continue
    }

    return null
  }

  if (!graph.nodes.size || graph.nodes.size > MAX_NODES) return null
  return graph
}

/** `A[Start] --> |yes| B` split into its two ends and the arrow between them. */
function readEdge(
  line: string
): { left: string; right: string; label: string; style: EdgeStyle; arrow: boolean } | null {
  // `A -- text --> B` is tried first, because the general pattern below would
  // otherwise match its trailing `-->` and swallow `A -- text` as the left-hand
  // node. The spaces around `--` are what tell it apart from `-->` and `---`,
  // neither of which has whitespace after the second dash.
  const match =
    /^(.+?)\s+--\s+([^->|]+?)\s+(-->|---)\s*(.+)$/.exec(line) ??
    // The three line styles, longest first so `-.->` is not read as `-`.
    /^(.+?)\s*(-\.->|-\.-|==>|===|-->|---)\s*(?:\|([^|]*)\|\s*)?(.+)$/.exec(line)
  if (!match) return null

  // The two forms put the label in different places; tell them apart by
  // whether the second group looks like an arrow.
  const isArrowSecond = /^(-\.->|-\.-|==>|===|-->|---)$/.test(match[2])
  const arrowText = isArrowSecond ? match[2] : match[3]
  const label = (isArrowSecond ? (match[3] ?? '') : match[2]).trim()

  return {
    left: match[1].trim(),
    right: match[4].trim(),
    label,
    style: arrowText.includes('.') ? 'dotted' : arrowText.includes('=') ? 'thick' : 'solid',
    arrow: arrowText.endsWith('>'),
  }
}

/** `B{Choice?}` — the identifier, and how it should be drawn. */
function define(graph: FlowGraph, text: string): void {
  const id = idOf(text)
  if (!id) return

  const rest = text.slice(id.length).trim()
  let shape: NodeShape = 'box'
  let label = ''

  // Longest brackets first: `([x])` and `((x))` both start with a character
  // that would match a shorter form.
  const forms: [RegExp, NodeShape][] = [
    [/^\(\[(.*)\]\)$/, 'stadium'],
    [/^\(\((.*)\)\)$/, 'circle'],
    [/^\[(.*)\]$/, 'box'],
    [/^\((.*)\)$/, 'round'],
    [/^\{(.*)\}$/, 'diamond'],
  ]
  for (const [pattern, kind] of forms) {
    const found = pattern.exec(rest)
    if (found) {
      shape = kind
      label = found[1].trim()
      break
    }
  }

  const existing = graph.nodes.get(id)
  if (existing) {
    // A node mentioned twice keeps whichever mention gave it a label. Mermaid
    // works this way and people rely on it: declare the shape once, then refer
    // to the bare id in every edge after.
    if (label) existing.label = strip(label)
    if (shape !== 'box') existing.shape = shape
    return
  }
  graph.nodes.set(id, { label: strip(label || id), shape })
}

function idOf(text: string): string {
  return /^[A-Za-z0-9_-]+/.exec(text)?.[0] ?? ''
}

/** Mermaid allows quotes around a label to protect punctuation in it. */
function strip(label: string): string {
  const quoted = /^"(.*)"$/.exec(label)
  return quoted ? quoted[1] : label
}

/**
 * Puts the graph on a plane: ranks, then an order within each, then geometry.
 *
 * A layered layout, which is what every flowchart tool does and what the
 * syntax assumes — mermaid's `TD` means "ranks go down". Three passes, each
 * doing one thing, because the alternative is a single function nobody can
 * change without redoing all of it.
 */
export function layoutFlowchart(graph: FlowGraph): Flowchart {
  const nodes = new Map<string, FlowNode>()
  for (const [id, node] of graph.nodes) {
    const size = sizeOf(node.label, node.shape)
    nodes.set(id, {
      id,
      label: node.label,
      shape: node.shape,
      rank: 0,
      order: 0,
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
    })
  }

  rank(graph, nodes)
  order(graph, nodes)
  return place(graph, nodes)
}

/**
 * How far each node sits from a root, as the longest path to it.
 *
 * Longest rather than shortest so an arrow never points backwards: a node is
 * always below every node that leads to it. Cycles are broken by refusing to
 * revisit a node already on the path being walked, which leaves the loop's
 * closing edge pointing back up the diagram — drawn, and visibly a loop.
 */
function rank(graph: FlowGraph, nodes: Map<string, FlowNode>): void {
  const out = new Map<string, string[]>()
  const incoming = new Map<string, number>()
  for (const id of nodes.keys()) {
    out.set(id, [])
    incoming.set(id, 0)
  }
  for (const edge of graph.edges) {
    if (edge.from === edge.to) continue
    out.get(edge.from)?.push(edge.to)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  // Roots first; a graph that is all cycles has none, so the first node
  // declared stands in, which is where a reader's eye starts anyway.
  const roots = [...nodes.keys()].filter((id) => (incoming.get(id) ?? 0) === 0)
  const starts = roots.length ? roots : [[...nodes.keys()][0]]

  const walk = (id: string, depth: number, path: Set<string>): void => {
    const node = nodes.get(id)
    if (!node || path.has(id)) return
    if (depth <= node.rank && depth !== 0) return
    node.rank = Math.max(node.rank, depth)

    path.add(id)
    for (const next of out.get(id) ?? []) walk(next, node.rank + 1, path)
    path.delete(id)
  }
  for (const start of starts) walk(start, 0, new Set())
}

/**
 * Orders the nodes within each rank so fewer lines cross.
 *
 * The barycentre heuristic: put each node next to the average position of what
 * it connects to, sweep down, sweep up, repeat. It is not optimal — crossing
 * minimisation is NP-hard — and four passes is where the picture stops
 * visibly improving on diagrams of the size anybody writes by hand.
 */
function order(graph: FlowGraph, nodes: Map<string, FlowNode>): void {
  const ranks = new Map<number, FlowNode[]>()
  for (const node of nodes.values()) {
    const list = ranks.get(node.rank) ?? []
    list.push(node)
    ranks.set(node.rank, list)
  }
  for (const list of ranks.values()) list.forEach((node, index) => (node.order = index))

  const depth = Math.max(...ranks.keys(), 0)
  for (let pass = 0; pass < 4; pass++) {
    const downwards = pass % 2 === 0
    for (let r = downwards ? 1 : depth - 1; downwards ? r <= depth : r >= 0; downwards ? r++ : r--) {
      const list = ranks.get(r)
      if (!list) continue

      const weight = new Map<string, number>()
      for (const node of list) {
        const neighbours = graph.edges
          .filter((e) => (downwards ? e.to === node.id : e.from === node.id))
          .map((e) => nodes.get(downwards ? e.from : e.to))
          .filter((n): n is FlowNode => !!n && n.rank !== node.rank)
        weight.set(
          node.id,
          neighbours.length
            ? neighbours.reduce((sum, n) => sum + n.order, 0) / neighbours.length
            : node.order
        )
      }
      list.sort((a, b) => (weight.get(a.id) ?? 0) - (weight.get(b.id) ?? 0))
      list.forEach((node, index) => (node.order = index))
    }
  }
}

/** Turns ranks and orders into coordinates, and routes every line. */
function place(graph: FlowGraph, nodes: Map<string, FlowNode>): Flowchart {
  const vertical = graph.direction === 'TD'
  const ranks = new Map<number, FlowNode[]>()
  for (const node of nodes.values()) {
    const list = ranks.get(node.rank) ?? []
    list.push(node)
    ranks.set(node.rank, list)
  }
  for (const list of ranks.values()) list.sort((a, b) => a.order - b.order)

  // Each rank is a row (or a column); the long axis is where the ranks march,
  // the short axis is where a rank's members sit side by side.
  const spans = [...ranks.entries()].sort((a, b) => a[0] - b[0])
  let along = 0
  let widest = 0

  for (const [, list] of spans) {
    const thickness = Math.max(...list.map((n) => (vertical ? n.height : n.width)))
    let across = 0
    for (const node of list) {
      if (vertical) {
        node.x = across
        node.y = along + (thickness - node.height) / 2
        across += node.width + NODE_GAP
      } else {
        node.y = across
        node.x = along + (thickness - node.width) / 2
        across += node.height + NODE_GAP
      }
    }
    widest = Math.max(widest, across - NODE_GAP)
    along += thickness + RANK_GAP
  }

  // Centre each rank against the widest one, so the diagram reads as a column
  // down the middle rather than as a ragged left edge.
  for (const [, list] of spans) {
    const extent = list.reduce((sum, n) => sum + (vertical ? n.width : n.height) + NODE_GAP, -NODE_GAP)
    const shift = (widest - extent) / 2
    for (const node of list) {
      if (vertical) node.x += shift
      else node.y += shift
    }
  }

  const edges: FlowEdge[] = graph.edges.map((edge) => {
    const from = nodes.get(edge.from)
    const to = nodes.get(edge.to)
    return {
      from: edge.from,
      to: edge.to,
      label: edge.label,
      style: edge.style,
      arrow: edge.arrow,
      points: from && to ? route(from, to, vertical) : [],
    }
  })

  const all = [...nodes.values()]
  return {
    direction: graph.direction,
    nodes: all,
    edges,
    width: Math.max(...all.map((n) => n.x + n.width), 0),
    height: Math.max(...all.map((n) => n.y + n.height), 0),
  }
}

/**
 * Where a line runs, from one node's border to the other's.
 *
 * Three points rather than two: the middle one is what makes a line between
 * ranks that are not aligned read as a deliberate bend rather than as a
 * diagonal cutting across whatever is between them.
 */
function route(from: FlowNode, to: FlowNode, vertical: boolean): { x: number; y: number }[] {
  const fromCentre = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const toCentre = { x: to.x + to.width / 2, y: to.y + to.height / 2 }

  if (vertical) {
    const down = toCentre.y >= fromCentre.y
    const start = { x: fromCentre.x, y: down ? from.y + from.height : from.y }
    const end = { x: toCentre.x, y: down ? to.y : to.y + to.height }
    return [start, { x: start.x, y: (start.y + end.y) / 2 }, { x: end.x, y: (start.y + end.y) / 2 }, end]
  }

  const right = toCentre.x >= fromCentre.x
  const start = { x: right ? from.x + from.width : from.x, y: fromCentre.y }
  const end = { x: right ? to.x : to.x + to.width, y: toCentre.y }
  return [start, { x: (start.x + end.x) / 2, y: start.y }, { x: (start.x + end.x) / 2, y: end.y }, end]
}

/** How big a box has to be to hold its label. */
function sizeOf(label: string, shape: NodeShape): { width: number; height: number } {
  const text = Math.max(label.length * CHAR_W + PAD_X * 2, MIN_W)
  // A diamond's label sits in the narrow middle of it, so it needs to be wider
  // than the text to hold the same words; a circle needs to be both.
  if (shape === 'diamond') return { width: text * 1.35, height: ROW_H * 1.5 }
  if (shape === 'circle') {
    const side = Math.max(text, ROW_H * 1.8)
    return { width: side, height: side }
  }
  return { width: text, height: ROW_H }
}
