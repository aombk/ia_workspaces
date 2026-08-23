/**
 * The wheel, for the panes where a program is reading it rather than the pane.
 *
 * Its own file because it is the one piece of `terminals.ts` that can be run
 * without a workspace, a PTY or a layout — a terminal, an element and a wheel
 * event are the whole of its world — and because what it is compensating for
 * is a detail of xterm's that wants stating in one place rather than in the
 * middle of pane bookkeeping.
 */
import type { Terminal } from '@xterm/xterm'

/**
 * How far a wheel moves the pane's own scrollback, per pixel of wheel.
 *
 * Not ours: it is what xterm's viewport does, 50 pixels of scroll per 40
 * pixels of wheel. Written down because `programWheelDriver` has to match it —
 * the point of the whole file is that the two agree.
 */
const VIEWPORT_PIXELS_PER_WHEEL_PIXEL = 50 / 40

/**
 * The delta a wheel event we make up carries.
 *
 * It only has to clear the two gates xterm puts in front of a wheel before it
 * will report it: a delta under 50 pixels is damped to 30%, and what survives
 * has to come to at least one whole line after being divided by the cell
 * height. 100 pixels clears both at any font size anyone can read.
 */
const SYNTHETIC_WHEEL_DELTA = 100

/**
 * The most one wheel event may move: a screen.
 *
 * A ceiling in case a device reports something absurd, and the pane's own
 * height is the honest one — a page-mode wheel means exactly one screen, and a
 * fixed number would either clip that on a tall pane or fail to bound anything
 * on a short one.
 */
function maxLines(rows: number): number {
  return Math.max(1, rows)
}

/**
 * Lines one detent of a physical wheel moves.
 *
 * Three, which is what Terminal.app and iTerm2 settled on and what the TUIs
 * were written against. A constant rather than a measurement, and that is the
 * entire point of it — see `classifyWheel`.
 */
const LINES_PER_NOTCH = 3

/**
 * How long a gap ends a gesture, in milliseconds.
 *
 * Long enough to span the pause between two deliberate notches, short enough
 * that putting the mouse down and picking the trackpad up is judged afresh
 * rather than against what the other device was doing.
 */
const GESTURE_GAP_MS = 400

/**
 * What the classifier remembers between events.
 *
 * Passed in and handed back rather than kept in a closure, so the judgement is
 * a pure function of the events and can be tested as one.
 */
export interface WheelMemory {
  /** Recent verdicts, newest last. 0 is certainly a wheel, 1 certainly a surface. */
  readonly scores: readonly number[]
  readonly lastX: number
  readonly lastY: number
  readonly at: number
}

export const NO_WHEEL_MEMORY: WheelMemory = { scores: [], lastX: 0, lastY: 0, at: 0 }

/** Within a hundredth, which is as near an integer as a real delta ever lands. */
function isAlmostInt(value: number): boolean {
  return Math.abs(Math.round(value) - value) < 0.01
}

/**
 * Whether the wheel being turned is a wheel, or a surface being stroked.
 *
 * The distinction matters because macOS accelerates a mouse wheel and does not
 * tell anybody it has: the same detent arrives as four pixels when you turn it
 * slowly and as a hundred and twenty when you keep turning. Measuring that
 * faithfully — which is what this file did, and what makes a trackpad feel
 * right — reproduces the acceleration on top of a wheel that already has
 * detents, so the first few notches move nothing and the ones after move half
 * a screen. Measure a surface; count a wheel.
 *
 * The test is the one from VS Code's scrollable element, which xterm vendors a
 * copy of and uses for the same question. Three signals, scored rather than
 * decided, because any one of them is wrong sometimes:
 *
 * - Both axes moving at once is a surface. A wheel has one axis.
 * - Fractional deltas are a surface. A wheel's are whole numbers.
 * - Deltas that divide into one another are a wheel: two detents of the same
 *   size, or one exactly twice another, is a thing with notches. A finger
 *   produces no such arithmetic.
 *
 * The verdict weights recent events most, so a device that has just been
 * picked up is believed over one put down five events ago.
 */
