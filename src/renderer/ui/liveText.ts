/**
 * A text editor that formats what you type, in place.
 *
 * The alternative designs both ask something of you that an editor should not.
 * A mode asks which one you are in. A split asks you to read the right half
 * while typing in the left. This asks nothing: headings are big, keywords are
 * coloured, strings are strings, and you are editing that text directly.
 *
 * The document stays plain text at all times — `value` is exactly what goes on
 * disk. Nothing is converted, so nothing can be lost converting it back: the
 * styling is a costume put on the source, one `<span>` per run, rebuilt after
 * every keystroke. Syntax stays visible rather than hidden, the way iA Writer
 * and Bear do it. Hiding it would mean guessing where the caret should land
 * when you click on text whose markup is not on screen, and a wrong guess in a
 * text editor is worse than a visible asterisk.
 *
 * `contenteditable=plaintext-only` does the editing itself: no rich paste, no
 * `<b>` tags smuggled in from a browser, Enter inserts a newline and nothing
 * else. Redrawing the spans costs the browser's undo stack, so this keeps its
 * own — an editor without Ctrl+Z is not an editor.
 *
 * What it is *not* is a code editor with a language server: no completion, no
 * bracket matching, no folding. It is for the file you want to change three
 * characters in without leaving the window.
 */

import { normalizeNewlines } from '../../shared/eol'
import type { Edit, Span } from './textOps'

/** One styled run of a line. `cls` is the span's class; bare text has none. */
export interface Run {
  text: string
  cls?: string
  href?: string
}

/** A styled line, plus whatever state the next line needs to know about. */
export interface StyledLine {
  cls: string
  runs: Run[]
  /** Carried into the next line: inside a fence, inside a block comment, … */
  carry: number
}

/**
 * Turns one line into runs.
 *
 * Line at a time, deliberately: a file is edited a line at a time, and a
 * highlighter that needs the whole document to decide what a line is cannot
 * repaint one without repainting all of them. State that genuinely spans lines
 * — a fence, a block comment — travels in `carry`, which is a number so that
 * comparing it is free.
 */
export type Highlighter = (src: string, carry: number) => StyledLine

/** Snapshots are coalesced while you type; a pause starts a new one. */
const UNDO_GAP_MS = 500

/** As many snapshots as anyone reaches for, and no more memory than that. */
const UNDO_DEPTH = 200

export class LiveText {
  readonly element: HTMLDivElement
  private text = ''
  private history: { text: string; caret: number }[] = []
  private at = -1
  private lastEditAt = 0
  private composing = false
  /** The lines the DOM holds, so a repaint can skip the ones that have not moved. */
  private painted: string[] = []
  /** The highlighter state each painted line began with, for the same reason. */
  private readonly carried: number[] = []

  constructor(
    private highlighter: Highlighter,
    private readonly onChange: () => void
  ) {
    this.element = document.createElement('div')
    this.element.className = 'md-editor'
    this.element.setAttribute('contenteditable', 'plaintext-only')
    this.element.spellcheck = false

    this.element.addEventListener('input', () => this.onInput())
    this.element.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.element.addEventListener('paste', (e) => this.onPaste(e))
    this.element.addEventListener('compositionstart', () => (this.composing = true))
    this.element.addEventListener('compositionend', () => {
      this.composing = false
      this.onInput()
    })
    this.render()
  }

  get value(): string {
    return this.text
  }

  /**
   * Replaces the document. Used for loading, undo, and external changes.
   *
   * Normalised on the way in, so nothing downstream of here ever sees a `\r`.
   * A CRLF file would otherwise draw every line twice — see `normalizeNewlines`
   * — and the caller is responsible for putting the endings back when it writes
   * the file out.
   */
  set value(next: string) {
    const text = normalizeNewlines(next)
    if (text === this.text) return
    this.text = text
    this.history = []
    this.at = -1
    // The DOM this is about to replace was drawn from a different document.
    this.painted = []
    this.render()
  }

  /** Swaps the grammar under the same text — the tab's menu changing modes. */
  setHighlighter(highlighter: Highlighter): void {
    this.highlighter = highlighter
    // Every line is now painted with the wrong grammar, so none of them count
    // as already painted.
    this.painted = []
    this.carried.length = 0
    this.render()
  }

