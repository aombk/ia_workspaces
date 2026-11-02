/**
 * The movement break: a screen over the whole window, an exercise, a countdown.
 *
 * Main decides when a break is owed — see `shared/moveBreaks.ts` — and every
 * window draws the same one from the state it is sent. Nothing here keeps time
 * of its own except to redraw the numbers: the countdown is measured from when
 * main says the break started, so two windows on two monitors agree to the
 * second.
 *
 * It covers the app and nothing else. The terminals and agents underneath keep
 * running; what stops is you using them. Three ways out: do the exercises until
 * the countdown ends, put it off once for five minutes, or type a sentence that
 * is deliberately tedious to type — with paste turned off, because a way out
 * that costs nothing is the way out that gets taken every time.
 */
import { backend } from '../../backend'
import { store } from '../state'
import { playSound } from '../sound'
import { BODY, exercise, HEAD_R, holdPaths, propPaths, type Exercise, type Joint, type Pose } from '../../shared/exercises'
import { currentExercise, SNOOZE_MIN, type BreakState } from '../../shared/moveBreaks'

/** What has to be typed to skip a break. Compared ignoring case, spacing and a final full stop. */
export const SKIP_SENTENCE = 'I do not want to get up and do this exercise and I take full responsibility for that'

let state: BreakState | null = null
let screen: HTMLElement | null = null
let figure: Figure | null = null
let ticker: ReturnType<typeof setInterval> | null = null
/** The break the skip box was opened for, so a new break starts with it closed. */
let skipping: string | null = null
/** What has been typed into the skip box, kept across redraws. */
let typed = ''
/** The break whose end has already been rung, so it rings once. */
let chimed: string | null = null

export function initBreaks(): void {
  const breaks = backend().breaks
  if (!breaks) return
  breaks.onChange((next) => apply(next))
  void breaks.state().then((first) => {
    if (first) apply(first)
  })
  // Keys meant for a terminal must not reach it while the screen is up. Caught
  // on the way down, before xterm's own listeners see them.
  for (const type of ['keydown', 'keypress', 'keyup', 'paste'] as const) {
    window.addEventListener(
      type,
      (e) => {
        if (!screen || screen.hidden) return
        if (e.target instanceof Node && screen.contains(e.target)) return
        e.stopPropagation()
        e.preventDefault()
      },
      true
    )
  }
  // The status-bar chip counts down in minutes, so once every half minute is plenty.
  setInterval(renderChip, 30_000)
}

function apply(next: BreakState): void {
  const before = state
  state = next
  renderChip()
  const changed =
    !before ||
    before.due?.id !== next.due?.id ||
    before.due?.posture !== next.due?.posture ||
    before.due?.startedAt !== next.due?.startedAt ||
    JSON.stringify(before.due?.choice) !== JSON.stringify(next.due?.choice)
  if (changed) render()
}

// ------------------------------------------------------------------ status chip

/** "Break in 12 min" in the status bar; click it to take one now. */
function renderChip(): void {
  const bar = document.getElementById('statusbar')
  if (!bar) return
  let chip = document.getElementById('status-break')
  if (!chip) {
    chip = document.createElement('button')
    chip.id = 'status-break'
    chip.className = 'status-break'
    chip.title = 'Time until the next movement break. Click to take one now.'
    chip.addEventListener('click', () => void backend().breaks?.now())
    bar.querySelector('.status-spacer')?.after(chip)
  }
  const s = state
  if (!s || !s.settings.enabled || s.due) {
    chip.hidden = true
    return
  }
  const now = Date.now()
  let text = ''
  if (s.waiting) text = 'Break at your next pause'
  else if (s.snoozedUntil) text = `Break in ${Math.max(1, Math.ceil((s.snoozedUntil - now) / 60_000))} min`
  else if (s.sittingSince !== null) {
    const left = s.sittingSince + s.settings.everyMin * 60_000 - now
    text = left <= 0 ? 'Break due' : `Break in ${Math.ceil(left / 60_000)} min`
  }
  chip.hidden = !text
  chip.textContent = text
  chip.classList.toggle('soon', Boolean(s.sittingSince !== null && s.sittingSince + s.settings.everyMin * 60_000 - now < 3 * 60_000))
}

