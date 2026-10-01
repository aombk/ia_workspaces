/**
 * What the sidebar and the tab strip need to survive their own redraws.
 *
 * Both are rebuilt outright on every store change — simple, and right for a
 * list of a dozen rows — and both lost something to it that a person was in
 * the middle of. A rename field was replaced by a fresh one holding the old
 * name, so whatever had been typed vanished the next time an agent printed a
 * line. And a row reached from the keyboard was replaced by an identical row
 * that did not have the focus, which threw the keyboard back to the page.
 *
 * Two small helpers rather than a diffing list, because both problems are
 * about one element: the one being typed into, and the one with the focus.
 */

/**
 * Replaces a list's children with `next`, without ever moving `keep`.
 *
 * Moving a focused element in the DOM — even to the same place — takes the
 * focus away from it, and with the focus goes the caret, the selection and,
 * for an inline editor, its whole reason to exist. So `keep` stays exactly
 * where it is and everything else is put around it.
 *
 * `keep` must be both a child of `parent` and in `next`; otherwise this is an
 * ordinary `replaceChildren`.
 */
export function replaceChildrenKeeping(parent: Element, next: Node[], keep: Node | null): void {
  const at = keep ? next.indexOf(keep) : -1
  if (!keep || at < 0 || keep.parentNode !== parent) {
    parent.replaceChildren(...next)
    return
  }
  for (const child of [...parent.childNodes]) if (child !== keep) child.remove()
  for (let i = 0; i < at; i++) parent.insertBefore(next[i], keep)
  for (let i = at + 1; i < next.length; i++) parent.appendChild(next[i])
}

/** Which row of a list had the focus before a redraw, and how it got it. */
export interface HeldFocus {
  key: string
  /** Whether the focus was showing — keyboard focus, as opposed to a click's. */
  visible: boolean
}

/**
 * The key of the row in `parent` that has the focus, read from `attribute`.
 * Only the row itself counts: focus on a button or field inside it is that
 * control's business.
 */
export function heldFocus(parent: Element, attribute: string): HeldFocus | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active.parentElement !== parent) return null
  const key = active.getAttribute(attribute)
  if (key === null) return null
  return { key, visible: active.matches(':focus-visible') }
}

/**
 * Gives the focus back to the row that now stands for the one that had it.
 *
 * `focusVisible` carries over how the focus looked: a row reached with the
 * arrow keys keeps its ring, a row that was clicked does not grow one.
 */
export function restoreFocus(parent: Element, attribute: string, held: HeldFocus | null): void {
  if (!held) return
  const row = [...parent.children].find((el) => el.getAttribute(attribute) === held.key)
  if (!(row instanceof HTMLElement) || row === document.activeElement) return
  row.focus({ preventScroll: true, focusVisible: held.visible } as FocusOptions)
}

/**
 * Arrow-key movement along a list of rows with a roving `tabindex`: the row
 * that has the focus is the one `Tab` reaches, and the others are skipped.
 * Returns the row moved to, or null at either end.
 */
export function moveFocus(from: HTMLElement, selector: string, step: 1 | -1 | 'first' | 'last'): HTMLElement | null {
  const rows = [...(from.parentElement?.children ?? [])].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches(selector)
  )
  const at = rows.indexOf(from)
  const to =
    step === 'first' ? rows[0] : step === 'last' ? rows[rows.length - 1] : rows[at + step]
  if (!to || to === from) return null
  from.tabIndex = -1
  to.tabIndex = 0
  to.focus()
  return to
}