  /** Applies the result of a text operation, as one undoable step. */
  apply(edit: Edit): void {
    if (edit.text !== this.text) {
      const before = this.text
      this.text = edit.text
      // Never folded into the keystrokes around it: a command is one step, and
      // undo should put back exactly what it changed.
      this.lastEditAt = 0
      this.remember(before)
      this.lastEditAt = 0
      this.render()
      this.onChange()
    }
    this.select({ from: edit.from, to: edit.to })
  }

  /** Where the selection is, as offsets into `value`. */
  selection(): Span {
    const selection = window.getSelection()
    const anchor = selection?.anchorNode
    const focus = selection?.focusNode
    if (!selection || !anchor || !focus || !this.element.contains(anchor)) {
      const end = this.text.length
      return { from: end, to: end }
    }
    return {
      from: this.absolute(anchor, selection.anchorOffset),
      to: this.absolute(focus, selection.focusOffset),
    }
  }

  /** Puts the selection where an operation says it ended up. */
  select(span: Span): void {
    const selection = window.getSelection()
    if (!selection) return
    const lines = this.lines()
    if (!lines.length) return
    const anchor = this.pointAt(span.from)
    const focus = this.pointAt(span.to)
    if (!anchor || !focus) return
    const range = document.createRange()
    range.setStart(anchor.node, anchor.offset)
    range.setEnd(focus.node, focus.offset)
    selection.removeAllRanges()
    selection.addRange(range)
    this.scrollToSelection()
  }

  /** Brings the line the caret is on into view, and no further. */
  scrollToSelection(): void {
    const node = window.getSelection()?.focusNode
    if (!node) return
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    element?.closest('.md-line')?.scrollIntoView({ block: 'nearest' })
  }

  focus(): void {
    this.element.focus()
  }

  /** Everything highlighted, provided the highlight is inside this editor. */
  selectedText(): string {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return ''
    if (!this.element.contains(selection.anchorNode) || !this.element.contains(selection.focusNode)) {
      return ''
    }
    return selection.toString()
  }

  selectAll(): void {
    const selection = window.getSelection()
    if (!selection) return
    const range = document.createRange()
    range.selectNodeContents(this.element)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /** The link under an event, for the context menu and ctrl-click. */
  static linkAt(target: EventTarget | null): string {
    return (target as HTMLElement | null)?.dataset?.href ?? ''
  }

  // ------------------------------------------------------------------- editing

  private onInput(): void {
    if (this.composing) return
    const before = this.text
    const { text, split } = readBack(this.element)
    this.text = text
    // A line div holding a newline of its own means the DOM no longer matches
    // the one-div-per-line shape `painted` is a record of, and reusing that
    // record would leave the offending div exactly as the browser left it —
    // drawing its content twice. Nothing is reused after that. See `readBack`.
    if (split) this.painted = []
    if (this.text === before && !split) return
    this.remember(before)
    this.render()
    this.onChange()
  }

  /**
   * Paste, done here rather than by the browser.
   *
   * Letting it insert means letting it decide the DOM shape, and what it
   * decides for multi-line text is a newline inside one of our line divs —
   * which the painter then has to notice and repair, a frame later and
   * visibly. Taking the text and applying it as an ordinary edit means the DOM
   * only ever changes in `render`, from text we already hold.
   *
   * It also fixes two things that were wrong even when the repair worked: line
   * endings arrive normalised, so pasting from a Windows app stops seeding the
   * file with stray carriage returns; and the whole paste is one undo step
   * rather than being folded in with whatever was typed just before it.
   */
  private onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text/plain')
    // Nothing readable as text — an image, say. Left to the browser, which in
    // plaintext-only will drop it, and that is the right outcome.
    if (!text) return
    e.preventDefault()
    this.replaceSelection(normalizeNewlines(text))
  }