// --------------------------------------------------------------------- screen

function render(): void {
  const due = state?.due
  if (!due) {
    if (screen) screen.hidden = true
    figure?.stop()
    if (ticker) clearInterval(ticker)
    ticker = null
    skipping = null
    typed = ''
    return
  }
  if (!screen) {
    screen = document.createElement('div')
    screen.id = 'break-screen'
    screen.className = 'break-screen'
    screen.setAttribute('role', 'dialog')
    screen.setAttribute('aria-modal', 'true')
    document.body.appendChild(screen)
  }
  if (skipping !== due.id) {
    skipping = null
    typed = ''
  }
  screen.hidden = false
  // Whatever had the keyboard — a terminal, a browser pane — loses it.
  if (document.activeElement instanceof HTMLElement && !screen.contains(document.activeElement)) {
    document.activeElement.blur()
  }

  const card = el('div', 'break-card')
  card.append(...running())
  if (skipping === due.id) card.appendChild(skipBox())
  screen.replaceChildren(card)

  if (ticker) clearInterval(ticker)
  ticker = setInterval(updateRunning, 250)
  updateRunning()
}

/** The exercise on offer, drawn, named and explained. */
function offer(): HTMLElement[] {
  const due = state!.due!
  const current = exercise(currentExercise(due) ?? '')
  const name = el('h2', 'break-title', current?.name ?? '')
  name.id = 'break-name'
  const art = el('div', 'break-art')
  figure = figure ?? new Figure()
  if (current) figure.show(current)
  art.appendChild(figure.svg)
  const how = el('p', 'break-how', current?.how ?? '')
  how.id = 'break-how'
  return [name, art, how]
}

/** "Another exercise", when there is another to offer. */
function anotherButton(): HTMLElement | null {
  const due = state!.due!
  if (due[due.posture].length < 2) return null
  const button = el('button', 'btn break-big break-secondary', 'Another exercise')
  button.addEventListener('click', () => void backend().breaks?.another())
  return button
}

/**
 * The break, already counting down: the exercise, the clock, and what you can
 * do about it — another exercise, a seated one, later, or not at all.
 */
function running(): HTMLElement[] {
  const due = state!.due!
  const seated = due.posture === 'seated'
  const title = el('div', 'break-step', 'Time to get up')
  title.id = 'break-step'
  const clock = el('div', 'break-clock')
  clock.id = 'break-clock'
  const choices = el('div', 'break-choices')
  const done = el('button', 'btn break-big break-primary', 'Done \u2014 back to work')
  done.id = 'break-done'
  done.hidden = true
  done.addEventListener('click', () => void backend().breaks?.finish(state?.due?.posture === 'seated' ? 'seated' : 'done'))
  choices.appendChild(done)
  const other = anotherButton()
  if (other) {
    other.id = 'break-another'
    choices.appendChild(other)
  }
  const swap = el('button', 'break-link', seated ? 'I can get up \u2014 show a standing one' : 'I can\u2019t get up \u2014 show a seated one')
  swap.id = 'break-swap'
  swap.addEventListener('click', () => void backend().breaks?.lean(seated ? 'standing' : 'seated'))
  return [title, ...offer(), clock, choices, swap, outs(due.snoozed)]
}

/** The two ways out that are not doing it. */
function outs(snoozed: boolean): HTMLElement {
  const row = el('div', 'break-outs')
  row.id = 'break-outs'
  if (!snoozed) {
    const later = el('button', 'break-link', `Not now — in ${SNOOZE_MIN} minutes`)
    later.title = 'Once per break.'
    later.addEventListener('click', () => void backend().breaks?.snooze())
    row.appendChild(later)
  }
  if (skipping !== state?.due?.id) {
    const skip = el('button', 'break-link', 'Skip this break…')
    skip.addEventListener('click', () => {
      skipping = state?.due?.id ?? null
      render()
      document.getElementById('break-skip-input')?.focus()
    })
    row.appendChild(skip)
  }
  return row
}

