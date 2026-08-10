/**
 * Turning a list of saves into the picture of them.
 *
 * A save (commit) knows only which saves came before it, so the branching
 * picture everyone recognises is not stored anywhere — it has to be worked out.
 * This does that: it walks the saves newest first, keeping a set of columns
 * ("lanes"), and hands each row the columns it needs to draw. Nothing here
 * knows about SVG, colours or the DOM; it is arithmetic, which is why it can be
 * tested without a window.
 *
 * The rule the whole thing turns on: a lane is a *promise to draw a line down
 * to a particular save*. When we reach that save, every lane promising it
 * converges on its dot, and the save's own parents take over lanes in turn.
 * Two lanes promising the same save is exactly what a fork looks like from
 * underneath, and one save claiming two parent lanes is exactly what a join-up
 * save (merge commit) looks like from above.
 */

/** The only thing the layout needs to know about a save. */
export interface GraphNode {
  sha: string
  /**
   * The saves immediately before this one, in git's own order. The first is the
   * line this save belongs to; any others are lines glued into it.
   */
  parents: string[]
}

export interface GraphRow {
  sha: string
  /** The column this save's dot sits in. */
  lane: number
  /**
   * Columns arriving from the row above that lead into this dot.
   *
   * Empty for the newest save on a line — nothing points at it yet, so its line
   * begins at the dot rather than entering from off-screen.
   */
  in: number[]
  /**
   * Columns leaving below the dot, one per save this one came from. Two or more
   * means this is a join-up save (merge commit) and the picture forks going
   * down. Empty means the very first save in the project.
   */
  out: number[]
  /** Columns crossing this row untouched — other lines, passing by. */
  through: number[]
  /** Columns in play on this row, so a caller knows how wide to draw it. */
  width: number
}

/** First unused column, so lanes are recycled and the picture stays narrow. */
function firstFree(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null)
  return free === -1 ? lanes.length : free
}

/**
 * Lays out saves that are already in git's order — newest first, and every save
 * listed before the saves it came from.
 *
 * That ordering is a precondition rather than something checked: `git log`
 * guarantees it, and a save whose parent appeared *above* it would simply get a
 * fresh lane, which is the same thing the picture does for a save nothing points
 * at. Wrong, but not broken, and not worth a pass over the list to detect.
 */
export function layoutGraph(nodes: readonly GraphNode[]): GraphRow[] {
  /** Column -> the save that column has promised to draw a line down to. */
  const lanes: (string | null)[] = []
  const rows: GraphRow[] = []

  for (const node of nodes) {
    const before = lanes.slice()

    // Every column promising this save. They all end here, converging on the
    // dot; the leftmost keeps going as this save's own column, because keeping
    // the leftmost is what stops a long-lived line drifting rightwards every
    // time something merges into it.
    const incoming: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] === node.sha) incoming.push(i)

    const lane = incoming.length ? incoming[0] : firstFree(lanes)
    for (const i of incoming) if (i !== lane) lanes[i] = null

    // The saves this one came from take over columns. The first inherits this
    // save's own column — that is what makes a straight line straight. The rest
    // join a column already promising them if there is one, so two lines
    // heading for the same save share a column rather than running in parallel
    // for the whole picture.
    const out: number[] = []
    node.parents.forEach((parent, index) => {
      if (index === 0) {
        lanes[lane] = parent
        out.push(lane)
        return
      }
      let target = lanes.indexOf(parent)
      if (target === -1) {
        target = firstFree(lanes)
        lanes[target] = parent
      }
      if (!out.includes(target)) out.push(target)
    })
    // The very first save in a project has nothing before it, so its column ends.
    if (node.parents.length === 0) lanes[lane] = null

    const through: number[] = []
    for (let i = 0; i < before.length; i++) {
      if (before[i] === null || incoming.includes(i)) continue
      // Nothing here ever moves a column sideways, so a column untouched by
      // this row still holds what it held. Kept as a comparison rather than
      // assumed, so a future change that does move one cannot draw a line
      // from nowhere to nowhere.
      if (lanes[i] === before[i]) through.push(i)
    }

    let width = lane + 1
    for (let i = 0; i < Math.max(before.length, lanes.length); i++) {
      if (before[i] != null || lanes[i] != null) width = Math.max(width, i + 1)
    }

    rows.push({ sha: node.sha, lane, in: incoming, out, through, width })
  }

  return rows
}

/** The widest row, which is how wide the whole picture has to be drawn. */
export function graphWidth(rows: readonly GraphRow[]): number {
  let width = 0
  for (const row of rows) width = Math.max(width, row.width)
  return width
}
