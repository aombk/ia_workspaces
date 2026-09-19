/**
 * Tracks whether an inline editor (rename input, colour field) currently owns
 * the keyboard.
 *
 * Terminals aggressively reclaim focus whenever a pane is shown, and that
 * focus grab lands *after* a rename input has focused itself — blurring it and
 * committing the rename before a single keystroke arrives. Anything that would
 * steal focus must check `isEditing()` first.
 */
let depth = 0

/**
 * The inline editors currently on screen.
 *
 * Tracked as elements rather than counted, because an input can leave without
 * saying so: a rebuild that replaces the DOM around a rename discards the input
 * without a `blur`, so nothing settles it. A counter never came back down from
 * that, and `isEditing()` stayed true for the life of the window — with every
 * terminal refusing focus from then on. An element that is no longer in the
 * document is no longer editing anything, and that is a question we can ask
 * rather than a promise we have to keep.
 */
const live = new Map<HTMLInputElement, { seen: boolean }>()

export function beginEditing(): void {
  depth++
}

export function endEditing(): void {
  depth = Math.max(0, depth - 1)
}

export function isEditing(): boolean {
  for (const [input, state] of live) {
    // An editor is built before it is inserted, so "not in the document" only
    // means "gone" once it has been in there at all.
    if (input.isConnected) state.seen = true
    else if (state.seen) live.delete(input)
  }
  return depth > 0 || live.size > 0
}

/**
 * Wires an input as an inline editor: focuses and selects it, suppresses the
 * terminal focus grab for its lifetime, and commits on Enter/blur or cancels
 * on Escape. Returns nothing — the callbacks own what happens next.
 */
export function attachInlineEditor(
  input: HTMLInputElement,
  opts: { onCommit(value: string): void; onCancel(): void }
): void {
  let settled = false
  live.set(input, { seen: false })

  const settle = (commit: boolean) => {
    if (settled) return
    settled = true
    live.delete(input)
    if (commit) opts.onCommit(input.value)
    else opts.onCancel()
  }

  input.addEventListener('blur', () => settle(true))
  input.addEventListener('mousedown', (e) => e.stopPropagation())
  input.addEventListener('dblclick', (e) => e.stopPropagation())
  input.addEventListener('click', (e) => e.stopPropagation())
  input.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      settle(true)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      settle(false)
    }
  })

  queueMicrotask(() => {
    input.focus()
    input.select()
  })
}
