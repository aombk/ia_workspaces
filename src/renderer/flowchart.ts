/**
 * Drawing what `shared/flowchart.ts` worked out.
 *
 * Split from the layout because the layout is arithmetic and this is SVG: the
 * arithmetic can then be tested without a browser, and the drawing stays small
 * enough to read in one go.
 *
 * SVG rather than canvas because a diagram in a document has to survive being
 * zoomed, printed and copied, and because every shape here is a rectangle, a
 * line or a word — none of which canvas does better and all of which it does
 * worse at three times the size.
 */
import { layoutFlowchart, parseFlowchart, type FlowEdge, type FlowNode } from '../shared/flowchart'

const NS = 'http://www.w3.org/2000/svg'
/** Room around the drawing so a box's border is not clipped by the edge. */
const MARGIN = 10

/**
 * Renders a `mermaid` block, or answers null to leave it as code.
 *
 * Null for anything the parser does not understand — a sequence diagram, a
 * flowchart using subgraphs — because a picture that silently omits what it
 * could not read is worse than the source text it replaced. See
 * `parseFlowchart`.
 */
export function renderFlowchart(source: string): SVGSVGElement | null {
  const graph = parseFlowchart(source)
  if (!graph) return null

  const chart = layoutFlowchart(graph)
  if (!chart.nodes.length) return null

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'flowchart')
  svg.setAttribute(
    'viewBox',
    `${-MARGIN} ${-MARGIN} ${chart.width + MARGIN * 2} ${chart.height + MARGIN * 2}`
  )
  // A width in `ch` and a height in the ratio it was laid out at: the diagram
  // then scales with the document's text rather than sitting at whatever pixel
  // size happened to fall out of the arithmetic.
  svg.setAttribute('width', String(chart.width + MARGIN * 2))
  svg.setAttribute('height', String(chart.height + MARGIN * 2))
  svg.setAttribute('role', 'img')

  svg.appendChild(arrowHead())
  // Lines first so a box always sits on top of anything passing behind it.
  for (const edge of chart.edges) drawEdge(svg, edge)
  for (const node of chart.nodes) drawNode(svg, node)
  return svg
}

/**
 * The one arrow head, defined once and pointed at by every line that has one.
 *
 * `context-stroke` so the head takes the colour of the line it ends, which is
 * what makes a dotted line's arrow dotted-coloured without a second marker.
 */
function arrowHead(): SVGDefsElement {
  const defs = document.createElementNS(NS, 'defs')
  const marker = document.createElementNS(NS, 'marker')
  marker.setAttribute('id', 'flow-arrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '6')
  marker.setAttribute('markerHeight', '6')
  marker.setAttribute('orient', 'auto-start-reverse')

  const head = document.createElementNS(NS, 'path')
  head.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z')
  head.setAttribute('fill', 'context-stroke')
  marker.appendChild(head)
  defs.appendChild(marker)
  return defs
}

function drawEdge(svg: SVGSVGElement, edge: FlowEdge): void {
  if (edge.points.length < 2) return

  const line = document.createElementNS(NS, 'path')
  line.setAttribute('class', `flow-edge flow-edge--${edge.style}`)
  line.setAttribute('d', rounded(edge.points))
  line.setAttribute('fill', 'none')
  if (edge.arrow) line.setAttribute('marker-end', 'url(#flow-arrow)')
  svg.appendChild(line)

  if (!edge.label) return

  // At the bend, which is the one point on the line guaranteed not to be
  // underneath either box.
  const at = edge.points[Math.floor(edge.points.length / 2)]
  const text = document.createElementNS(NS, 'text')
  text.setAttribute('class', 'flow-edge__label')
  text.setAttribute('x', String(at.x))
  text.setAttribute('y', String(at.y))
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'middle')
  text.textContent = edge.label
  // A plate behind the words, so a label over a line is readable.
  const plate = document.createElementNS(NS, 'rect')
  plate.setAttribute('class', 'flow-edge__plate')
  plate.setAttribute('x', String(at.x - (edge.label.length * 6.4) / 2 - 4))
  plate.setAttribute('y', String(at.y - 8))
  plate.setAttribute('width', String(edge.label.length * 6.4 + 8))
  plate.setAttribute('height', '16')
  plate.setAttribute('rx', '3')
  svg.append(plate, text)
}

/** A path through the points with the corners eased, so bends are not sharp. */
function rounded(points: { x: number; y: number }[], radius = 8): string {
  if (points.length < 3) return `M ${points.map((p) => `${p.x} ${p.y}`).join(' L ')}`

  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const previous = points[i - 1]
    const corner = points[i]
    const next = points[i + 1]

    const into = shorten(corner, previous, radius)
    const outOf = shorten(corner, next, radius)
    d += ` L ${into.x} ${into.y} Q ${corner.x} ${corner.y} ${outOf.x} ${outOf.y}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last.x} ${last.y}`
}

/** A point `by` along the way from `at` towards `towards`, never past halfway. */
function shorten(
  at: { x: number; y: number },
  towards: { x: number; y: number },
  by: number
): { x: number; y: number } {
  const dx = towards.x - at.x
  const dy = towards.y - at.y
  const length = Math.hypot(dx, dy) || 1
  const step = Math.min(by, length / 2)
  return { x: at.x + (dx / length) * step, y: at.y + (dy / length) * step }
}

function drawNode(svg: SVGSVGElement, node: FlowNode): void {
  const group = document.createElementNS(NS, 'g')
  group.setAttribute('class', `flow-node flow-node--${node.shape}`)

  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2

  if (node.shape === 'diamond') {
    const shape = document.createElementNS(NS, 'polygon')
    shape.setAttribute(
      'points',
      [
        `${cx},${node.y}`,
        `${node.x + node.width},${cy}`,
        `${cx},${node.y + node.height}`,
        `${node.x},${cy}`,
      ].join(' ')
    )
    group.appendChild(shape)
  } else if (node.shape === 'circle') {
    const shape = document.createElementNS(NS, 'ellipse')
    shape.setAttribute('cx', String(cx))
    shape.setAttribute('cy', String(cy))
    shape.setAttribute('rx', String(node.width / 2))
    shape.setAttribute('ry', String(node.height / 2))
    group.appendChild(shape)
  } else {
    const shape = document.createElementNS(NS, 'rect')
    shape.setAttribute('x', String(node.x))
    shape.setAttribute('y', String(node.y))
    shape.setAttribute('width', String(node.width))
    shape.setAttribute('height', String(node.height))
    // A stadium is a rectangle whose corners are as round as they can be.
    const radius = node.shape === 'stadium' ? node.height / 2 : node.shape === 'round' ? 10 : 3
    shape.setAttribute('rx', String(radius))
    group.appendChild(shape)
  }

  const text = document.createElementNS(NS, 'text')
  text.setAttribute('class', 'flow-node__label')
  text.setAttribute('x', String(cx))
  text.setAttribute('y', String(cy))
  text.setAttribute('text-anchor', 'middle')
  text.setAttribute('dominant-baseline', 'middle')
  text.textContent = node.label
  group.appendChild(text)

  svg.appendChild(group)
}
