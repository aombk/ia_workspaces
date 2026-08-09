/**
 * Find, and find-and-replace, for the editor.
 *
 * Its own strip above the text rather than a dialog, because a dialog covers
 * the thing you are searching. Replace is folded in behind a toggle instead of
 * being a second command: nobody knows before they start whether they are about
 * to replace what they are looking for.
 *
 * The bar owns no text. It reports what was typed and which way to go, and the
 * editor does the searching — the editor is the thing that knows where the
 * caret is, which is what "next" means.
 */
import type { FindOptions } from './textOps'

export interface FindHandlers {
  /** Query or options changed, or Enter was pressed: go to a match. */
  find(query: string, opts: FindOptions, backwards: boolean): void
  replace(query: string, replacement: string, opts: FindOptions): void
  replaceAll(query: string, replacement: string, opts: FindOptions): void
  close(): void
}

export class FindBar {
  readonly element: HTMLDivElement
  private readonly query: HTMLInputElement
  private readonly replacement: HTMLInputElement
  private readonly count: HTMLSpanElement
  private readonly replaceRow: HTMLDivElement
  private opts: FindOptions = {}

  constructor(private readonly handlers: FindHandlers) {
    this.element = document.createElement('div')
    this.element.className = 'find-bar'
    this.element.hidden = true

    const row = document.createElement('div')
    row.className = 'find-row'

    this.query = document.createElement('input')
    this.query.className = 'find-input'
    this.query.placeholder = 'Find'
    this.query.spellcheck = false
    this.query.addEventListener('input', () => this.run(false))
    this.query.addEventListener('keydown', (e) => this.onKey(e))
    row.appendChild(this.query)

    this.count = document.createElement('span')
    this.count.className = 'find-count'
    row.appendChild(this.count)

    this.toggle(row, 'Aa', 'Match case', () => {
      this.opts = { ...this.opts, caseSensitive: !this.opts.caseSensitive }
      return Boolean(this.opts.caseSensitive)
    })
    this.toggle(row, '␣', 'Whole word', () => {
      this.opts = { ...this.opts, wholeWord: !this.opts.wholeWord }
      return Boolean(this.opts.wholeWord)
    })
    this.toggle(row, '.*', 'Regular expression', () => {
      this.opts = { ...this.opts, regex: !this.opts.regex }
      return Boolean(this.opts.regex)
    })

    row.appendChild(this.button('↑', 'Previous (Shift+Enter)', () => this.run(true)))
    row.appendChild(this.button('↓', 'Next (Enter)', () => this.run(false)))
    row.appendChild(
      this.button('⇄', 'Replace…', () => {
        this.replaceRow.hidden = !this.replaceRow.hidden
        if (!this.replaceRow.hidden) this.replacement.focus()
      })
    )
    row.appendChild(this.button('✕', 'Close (Esc)', () => this.handlers.close()))
    this.element.appendChild(row)

    this.replaceRow = document.createElement('div')
    this.replaceRow.className = 'find-row'
    this.replaceRow.hidden = true

    this.replacement = document.createElement('input')
    this.replacement.className = 'find-input'
    this.replacement.placeholder = 'Replace with'
    this.replacement.spellcheck = false
    this.replacement.addEventListener('keydown', (e) => this.onKey(e))
    this.replaceRow.appendChild(this.replacement)

    this.replaceRow.appendChild(
      this.button('Replace', 'Replace this match', () =>
        this.handlers.replace(this.query.value, this.replacement.value, this.opts)
      )
    )
    this.replaceRow.appendChild(
      this.button('All', 'Replace every match', () =>
        this.handlers.replaceAll(this.query.value, this.replacement.value, this.opts)
      )
    )
    this.element.appendChild(this.replaceRow)
  }

  get open(): boolean {
    return !this.element.hidden
  }

  /** Opens the bar, seeded with whatever was selected. */
  show(seed: string, withReplace = false): void {
    this.element.hidden = false
    if (withReplace) this.replaceRow.hidden = false
    if (seed && !seed.includes('\n')) this.query.value = seed
    this.query.focus()
    this.query.select()
    if (this.query.value) this.run(false)
  }

  hide(): void {
    this.element.hidden = true
  }

  /** How many matches there are, and which one you are on. */
  report(index: number, total: number): void {
    this.count.textContent = total ? `${index + 1} of ${total}` : this.query.value ? 'none' : ''
    this.query.classList.toggle('find-miss', Boolean(this.query.value) && !total)
  }

  private onKey(e: KeyboardEvent): void {
    // The editor's own shortcuts must not fire while typing a search.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      this.handlers.close()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (e.target === this.replacement) {
        this.handlers.replace(this.query.value, this.replacement.value, this.opts)
        return
      }
      this.run(e.shiftKey)
    }
  }

  private run(backwards: boolean): void {
    this.handlers.find(this.query.value, this.opts, backwards)
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'reader-btn find-btn'
    button.textContent = label
    button.title = title
    button.addEventListener('click', onClick)
    return button
  }

  private toggle(
    row: HTMLElement,
    label: string,
    title: string,
    flip: () => boolean
  ): HTMLButtonElement {
    const button = this.button(label, title, () => {
      button.classList.toggle('on', flip())
      this.run(false)
    })
    button.classList.add('find-toggle')
    row.appendChild(button)
    return button
  }
}