function skipBox(): HTMLElement {
  const box = el('div', 'break-skip')
  box.appendChild(el('p', 'break-skip-say', 'To skip, type this — no pasting:'))
  box.appendChild(el('p', 'break-skip-sentence', SKIP_SENTENCE))
  const input = el('textarea', 'break-skip-input')
  input.id = 'break-skip-input'
  input.rows = 2
  input.spellcheck = false
  input.value = typed
  const unlock = el('button', 'btn', 'Skip the break')
  unlock.disabled = !matches(typed)
  input.addEventListener('input', () => {
    typed = input.value
    unlock.disabled = !matches(typed)
  })
  // Typed, not pasted or dropped: that is the whole of the cost.
  for (const type of ['paste', 'drop'] as const) input.addEventListener(type, (e) => e.preventDefault())
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (matches(typed)) void backend().breaks?.finish('skipped')
    }
  })
  unlock.addEventListener('click', () => void backend().breaks?.finish('skipped'))
  box.append(input, unlock)
  return box
}

function matches(text: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '')
  return norm(text) === norm(SKIP_SENTENCE)
}

/** The parts of the running screen that change by the second. */
function updateRunning(): void {
  const due = state?.due
  if (!due || !state) return
  const left = Math.max(0, state.settings.breakMin * 60_000 - (Date.now() - due.startedAt))
  const finished = left === 0
  const current = exercise(currentExercise(due) ?? '')
  setText('break-name', finished ? 'Welcome back' : (current?.name ?? ''))
  setText('break-how', finished ? 'Sit down, take a breath, carry on.' : (current?.how ?? ''))
  setText('break-clock', finished ? '0:00' : clockText(left))
  const done = document.getElementById('break-done')
  if (done) done.hidden = !finished
  if (finished) chime(due.id)
  const another = document.getElementById('break-another')
  if (another) another.hidden = finished
  // Over: putting it off or skipping it means nothing any more.
  for (const id of ['break-swap', 'break-outs', 'break-step']) {
    const node = document.getElementById(id)
    if (node) node.hidden = finished
  }
  if (finished) figure?.stop()
}

/**
 * The countdown is over: you are probably across the room, not looking at the
 * screen, so it is said out loud. The notification sound at its volume —
 * the one sound you have already chosen to hear from this app — and from the
 * main window only, or every open window would ring at once.
 */
function chime(id: string): void {
  if (chimed === id) return
  chimed = id
  if (store.windowId !== 'main' || store.settings.moveSound === false) return
  const n = store.settings.notifications
  playSound(n.soundName, n.volume)
}

function setText(id: string, text: string): void {
  const node = document.getElementById(id)
  if (node && node.textContent !== text) node.textContent = text
}

