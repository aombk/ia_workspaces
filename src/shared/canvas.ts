/**
 * JSON Canvas 1.0 — the shapes, and the arithmetic for drawing them.
 *
 * The format is Obsidian's, published as an open spec under MIT, and using it
 * rather than inventing one is the whole point: a canvas made here opens there,
 * and one made there opens here. The spec is short and worth reading — the
 * details below that look arbitrary are all its, not ours.
 *
 * Separated from `canvasPane.ts` for the same reason `flowchart.ts` is
 * separated from its renderer: this is geometry and can be tested without a
 * browser, and the pane is then only about pointers and elements.
 *
 * The pane was first written from a recollection of the format and got four
 * things wrong — no arrow heads, edge sides ignored, colours ignored, and text
 * nodes shown raw where the spec says they hold markdown. Every one of those is
 * pinned by a test now.
 */

/** Every canvas is one of these, wherever it lives. */
export const CANVAS_EXT = '.canvas'

/**
 * Is this path a canvas?
 *
 * Here rather than in the pane because three unrelated places ask — the file
 * tree, to offer opening it as one; the canvas itself, to draw a nested one;
 * and the pane, to know what it is saving — and none of them should have to
 * import a pane to find out.
 */
export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith(CANVAS_EXT)
}

/**
 * The rectangle every node sits inside.
 *
 * Used to fit a canvas into a viewport and to fit one into a thumbnail, which
 * are the same sum done at two sizes. Null for a canvas with nothing on it —
 * there is no box round no notes, and returning zeros would have both callers
 * quietly dividing by one.
 */
export function boundsOf(
  nodes: CanvasNode[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!nodes.length) return null
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x + n.width)),
    maxY: Math.max(...nodes.map((n) => n.y + n.height)),
  }
}

/** Sides an edge may leave from or arrive at. */
export type CanvasSide = 'top' | 'right' | 'bottom' | 'left'

export interface CanvasNode {
  id: string
  type: 'text' | 'file' | 'link' | 'group'
  /** Text nodes: plain text *with markdown syntax*, per the spec. */
  text?: string
  file?: string
  subpath?: string
  url?: string
  label?: string
  background?: string
  backgroundStyle?: string
  x: number
  y: number
  width: number
  height: number
  color?: string
}

export interface CanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: CanvasSide
  toSide?: CanvasSide
  /** The spec's defaults are not symmetric: `none` at the start, `arrow` at the end. */
  fromEnd?: 'none' | 'arrow'
  toEnd?: 'none' | 'arrow'
  color?: string
  label?: string
}

export interface CanvasFile {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

/**
 * The six preset colours, which the spec deliberately leaves undefined.
 *
 * "Specific values for the preset colors are intentionally not defined so that
 * applications can tailor the presets to their specific brand colors" — so each
 * is a CSS custom property, and a theme can move it without this file knowing.
 */
const PRESETS: Record<string, string> = {
  '1': 'var(--canvas-red, #d1495b)',
  '2': 'var(--canvas-orange, #e07a3f)',
  '3': 'var(--canvas-yellow, #d9a441)',
  '4': 'var(--canvas-green, #4c956c)',
  '5': 'var(--canvas-cyan, #3d8ea8)',
  '6': 'var(--canvas-purple, #8a63a8)',
}

/** A `canvasColor` as something CSS can use, or null for "the theme's own". */
export function colorOf(color: string | undefined): string | null {
  if (!color) return null
  if (color.startsWith('#')) return color
  return PRESETS[color] ?? null
}

/**
 * Reads a `.canvas` file, keeping everything in it.
 *
 * Unknown fields survive because the parsed objects are what get written back,
 * not a reconstruction of them. That is not tidiness — a canvas made in
 * Obsidian holds group backgrounds, file subpaths and colours this app has no
 * use for, and a pane that silently dropped them on re-saving would be the
 * worst thing it could do to somebody's file.
 */
export function readCanvas(text: string): CanvasFile {
  try {
    const parsed = JSON.parse(text) as Partial<CanvasFile>
    return {
      nodes: (parsed.nodes ?? []).filter((n) => n && typeof n.id === 'string'),
      edges: (parsed.edges ?? []).filter((e) => e && e.fromNode && e.toNode),
    }
  } catch {
    // Not a canvas, or not written yet. An empty one, which is what a new
    // project has and is not an error.
    return { nodes: [], edges: [] }
  }
}

/** Which side of `node` faces `other`, by whichever gap is the larger. */
export function facing(node: CanvasNode, other: CanvasNode): CanvasSide {
  const dx = other.x + other.width / 2 - (node.x + node.width / 2)
  const dy = other.y + other.height / 2 - (node.y + node.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/** The point on one side of a node where a line meets it. */
export function anchor(node: CanvasNode, side: CanvasSide): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y }
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height }
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 }
    default:
      return { x: node.x + node.width, y: node.y + node.height / 2 }
  }
}

/**
 * A curve that leaves and arrives square to the sides it touches.
 *
 * The control points are pushed straight out from each end, which is what makes
 * a line look like it belongs to the side it started on rather than cutting off
 * at an angle from a corner.
 */
export function curve(
  start: { x: number; y: number },
  fromSide: CanvasSide,
  end: { x: number; y: number },
  toSide: CanvasSide
): string {
  const reach = Math.max(40, Math.hypot(end.x - start.x, end.y - start.y) / 2)
  const c1 = push(start, fromSide, reach)
  const c2 = push(end, toSide, reach)
  return `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`
}

function push(at: { x: number; y: number }, side: CanvasSide, by: number): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: at.x, y: at.y - by }
    case 'bottom':
      return { x: at.x, y: at.y + by }
    case 'left':
      return { x: at.x - by, y: at.y }
    default:
      return { x: at.x + by, y: at.y }
  }
}
