/**
 * The wheel, for the panes where a program is reading it rather than the pane.
 *
 * Its own file because it is the one piece of `terminals.ts` that can be run
 * without a workspace, a PTY or a layout — a terminal, an element and a wheel
 * event are the whole of its world — and because what it is compensating for
 * is a detail of xterm's that wants stating in one place rather than in the
 * middle of pane bookkeeping.
 *
 * ## Why there is no longer a device classifier here
 *
 * There was one, and it is worth saying plainly why it went, because the idea
 * is tempting enough to be reinvented.
 *
 * It tried to tell a mouse from a trackpad by the arithmetic of the deltas —
 * whole numbers and even division meaning notches, fractions and two-axis
 * movement meaning a finger. The signal is not there. A finger moved *straight*
 * down the pad produces `deltaX === 0`, which makes the divisibility test
 * vacuously true on the X axis, and a smooth acceleration ramp (1, 2, 4, 8)
 * divides evenly on the Y axis — so an ordinary trackpad stroke was judged a
 * mouse whenever macOS happened to emit integers, and judged a finger when the
 * same stroke landed on fractions. The two verdicts moved the screen by three
 * lines and by a twentieth of a line respectively, which is why scrolling felt
 * like two different devices sharing one pane.
 *
 * So: no guessing at the hardware. What this measures instead is the *shape of
 * the gesture*, which is a thing the events actually carry — a continuous
 * stroke arrives as an unbroken stream, and a detent arrives as a burst with
 * silence on either side. That distinction needs no knowledge of what is under
 * the user's hand, and it is the same on every platform.
 */
import type { Terminal } from '@xterm/xterm'

/**
 * How far a wheel moves the pane's own scrollback, per pixel of wheel.
 *
 * Not ours: it is what xterm's viewport does, 50 pixels of scroll per 40
 * pixels of wheel. Written down because the program path has to match it — a
 * flick should cover the same ground whether Claude Code or the scrollback
 * above it is the thing reading the wheel.
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
 * The silence that separates one gesture from the next, in milliseconds.
 *
 * The one number in this file that decides anything, so it is worth being
 * precise about what it is measuring. A finger on a trackpad produces events
 * continuously while it moves — every 8ms or so, the display's own cadence —
 * and so counts as a single gesture from the moment it lands to the moment the
 * momentum dies. A mouse detent produces a short burst and then nothing until
 * the wheel is turned again, which even at a fast ten notches a second leaves
 * gaps far wider than this.
 *
 * 120ms is comfortably above the frame-to-frame gap of a continuous stroke and
 * comfortably below the notch-to-notch gap of a wheel being turned, so nothing
 * has to know which one it is looking at.
 */
const BURST_GAP_MS = 120

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
 * That is the original "scrolling is slow in Claude Code" bug. This measures
 * the gesture the way the pane's own viewport would, in pixels, divides by the
 * cell to get lines, and dispatches that many wheel events at xterm. They are
 * ordinary events as far as xterm is concerned: it encodes and reports each
 * one, in whichever mouse protocol the program asked for, and this file never
 * has to know what that protocol was.
 *
 * Three rules, and between them they cover every device without identifying
 * any of them:
 *
 * 1. **Measure, and carry the remainder.** Six pixels is a third of a line, and
 *    three of those should move the screen once rather than never. This is what
 *    makes a trackpad feel like a trackpad.
 *
 * 2. **A reversal is a new gesture, not a debt.** Carry left over from scrolling
 *    down is meaningless to a stroke going up, and applying it there costs the
 *    first line of travel and leaves the pane feeling stuck against the
 *    direction you just came from. Sign change drops it.
 *
 * 3. **The first event of a burst always moves at least one line.** macOS
 *    reports a mouse detent as about four pixels when the wheel is turned
 *    slowly — a quarter of a line, so three detents in a row would move nothing
 *    at all while the carry filled up. A stroke is one long burst, so this fires
 *    once at the start of it and is invisible; a wheel is a burst per detent, so
 *    every detent lands. This is the whole of the mouse fix, and it needs to
 *    know nothing about mice.
 */
export function wheelTicks(
  e: { deltaY: number; deltaMode: number },
  cell: number,
  rows: number,
  carry: number,
  /** Whether this event opens a gesture — see rule 3 and `BURST_GAP_MS`. */
  startOfBurst = false
): { ticks: number; carry: number } {
  const lines =
    e.deltaMode === 2 /* page */
      ? e.deltaY * rows
      : e.deltaMode === 1 /* line */
        ? e.deltaY
        : (e.deltaY * VIEWPORT_PIXELS_PER_WHEEL_PIXEL) / cell

  if (lines === 0) return { ticks: 0, carry }

  // Rule 2. `Math.sign(0)` is 0 and never matches, which is the right answer
  // for an empty carry as well as for an opposing one.
  const held = Math.sign(carry) === Math.sign(lines) ? carry : 0

  const total = lines + held
  let whole = Math.trunc(total)
  let rest = total - whole

  // Rule 3. Nothing is carried out of a floored event: the gesture has been
  // paid a line it did not quite earn, and letting the remainder ride would
  // hand the next event a stray one on top.
  if (whole === 0 && startOfBurst) {
    whole = lines < 0 ? -1 : 1
    rest = 0
  }

  const max = maxLines(rows)
  const capped = Math.abs(whole) > max ? (whole < 0 ? -max : max) : whole
  // `Math.trunc` of a small negative is `-0`, which is a different value from
  // `0` to anything using `Object.is` — a test, a `Map` key, a strict compare.
  // It never means anything different here, so it never leaves here.
  return { ticks: capped === 0 ? 0 : capped, carry: rest }
}

/** Wires `wheelTicks` to one pane's terminal. See the note above. */
export function programWheelDriver(
  term: Terminal,
  element: HTMLElement,
  now: () => number = () => Date.now()
): (e: WheelEvent) => boolean {
  let carry = 0
  let lastAt = 0

  return (e) => {
    // Ours, coming back around. This is the one that xterm should handle.
    if (SYNTHETIC_WHEEL.has(e)) return true

    const at = now()
    const startOfBurst = at - lastAt > BURST_GAP_MS
    lastAt = at

    if (e.deltaY === 0) {
      carry = 0
      return true
    }

    // Exactly the two states where xterm reports rather than scrolls. `x10` is
    // excluded because it reports button presses only — a wheel under x10
    // still scrolls the viewport, which needs no help.
    const tracking = term.modes.mouseTrackingMode
    const toProgram =
      (tracking !== 'none' && tracking !== 'x10') || term.buffer.active.type === 'alternate'

    // The viewport is xterm's own to scroll, and it does it in pixels against
    // the same deltas — so it is already smooth and already consistent with
    // what a program gets here. Nothing to correct, and the carry belongs to
    // the gesture that was going to a program rather than to this one.
    if (!toProgram) {
      carry = 0
      return true
    }

    // Measured per event, not remembered: it moves with the font size, the
    // line height and the pane's zoom. The screen element's height is settled
    // long before anyone reaches for the wheel, so reading it here is free.
    const screen = element.querySelector('.xterm-screen')
    const cell = screen instanceof HTMLElement && term.rows > 0 ? screen.clientHeight / term.rows : 0
    if (cell <= 0) return true

    const { ticks, carry: rest } = wheelTicks(e, cell, term.rows, carry, startOfBurst)
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