  private onKeyDown(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) this.redo()
      else this.undo()
      return
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      e.stopPropagation()
      this.redo()
      return
    }
    // Tab indents rather than leaving the field: this is an editor, and indented
    // blocks and nested list items are half of what anyone writes in one.
    if (e.key === 'Tab') {
      e.preventDefault()
      this.insert('  ')
      return
    }
    // Enter, for the same reason as paste: `plaintext-only` implements it by
    // putting a newline *inside* the current line div rather than starting a
    // new one, which leaves the DOM a shape this editor does not use and the
    // line drawn twice until something else repaints it.
    //
    // Not while composing — Enter is how an IME commits a candidate, and
    // taking it would stop anyone typing Japanese.
    if (e.key === 'Enter' && !this.composing && !e.isComposing) {
      e.preventDefault()
      this.insert('\n')
    }
  }

  /** Types text at the caret, as though the keyboard had. */
  private insert(what: string): void {
    this.replaceSelection(what)
  }

  /**
   * Replaces whatever is selected, or inserts at the caret when nothing is.
   *
   * Every edit this class makes itself goes through here, so that typing over
   * a selection does what it does everywhere else. The old version inserted at
   * the caret and left the selection in place, which for Tab meant indenting
   * *and* keeping the text you were replacing.
   */
  private replaceSelection(what: string): void {
    const span = this.selection()
    const from = Math.min(span.from, span.to)
    const to = Math.max(span.from, span.to)
    const before = this.text
    this.text = before.slice(0, from) + what + before.slice(to)
    this.remember(before)
    this.render(from + what.length)
    this.onChange()
  }

  // -------------------------------------------------------------------- history

  /**
   * Records the state *before* an edit.
   *
   * Consecutive keystrokes fold into one entry: undo should step back a word or
   * a line, not a character, and the pause between them is what separates them.
   */
  private remember(before: string): void {
    const now = Date.now()
    const coalesce = now - this.lastEditAt < UNDO_GAP_MS && this.at >= 0
    this.lastEditAt = now
    if (coalesce) return
    this.history = this.history.slice(0, this.at + 1)
    this.history.push({ text: before, caret: this.caretOffset() })
    if (this.history.length > UNDO_DEPTH) this.history.shift()
    this.at = this.history.length - 1
  }

  private undo(): void {
    if (this.at < 0) return
    const entry = this.history[this.at]
    // The state being left is what redo will come back to.
    this.history[this.at] = { text: this.text, caret: this.caretOffset() }
    this.at -= 1
    this.text = entry.text
    this.lastEditAt = 0
    this.render(entry.caret)
    this.onChange()
  }

  private redo(): void {
    if (this.at + 1 >= this.history.length) return
    this.at += 1
    const entry = this.history[this.at]
    this.history[this.at] = { text: this.text, caret: this.caretOffset() }
    this.text = entry.text
    this.lastEditAt = 0
    this.render(entry.caret)
    this.onChange()
  }

  // --------------------------------------------------------------------- paint

  /** Rebuilds the spans, then puts the caret back where the typist left it. */
  private render(caret?: number): void {
    const at = caret ?? (this.hasFocus() ? this.caretOffset() : null)

    // Repaint only what moved.
    //
    // Rebuilding every line on every keystroke is fine for a note and hopeless
    // for a two-thousand-line file: it is the difference between touching one
    // element and touching two thousand, sixty times a second. A line is
    // repainted when its own text changed, or when the state carried into it
    // did — the second half is what stops an unclosed comment from leaving the
    // rest of the file painted as though it were still code.
    const lines = this.text.split('\n')
    const existing = this.lines()
    let carry = 0

    for (let i = 0; i < lines.length; i++) {
      const before = carry
      const styled = this.highlighter(lines[i], carry)
      carry = styled.carry
      const stale =
        !existing[i] || lines[i] !== this.painted[i] || before !== (this.carried[i] ?? 0)
      this.carried[i] = before
      if (!stale) continue

      const div = this.buildLine(styled)
      if (existing[i]) existing[i].replaceWith(div)
      else this.element.appendChild(div)
    }

    // Lines the document no longer has.
    for (let i = existing.length - 1; i >= lines.length; i--) existing[i].remove()
    this.painted = lines
    this.carried.length = lines.length

    if (at !== null && at !== undefined) this.setCaret(at)
  }

  private buildLine({ cls, runs }: StyledLine): HTMLDivElement {
    const div = document.createElement('div')
    div.className = `md-line ${cls}`
    if (!runs.length) {
      // An empty line needs something to give it height and somewhere to put
      // the caret.
      div.appendChild(document.createElement('br'))
      return div
    }
    for (const run of runs) {
      if (!run.cls && !run.href) {
        div.appendChild(document.createTextNode(run.text))
        continue
      }
      const span = document.createElement('span')
      span.className = run.cls ?? ''
      if (run.href) span.dataset.href = run.href
      span.textContent = run.text
      div.appendChild(span)
    }
    return div
  }

  private hasFocus(): boolean {
    const active = document.activeElement
    return active === this.element || (active !== null && this.element.contains(active))
  }

  private lines(): HTMLElement[] {
    return [...this.element.children] as HTMLElement[]
  }

  /** Where the caret is, as an offset into `value`. */
  private caretOffset(): number {
    const selection = window.getSelection()
    const node = selection?.focusNode
    if (!selection || !node || !this.element.contains(node)) return this.text.length
    return this.absolute(node, selection.focusOffset)
  }

  /** A DOM position as an offset into `value`. */
  private absolute(node: Node, offset: number): number {
    let total = 0
    for (const line of this.lines()) {
      if (line === node) return total + lengthOfFirst(line, offset)
      if (line.contains(node)) return total + offsetWithin(line, node, offset)
      total += (line.textContent ?? '').length + 1
    }
    return this.text.length
  }

  /** An offset into `value` as a DOM position. */
  private pointAt(offset: number): { node: Node; offset: number } | null {
    const lines = this.lines()
    if (!lines.length) return null
    let left = Math.max(0, offset)
    for (const line of lines) {
      const length = (line.textContent ?? '').length
      if (left <= length) return pointInLine(line, left)
      left -= length + 1
    }
    const last = lines[lines.length - 1]
    return pointInLine(last, (last.textContent ?? '').length)
  }

  private setCaret(offset: number): void {
    const point = this.pointAt(offset)
    const selection = window.getSelection()
    if (!point || !selection) return
    const range = document.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
}

