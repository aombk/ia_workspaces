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
  carry: number
): { ticks: number; carry: number } {
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
export function programWheelDriver(term: Terminal, element: HTMLElement): (e: WheelEvent) => boolean {
  let carry = 0

  return (e) => {
    // Ours, coming back around. This is the one that xterm should handle.
    if (SYNTHETIC_WHEEL.has(e)) return true

    // Exactly the two states where xterm reports rather than scrolls. `x10` is
    // excluded because it reports button presses only — a wheel under x10
    // still scrolls the viewport, which needs no help.
    const tracking = term.modes.mouseTrackingMode
    const toProgram =
      (tracking !== 'none' && tracking !== 'x10') || term.buffer.active.type === 'alternate'
    if (!toProgram || e.deltaY === 0) {
      carry = 0
      return true
    }

    // Measured per event, not remembered: it moves with the font size, the
    // line height and the pane's zoom. The screen element's height is settled
    // long before anyone reaches for the wheel, so reading it here is free.
    const screen = element.querySelector('.xterm-screen')
    const cell = screen instanceof HTMLElement && term.rows > 0 ? screen.clientHeight / term.rows : 0
    if (cell <= 0) return true

    const { ticks, carry: rest } = wheelTicks(e, cell, term.rows, carry)
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
