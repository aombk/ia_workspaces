/**
 * The system panel, attached to an edge of the window rather than to a project.
 *
 * It was a tab, and a tab was wrong for the same reason the inbox stopped being
 * one: what it shows is a property of the machine and of your account, and
 * neither of those differs between two workspaces. Opening it meant opening it
 * *inside* a project it had nothing to do with, and switching project took it
 * away. Now it is docked, and it stays put.
 *
 * Docked rather than floating over the terminals, which is the other obvious
 * shape and the wrong one here. This is a thing you leave open while you work —
 * a panel you have to move out of the way to read the output it is explaining
 * would be closed within a day. It takes space, and the terminals get the rest.
 *
 * It attaches to the window's own edges rather than to the terminal area's: on
 * the left it sits outside the sidebar, and along the top it spans the full
 * width under the title bar. Which edge is a class on `#shell` and nothing
 * more — see the stylesheet for why all four sides are the same two elements
 * in the same order.
 *
 * The panel is never rebuilt when it moves. It is one `MonitorPane` for the
 * life of the window once opened, so moving it keeps its scroll position and
 * does not restart its poll — which on Windows is a process every few seconds.
 *
 * Two ways in besides the keyboard: the pull-tab on the right edge, and the
 * title bar you drag to move it. No row of dock-side icons — four glyphs is a
 * legend to learn, and dragging a panel to an edge is the gesture everybody
 * already has.
 */
import { MonitorPane } from '../monitorPane'
import { store } from '../state'
import type { MonitorDock } from '../../shared/types'

/**
 * How little of either side a drag may leave behind.
 *
 * 140 rather than 180: the blocks clip their figures rather than holding the
 * panel open, so the floor is now about what stays legible rather than about
 * what fits without cutting.
 */
const MIN_DOCK = 140
const MIN_REST = 320

let pane: MonitorPane | null = null
let body: HTMLElement | null = null

const shell = () => document.getElementById('shell') as HTMLElement
const handle = () => document.getElementById('monitor-handle') as HTMLElement
const dock = () => document.getElementById('monitor-dock') as HTMLElement
const resizer = () => document.getElementById('monitor-resizer') as HTMLElement

export function initMonitorDock(): void {
  wireResizer()
  handle().addEventListener('click', () => setDock(store.monitorDock === 'off' ? 'right' : 'off'))
  applyDock()
}

/** Off if it is showing, and back to where it was if it is not. */
export function toggleMonitorDock(): void {
  setDock(store.monitorDock === 'off' ? 'right' : 'off')
}

export function setMonitorDock(side: MonitorDock): void {
  setDock(side)
}

function setDock(side: MonitorDock): void {
  store.setMonitorDock(side)
  applyDock()
}

/**
 * Puts the panel where the document says, building it the first time only.
 *
 * The pane is made on the first open and kept for the life of the window, even
 * while hidden. Two reasons: it holds the history behind its graphs, which
 * would restart as a flat line every time the panel was closed and reopened;
 * and `watchSystem` is reference-counted, so a pane that is disposed and
 * remade stops and restarts the poll — which on Windows is a process.
 */
function applyDock(): void {
  const side = store.monitorDock
  const area = shell()

  area.classList.remove('shell--left', 'shell--right', 'shell--top', 'shell--bottom')

  if (side === 'off') {
    dock().hidden = true
    resizer().hidden = true
    handle().hidden = false
    // Deliberately not disposed. See above.
    return
  }

  area.classList.add(`shell--${side}`)
  // An arrow pointing at a panel already on screen is an arrow that means
  // nothing, so the tab goes away while the panel is up.
  handle().hidden = true
  dock().hidden = false
  resizer().hidden = false

  const vertical = side === 'top' || side === 'bottom'
  resizer().setAttribute('aria-orientation', vertical ? 'horizontal' : 'vertical')

  if (!pane) {
    pane = new MonitorPane('monitor-dock')
    dock().replaceChildren(header(), bodyElement(pane))
    renderHeader()
    wireDragging()
  }

  applySize()
  renderHeader()
}

function applySize(): void {
  const side = store.monitorDock
  if (side === 'off') return
  const size = `${Math.max(MIN_DOCK, store.monitorDockSize)}px`
  const el = dock()
  // Only the axis the dock is stacked along is fixed; the other follows the
  // window, which is why both are cleared rather than one being left behind
  // from the last side it was on.
  el.style.width = ''
  el.style.height = ''
  if (side === 'top' || side === 'bottom') el.style.height = size
  else el.style.width = size
}

// ---------------------------------------------------------------- header

function bodyElement(built: MonitorPane): HTMLElement {
  body = document.createElement('div')
  body.className = 'monitor-dock__body'
  body.appendChild(built.element)
  return body
}

let headEl: HTMLElement | null = null

function header(): HTMLElement {
  headEl = document.createElement('div')
  headEl.className = 'monitor-dock__head'
  return headEl
}

/**
 * The title bar: a name, and the way out.
 *
 * No side buttons. Four little icons is a row of glyphs nobody reads twice and
 * a legend to learn, when the gesture everybody already knows for "put this
 * panel over there" is to pick it up and drag it. So the bar itself is the
 * grip: press anywhere on it that is not the cross, move towards an edge, and
 * the edge lights up to say where it will land.
 */