export function classifyWheel(
  e: { deltaX: number; deltaY: number },
  now: number,
  memory: WheelMemory
): { physical: boolean; memory: WheelMemory } {
  const fresh = now - memory.at > GESTURE_GAP_MS
  const previous = fresh ? null : memory

  let score: number
  if (Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) > 0) {
    score = 1
  } else {
    score = 0.5
    if (!isAlmostInt(e.deltaX) || !isAlmostInt(e.deltaY)) score += 0.25
    if (previous) {
      // Min 1 so nothing divides by zero; a zero axis leaves no remainder
      // either way, which is the right answer for a wheel turned straight.
      const minX = Math.max(Math.min(Math.abs(e.deltaX), Math.abs(previous.lastX)), 1)
      const minY = Math.max(Math.min(Math.abs(e.deltaY), Math.abs(previous.lastY)), 1)
      const maxX = Math.max(Math.abs(e.deltaX), Math.abs(previous.lastX))
      const maxY = Math.max(Math.abs(e.deltaY), Math.abs(previous.lastY))
      if (maxX % minX === 0 && maxY % minY === 0) score -= 0.5
    }
    score = Math.min(Math.max(score, 0), 1)
  }

  const scores = [...(fresh ? [] : memory.scores), score].slice(-5)

  // 0.5 of the newest, 0.25 of the one before, and so on, with whatever
  // influence is left over going to the oldest so the weights come to one.
  let remaining = 1
  let verdict = 0
  for (let i = scores.length - 1; i >= 0; i--) {
    const influence = i === 0 ? remaining : Math.pow(2, -(scores.length - i))
    remaining -= influence
    verdict += scores[i] * influence
  }

  return { physical: verdict <= 0.5, memory: { scores, lastX: e.deltaX, lastY: e.deltaY, at: now } }
}

/** Wheel events this file made up, so the handler can tell them from real ones. */
const SYNTHETIC_WHEEL = new WeakSet<WheelEvent>()

/**
 * Gives a program as many wheel events as the wheel actually turned.
 *
 * A full-screen program — Claude Code, vim, less — takes the alternate screen
 * and usually the mouse with it, and from then on xterm stops scrolling its
 * viewport and hands the wheel to the program instead. It hands over **one**
 * event per wheel event, always: it works out how many lines the wheel came to
 * and then uses that number only to decide whether to send anything at all.
 * One notch in, one wheel report out, and the program moves its one line.
 *
 * That is the whole of the "scrolling is slow in Claude Code" bug, and it is
 * worse on a Mac for a second reason on top: xterm damps any wheel delta under
 * 50 pixels to 30% before that zero check, and on macOS *every* wheel event is
 * under 50 — not just trackpads but mice, because Chromium reports macOS
 * wheels in real scroll units where a Windows notch is a flat 100. So a Mac
 * mouse spent two notches in three below the threshold and sent nothing.
 *
 * Every real terminal sends several reports per notch — three is the number
 * Terminal.app and iTerm2 settled on, and it is what TUIs are written
 * expecting. So this measures the gesture the way the pane's own viewport
 * would, in pixels, divides by the cell to get lines, and dispatches that many
 * wheel events at xterm. They are ordinary events as far as xterm is
 * concerned: it encodes and reports each one, in whichever mouse protocol the
 * program asked for, and this file never has to know what that protocol was.
 *
 * Measuring rather than picking a constant is what keeps a pane consistent
 * with itself — the same flick covers the same ground whether Claude Code or
 * the scrollback is reading it, at any font size, on any pointing device. The
 * fraction left over is carried, so a trackpad's stream of tiny deltas adds up
 * instead of rounding away to nothing.
 */