function clockText(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// --------------------------------------------------------------------- figure

const SVG = 'http://www.w3.org/2000/svg'

/** A figure that moves through an exercise's poses, for as long as it is on screen. See `BODY`. */
class Figure {
  readonly svg: SVGSVGElement
  private readonly props: SVGGElement
  /** What the figure holds: a band, weights, a rope. Drawn over it. */
  private readonly holds: SVGGElement
  private readonly lines: SVGLineElement[] = []
  private readonly head: SVGCircleElement
  private current: Exercise | null = null
  private started = 0
  private frame = 0

  constructor() {
    this.svg = document.createElementNS(SVG, 'svg')
    this.svg.setAttribute('viewBox', '0 0 200 200')
    this.svg.classList.add('break-figure')
    const floor = document.createElementNS(SVG, 'line')
    floor.setAttribute('x1', '20')
    floor.setAttribute('x2', '180')
    floor.setAttribute('y1', '187')
    floor.setAttribute('y2', '187')
    floor.classList.add('break-floor')
    this.props = document.createElementNS(SVG, 'g')
    this.props.classList.add('break-props')
    this.svg.append(floor, this.props)
    for (const { side, width } of BODY) {
      const line = document.createElementNS(SVG, 'line')
      line.classList.add('break-bone', `side-${side}`)
      line.setAttribute('stroke-width', String(width))
      this.lines.push(line)
      this.svg.appendChild(line)
    }
    this.head = document.createElementNS(SVG, 'circle')
    this.head.setAttribute('r', String(HEAD_R))
    this.head.classList.add('break-head')
    this.svg.appendChild(this.head)
    this.holds = document.createElementNS(SVG, 'g')
    this.holds.classList.add('break-holds')
    this.svg.appendChild(this.holds)
  }

  show(next: Exercise): void {
    if (this.current?.id !== next.id) {
      this.current = next
      this.started = performance.now()
      this.drawProps(next)
      // Side views overlap the two sides, so the far one is drawn fainter.
      const first = next.poses[0]
      const side = first.lSh[0] === first.rSh[0] && first.lSh[1] === first.rSh[1]
      this.svg.classList.toggle('side-view', side)
      // Drawn at once in its first pose: a window in the background gets no
      // animation frames, and it should still show the exercise rather than
      // an empty box until it is looked at.
      this.draw(next.poses[0], next.poses[0], 0)
    }
    if (!this.frame) this.frame = requestAnimationFrame(this.step)
  }

  stop(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    this.frame = 0
  }

  private readonly step = (now: number): void => {
    this.frame = 0
    const ex = this.current
    if (!ex || !this.svg.isConnected) return
    const poses = ex.poses
    // Clamped: a frame's timestamp is when the frame began, which can be a
    // moment before `show` read the clock — and a negative time picked pose -1,
    // threw, and left the figure frozen until something else restarted it.
    const t = Math.max(0, now - this.started) / ex.beat
    const i = Math.floor(t) % poses.length
    const from = poses[i]
    const to = poses[(i + 1) % poses.length]
    // Eased, so the figure pauses at each end of a movement as a person does.
    const k = (1 - Math.cos((t - Math.floor(t)) * Math.PI)) / 2
    this.draw(from, to, k)
    this.frame = requestAnimationFrame(this.step)
  }

  private draw(from: Pose, to: Pose, k: number): void {
    const at = (joint: Joint): [number, number] => [
      from[joint][0] + (to[joint][0] - from[joint][0]) * k,
      from[joint][1] + (to[joint][1] - from[joint][1]) * k,
    ]
    BODY.forEach(({ from: a, to: b }, n) => {
      const [x1, y1] = at(a)
      const [x2, y2] = at(b)
      const line = this.lines[n]
      line.setAttribute('x1', x1.toFixed(1))
      line.setAttribute('y1', y1.toFixed(1))
      line.setAttribute('x2', x2.toFixed(1))
      line.setAttribute('y2', y2.toFixed(1))
    })
    const [hx, hy] = at('head')
    this.head.setAttribute('cx', hx.toFixed(1))
    this.head.setAttribute('cy', hy.toFixed(1))

    const shapes = holdPaths(this.current?.hold, at)
    while (this.holds.childNodes.length < shapes.length) this.holds.appendChild(document.createElementNS(SVG, 'path'))
    while (this.holds.childNodes.length > shapes.length) this.holds.lastChild!.remove()
    shapes.forEach((d, n) => (this.holds.childNodes[n] as SVGPathElement).setAttribute('d', d))
    this.holds.setAttribute('class', `break-holds hold-${this.current?.hold ?? 'none'}`)
  }

  private drawProps(ex: Exercise): void {
    const paths = propPaths(ex.prop).map((d) => {
      const path = document.createElementNS(SVG, 'path')
      path.setAttribute('d', d)
      return path
    })
    if (ex.prop === 'gaze') {
      const gaze = document.createElementNS(SVG, 'path')
      gaze.setAttribute('d', 'M110 44 L190 30')
      gaze.classList.add('break-gaze')
      paths.push(gaze)
    }
    this.props.replaceChildren(...paths)
  }
}
