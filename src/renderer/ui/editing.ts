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

export function beginEditing(): void {
  depth++
}

export function endEditing(): void {
  depth = Math.max(0, depth - 1)
}

export function isEditing(): boolean {
  return depth > 0
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
  beginEditing()

  const settle = (commit: boolean) => {
    if (settled) return
    settled = true
    endEditing()
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
