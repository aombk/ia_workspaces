/**
 * When a pane that draws from shared state needs drawing again.
 *
 * A handful of panes — focus, day, runbook, tokens, the machine readings — are
 * built from state that changes far less often than they are told about it.
 * Every store change reaches them through `sync`, and during agent output that
 * is several times a second, in hidden tabs as much as visible ones. Each used
 * to answer by throwing its whole body away and building it again. That was
 * work for nothing most of the time, and worse than nothing some of the time:
 * a button replaced between the mouse going down and coming up is a click that
 * never happens, which made the focus timer's Start and Stop a coin toss while
 * an agent was talking.
 *
 * So a pane says what its picture is made of — a short list of values, compared
 * by identity — and draws only when one of them moved and the pane is actually
 * on screen. A pane that is hidden is drawn the next time it is asked while
 * shown; `Terminals` asks every pane of a tab as the tab comes back.
 */
export class Redraw {
  private last: readonly unknown[] | null = null

  constructor(private readonly element: HTMLElement) {}

  /**
   * True when the pane is on screen and `inputs` differ from those of the last
   * draw. Records nothing — `drew` does, from inside the draw itself, so a draw
   * the pane forces for its own reasons counts too.
   */
  due(inputs: readonly unknown[]): boolean {
    if (!isShown(this.element)) return false
    return !sameInputs(this.last, inputs)
  }

  /**
   * Forgets the last draw, for a change the inputs cannot see — a watcher
   * saying its data moved — so the next `due` while shown is true.
   */
  invalidate(): void {
    this.last = null
  }

  /** Records what the picture now on screen was drawn from. */
  drew(inputs: readonly unknown[]): void {
    this.last = inputs
  }
}

/**
 * Whether an element is on screen at all: in the document and under nothing
 * `hidden`. Hidden is how `Terminals` parks every tab but the one in front, and
 * how the dock hides itself, so this is the whole question — and it asks the
 * DOM tree rather than the layout, so it never forces a reflow.
 */
export function isShown(element: HTMLElement): boolean {
  return element.isConnected && !element.closest('[hidden]')
}

export function sameInputs(a: readonly unknown[] | null, b: readonly unknown[]): boolean {
  if (!a || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false
  return true
}