function renderHeader(): void {
  const head = headEl
  if (!head) return
  head.replaceChildren()

  const title = document.createElement('span')
  title.className = 'monitor-dock__title'
  title.textContent = 'system monitor'
  title.title = 'Drag to move it to another edge'
  head.appendChild(title)

  const close = document.createElement('button')
  close.className = 'monitor-dock__btn'
  close.textContent = '✕'
  close.title = 'Close (Ctrl+Shift+M)'
  close.addEventListener('click', () => setDock('off'))
  head.appendChild(close)
}

// --------------------------------------------------------------- dragging

/**
 * Which edge a pointer at this position is asking for.
 *
 * Distance to each of the four edges, nearest wins — rather than quadrants or
 * a threshold, both of which have dead zones in the middle where a drag does
 * nothing and reads as the app having missed it. From anywhere in the window
 * there is always an answer, and near a corner it is whichever edge you are
 * genuinely closer to.
 */
function edgeFor(x: number, y: number): Exclude<MonitorDock, 'off'> {
  const area = shell().getBoundingClientRect()
  const distances: Array<[Exclude<MonitorDock, 'off'>, number]> = [
    ['left', x - area.left],
    ['right', area.right - x],
    ['top', y - area.top],
    ['bottom', area.bottom - y],
  ]
  distances.sort((a, b) => a[1] - b[1])
  return distances[0][0]
}

/**
 * Picking the panel up by its title bar.
 *
 * A few pixels of slop before anything happens, so a click on the bar — or a
 * slightly shaky press on the cross — is not a drag. Once it is a drag, the
 * target edge is painted as a band rather than the panel being moved live:
 * relocating it under the cursor on every mousemove would re-lay-out the whole
 * window several times a second, and the terminals would reflow with it.
 */
function wireDragging(): void {
  const head = headEl
  if (!head) return

  head.addEventListener('mousedown', (down) => {
    if ((down.target as HTMLElement).closest('button')) return
    if (down.button !== 0) return
    down.preventDefault()

    const startX = down.clientX
    const startY = down.clientY
    let dragging = false
    let target: Exclude<MonitorDock, 'off'> = store.monitorDock === 'off' ? 'right' : store.monitorDock

    const onMove = (move: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(move.clientX - startX) < 6 && Math.abs(move.clientY - startY) < 6) return
        dragging = true
        head.classList.add('dragging')
        document.body.classList.add('monitor-dragging')
      }
      target = edgeFor(move.clientX, move.clientY)
      ghost().className = `monitor-ghost monitor-ghost--${target}`
      ghost().hidden = false
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      head.classList.remove('dragging')
      document.body.classList.remove('monitor-dragging')
      ghost().hidden = true
      if (dragging) setDock(target)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
}

let ghostEl: HTMLElement | null = null

/** The band showing where a release would put it. Made once, on first drag. */
function ghost(): HTMLElement {
  if (!ghostEl) {
    ghostEl = document.createElement('div')
    ghostEl.className = 'monitor-ghost'
    ghostEl.hidden = true
    shell().appendChild(ghostEl)
  }
  return ghostEl
}

// -------------------------------------------------------------- resizing

/**
 * The grip, working on whichever axis the dock is stacked along.
 *
 * One handler for all four sides: the axis comes from the side, and the sign
 * comes from whether the dock is before or after the terminals — dragging the
 * handle right makes a left-docked panel bigger and a right-docked one smaller,
 * and getting that backwards is the sort of thing that reads as the app
 * fighting you.
 */
function wireResizer(): void {
  resizer().addEventListener('mousedown', (down) => {
    const side = store.monitorDock
    if (side === 'off') return
    down.preventDefault()
    resizer().classList.add('dragging')

    const vertical = side === 'top' || side === 'bottom'
    const towardsEnd = side === 'right' || side === 'bottom'
    const start = vertical ? down.clientY : down.clientX
    const startSize = vertical ? dock().offsetHeight : dock().offsetWidth
    const room = (vertical ? shell().clientHeight : shell().clientWidth) - MIN_REST
    let size = startSize

    const onMove = (move: MouseEvent) => {
      const delta = (vertical ? move.clientY : move.clientX) - start
      size = Math.max(MIN_DOCK, Math.min(Math.max(MIN_DOCK, room), startSize + (towardsEnd ? -delta : delta)))
      const el = dock()
      if (vertical) el.style.height = `${size}px`
      else el.style.width = `${size}px`
    }
    const onUp = () => {
      resizer().classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      store.setMonitorDock(store.monitorDock, size)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })

  // A drag that went badly wants one gesture back to sane, the way the git
  // pane's grip does.
  resizer().addEventListener('dblclick', () => {
    store.setMonitorDock(store.monitorDock, 300)
    applySize()
  })
}

/** True while the panel is on screen, for anything that wants to say so. */
export function monitorDockOpen(): boolean {
  return store.monitorDock !== 'off'
}

/** Kept so a hidden pane's element is reachable for tests and teardown. */
export function monitorDockBody(): HTMLElement | null {
  return body
}
