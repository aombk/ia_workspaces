/**
 * A small line graph, as SVG.
 *
 * SVG rather than canvas, for three reasons that all turned out to matter: it
 * takes its colours from CSS, so the graphs follow a theme change without this
 * file knowing any themes exist; it scales with the element instead of needing
 * to be redrawn at the device pixel ratio when a window moves between monitors;
 * and a pane holding a dozen of these costs a dozen DOM nodes rather than a
 * dozen 2D contexts.
 *
 * `preserveAspectRatio="none"` with a fixed viewBox is what lets one drawing
 * stretch to whatever width the layout gives it — the graph is a shape, and the
 * pane decides how wide a shape it wants.
 */

const WIDTH = 100
const HEIGHT = 30
const SVG = 'http://www.w3.org/2000/svg'

/**
 * How many samples fit across a graph, whatever it is drawing.
 *
 * Fixed, and that is the whole point. Spreading however many samples exist
 * across the full width means every sample is a different width from one
 * minute to the next: the line compresses as history accumulates, so a spike
 * two minutes old is drawn narrower than the same spike was when it happened,
 * and nothing can be compared with anything. A fixed grid gives every sample
 * the same width for ever — new readings enter at the right and the whole line
 * marches left, which is what every monitor worth reading does.
 *
 * 120 at the pane's two-second poll is four minutes across, which is long
 * enough to see a build start and finish.
 */
const SLOTS = 120

/**
 * Where a sample sits, counting back from the right edge.
 *
 * `index` is its position in the array and `count` how many there are, so the
 * newest is always hard against the right and a graph with six samples in it
 * draws six samples' worth of line rather than stretching them across.
 */
function slotX(index: number, count: number): number {
  const step = WIDTH / (SLOTS - 1)
  return WIDTH - (count - 1 - index) * step
}

export interface SparklineOptions {
  /**
   * The value the top of the graph means.
   *
   * Fixed at 100 for anything that is a percentage, so a quiet CPU draws a flat
   * line near the floor. Left out for rates, where the ceiling is whatever the
   * window's own peak is — a network graph auto-scaled to its own maximum is
   * the only kind that shows anything at all, since the alternative is scaling
   * to the interface's theoretical speed and drawing a flat zero for ever.
   */
  max?: number
  /** Drawn under the line. Off for the paired up/down graphs, which overlap. */
  fill?: boolean
  className?: string
}

/**
 * `values` may hold nulls, and they are gaps rather than zeroes.
 *
 * A failed sample is not a quiet moment, and drawing it as one puts a canyon in
 * the graph at exactly the point where something went wrong — which is the
 * shape people read as "the machine stopped", rather than "we stopped looking".
 */
export function sparkline(values: Array<number | null>, opts: SparklineOptions = {}): SVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', `spark ${opts.className ?? ''}`.trim())
  svg.setAttribute('aria-hidden', 'true')

  const points = values.filter((v): v is number => v !== null)
  if (points.length < 2) return svg

  // A ceiling of zero would divide by nothing; a graph of an idle interface is
  // a flat line at the bottom, which is the honest picture of an idle
  // interface.
  const ceiling = opts.max ?? Math.max(...points, 1)
  const scale = ceiling > 0 ? ceiling : 1

  // Only what fits, newest first: anything older than the window has scrolled
  // off the left and is not drawn squeezed in beside what is current.
  const shown = values.length > SLOTS ? values.slice(values.length - SLOTS) : values
  values = shown
  const x = (index: number) => slotX(index, shown.length)
  const y = (value: number) => HEIGHT - (Math.max(0, Math.min(scale, value)) / scale) * HEIGHT

  // One path per unbroken run, so a gap is a gap and not a line across it.
  let run: string[] = []
  const runs: string[][] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length) runs.push(run)
      run = []
      return
    }
    run.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`)
  })
  if (run.length) runs.push(run)

  for (const segment of runs) {
    if (segment.length < 2) continue

    if (opts.fill) {
      const area = document.createElementNS(SVG, 'path')
      const first = segment[0].split(',')[0]
      const last = segment[segment.length - 1].split(',')[0]
      area.setAttribute(
        'd',
        `M${first},${HEIGHT} L${segment.join(' L')} L${last},${HEIGHT} Z`
      )
      area.setAttribute('class', 'spark__area')
      svg.appendChild(area)
    }

    const line = document.createElementNS(SVG, 'polyline')
    line.setAttribute('points', segment.join(' '))
    line.setAttribute('class', 'spark__line')
    svg.appendChild(line)
  }

  return svg
}

/**
 * One series drawn over another, on one set of axes.
 *
 * The shape the Rainmeter skin this borrows from uses everywhere: its
 * `GraphStyle` sets `LineColor`, `LineColor2` and `LineColor3` on a single
 * meter, so processor load, temperature and memory share a trough and are told
 * apart by colour. That is worth copying for the reason it works there — the
 * interesting thing about load and temperature is the *lag* between them, and a
 * lag is invisible when the two are stacked in separate boxes.
 *
 * Each series keeps its own ceiling. They have to: a percentage and a
 * temperature in Celsius share no scale, and normalising them against a common
 * maximum would flatten whichever one happens to be smaller into the floor. So
 * what is being compared here is *shape*, not height, which is the honest thing
 * to compare between a percentage and a temperature anyway.
 */
export interface SparkSeries {
  values: Array<number | null>
  /** The class that colours it — `spark__line--a`, `--b`, `--c`. */
  className: string
  /** The value the top of the graph means, for this series alone. */
  max?: number
}

export function sparklines(series: readonly SparkSeries[], opts: { className?: string } = {}): SVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', `spark spark--stacked ${opts.className ?? ''}`.trim())
  svg.setAttribute('aria-hidden', 'true')

  for (const line of series) {
    const points = line.values.filter((v): v is number => v !== null)
    if (points.length < 2) continue

    const ceiling = line.max ?? Math.max(...points, 1)
    const scale = ceiling > 0 ? ceiling : 1
    const shown = line.values.length > SLOTS ? line.values.slice(line.values.length - SLOTS) : line.values
    const x = (index: number) => slotX(index, shown.length)
    const y = (value: number) => HEIGHT - (Math.max(0, Math.min(scale, value)) / scale) * HEIGHT

    // Gaps stay gaps here too — a sample that failed is not a quiet moment, and
    // with three lines on one graph a canyon in one of them is even easier to
    // read as the machine having done something.
    let run: string[] = []
    const runs: string[][] = []
    shown.forEach((value, index) => {
      if (value === null) {
        if (run.length) runs.push(run)
        run = []
        return
      }
      run.push(`${x(index).toFixed(2)},${y(value).toFixed(2)}`)
    })
    if (run.length) runs.push(run)

    for (const segment of runs) {
      if (segment.length < 2) continue
      const path = document.createElementNS(SVG, 'polyline')
      path.setAttribute('points', segment.join(' '))
      path.setAttribute('class', `spark__line ${line.className}`)
      svg.appendChild(path)
    }
  }

  return svg
}