// ---------------------------------------------------------------- DOM plumbing

/**
 * The document as text, and whether the DOM still has the shape we drew.
 *
 * Read from our own line elements rather than `innerText`, which reports what
 * is *rendered*: it collapses a trailing blank line and has opinions about
 * whitespace that the file on disk does not share.
 *
 * `split` is the important half. This editor's one structural assumption is
 * that a child of the root is exactly one line, and the browser breaks it: in
 * `plaintext-only`, Enter and a multi-line paste both put a newline *inside*
 * the current line div rather than starting a new one. The text still reads
 * back correctly — joining on `\n` cannot tell the difference — but the
 * document now has more lines than there are divs, and the painter's record of
 * what it drew is describing a DOM that no longer exists.
 *
 * That is what drew a pasted block twice: the div the browser had stuffed
 * compared equal to what we last painted, so it was skipped and left holding
 * the whole paste, while the lines it should have been split into were appended
 * after it. The next edit to touch that line repainted it properly and the
 * duplicate vanished, which is why it looked like the editor pasting twice and
 * then taking one back.
 *
 * Enter and paste are now handled directly, so this should not arise. It is
 * still reported, because a drag-and-drop, an IME, or a browser autocorrect can
 * do the same thing, and a wrong answer here is silent.
 */
function readBack(root: HTMLElement): { text: string; split: boolean } {
  let split = false
  const lines = [...root.children].map((line) => {
    const text = (line as HTMLElement).textContent ?? ''
    if (text.includes('\n') || text.includes('\r')) split = true
    return text
  })
  const text = lines.join('\n')
  // Normalised here too, so `value` can never hold a `\r` however it arrived.
  return { text: split ? normalizeNewlines(text) : text, split }
}

/** Text length of a line's first `count` children, for a caret on the line itself. */
function lengthOfFirst(line: HTMLElement, count: number): number {
  let total = 0
  for (let i = 0; i < count && i < line.childNodes.length; i++) {
    total += line.childNodes[i].textContent?.length ?? 0
  }
  return total
}

/** Offset of a caret inside a line, in that line's own characters. */
function offsetWithin(line: HTMLElement, node: Node, offset: number): number {
  let total = 0
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let text: Node | null
  while ((text = walker.nextNode())) {
    if (text === node) return total + offset
    total += text.textContent?.length ?? 0
  }
  // A caret parked on an element rather than in text — an empty line, usually.
  return node === line ? lengthOfFirst(line, offset) : total
}

/** The DOM position `offset` characters into a line. */
function pointInLine(line: HTMLElement, offset: number): { node: Node; offset: number } {
  let left = offset
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let text: Node | null
  while ((text = walker.nextNode())) {
    const length = text.textContent?.length ?? 0
    if (left <= length) return { node: text, offset: left }
    left -= length
  }
  // No text in the line at all: the caret goes to the line itself.
  return { node: line, offset: 0 }
}