export function wheelTicks(
  e: { deltaY: number; deltaMode: number },
  cell: number,
  rows: number,
  carry: number,
  notch = 0
): { ticks: number; carry: number } {
  // A detent, counted rather than measured. Nothing is carried: a notch is a
  // whole event on its own, and a remainder from one could only arrive as a
  // stray extra line during the next.
  if (notch > 0 && e.deltaY !== 0) {
    return { ticks: e.deltaY < 0 ? -notch : notch, carry: 0 }
  }

  const lines =
    e.deltaMode === 2 /* page */
      ? e.deltaY * rows
      : e.deltaMode === 1 /* line */
        ? e.deltaY
        : (e.deltaY * VIEWPORT_PIXELS_PER_WHEEL_PIXEL) / cell

  const total = lines + carry
  const whole = Math.trunc(total)
  // The remainder rides along to the next event, which is the whole reason a
  // trackpad works at all: six pixels is a third of a line, and three of them
  // should move the screen once rather than never.
  const rest = total - whole
  const max = maxLines(rows)
  if (Math.abs(whole) <= max) return { ticks: whole, carry: rest }
  return { ticks: whole < 0 ? -max : max, carry: rest }
}

/** Wires `wheelTicks` to one pane's terminal. See the note above. */
export function programWheelDriver(
  term: Terminal,
  element: HTMLElement,
  /**
   * Whether this platform accelerates a mouse wheel behind the app's back.
   *
   * macOS does and nothing else does, which is why this is a parameter rather
   * than a check: on Windows a detent is a flat hundred pixels every time, so
   * measuring it is already right and counting it instead would throw away a
   * calibration that works.
   */
  accelerates = false,
  now: () => number = () => Date.now()
): (e: WheelEvent) => boolean {
  let carry = 0
  let memory = NO_WHEEL_MEMORY

  return (e) => {
    // Ours, coming back around. This is the one that xterm should handle.
    if (SYNTHETIC_WHEEL.has(e)) return true

    const judged = classifyWheel(e, now(), memory)
    memory = judged.memory
    // Zero unless this is a wheel with detents on a platform that accelerates
    // it, in which case it is how many lines one detent means.
    const notch = accelerates && judged.physical ? LINES_PER_NOTCH : 0

    // Exactly the two states where xterm reports rather than scrolls. `x10` is
    // excluded because it reports button presses only — a wheel under x10
    // still scrolls the viewport, which needs no help.
    const tracking = term.modes.mouseTrackingMode
    const toProgram =
      (tracking !== 'none' && tracking !== 'x10') || term.buffer.active.type === 'alternate'

    if (e.deltaY === 0) {
      carry = 0
      return true
    }

    // The scrollback has the same problem for the same reason — xterm measures
    // the wheel in pixels too — and it is the same pane. A notch covering three
    // lines of Claude Code and eleven of the scrollback above it would be one
    // pane behaving as two.
    if (!toProgram) {
      if (notch === 0) {
        carry = 0
        return true
      }
      e.preventDefault()
      term.scrollLines(e.deltaY < 0 ? -notch : notch)
      return false
    }

    // Measured per event, not remembered: it moves with the font size, the
    // line height and the pane's zoom. The screen element's height is settled
    // long before anyone reaches for the wheel, so reading it here is free.
    const screen = element.querySelector('.xterm-screen')
    const cell = screen instanceof HTMLElement && term.rows > 0 ? screen.clientHeight / term.rows : 0
    if (cell <= 0) return true

    const { ticks, carry: rest } = wheelTicks(e, cell, term.rows, carry, notch)
    carry = rest

    // Swallowed rather than passed on: the wheel has not come to a line yet,
    // and letting xterm send its own report here would put the tiny deltas
    // back on the screen at one line each, which is the behaviour being fixed.
    e.preventDefault()
    if (ticks === 0) return false

    // Dispatched at xterm's own element, where both of its wheel listeners
    // live. Not at the event's target: the viewport sits *inside* that element
    // and would scroll on the way past.
    const target = element.querySelector('.xterm') ?? element
    const delta = ticks < 0 ? -SYNTHETIC_WHEEL_DELTA : SYNTHETIC_WHEEL_DELTA
    for (let i = 0; i < Math.abs(ticks); i++) {
      const tick = new WheelEvent('wheel', {
        deltaY: delta,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        clientX: e.clientX,
        clientY: e.clientY,
        // Never bubbles: this is for xterm, not for the app around it.
        bubbles: false,
        cancelable: true,
      })
      SYNTHETIC_WHEEL.add(tick)
      target.dispatchEvent(tick)
    }
    return false
  }
}
