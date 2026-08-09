/**
 * The bytes, as bytes — and editable.
 *
 * Overwrite only. You can change any byte in the file and you cannot change how
 * many there are: no insert, no delete, no truncate. That is not a shortcut, it
 * is the safe half of hex editing. Inserting a byte rewrites every offset after
 * it, which is how you turn a working binary into a broken one, and the file
 * this view opens is exactly the kind whose length something else depends on.
 * Saving writes only the bytes you touched, at the offsets you touched them —
 * a file loaded a megabyte at a time is never rewritten from what is on screen.
 *
 * Editing is keyboard-driven rather than a grid of editable cells: a byte is
 * two hex digits and a caret between them is a fiction. Click one, type over
 * it, arrow around. Tab crosses to the ASCII column, where a keystroke is the
 * byte it stands for.
 */

/** Bytes per row. Sixteen, as every hex viewer since 1974. */
const STRIDE = 16

/** Rows drawn at once. A megabyte is 65536 of them, and the DOM would die. */
const MAX_ROWS = 4096

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

export class HexView {
  readonly element: HTMLDivElement
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array()
  /** What was read from disk, so an edit back to the original stops being one. */
  private original: Uint8Array<ArrayBuffer> = new Uint8Array()
  private size = 0
  private truncated = false
  /** Offsets whose byte differs from disk. */
  private readonly dirty = new Set<number>()
  private at = 0
  /** Which column has the caret. The ASCII side types characters, not digits. */
  private column: 'hex' | 'ascii' = 'hex'
  /** Half a byte, typed. The high nibble waits here for the low one. */
  private pending: number | null = null
  private readonly rows = new Map<number, HTMLElement>()

  constructor(private readonly onChange: () => void) {
    this.element = document.createElement('div')
    this.element.className = 'hex-view'
    // Focusable, because everything here is a keystroke.
    this.element.tabIndex = 0
    this.element.addEventListener('keydown', (e) => this.onKey(e))
    this.element.addEventListener('mousedown', (e) => this.onClick(e))
  }

  /** Whether anything on screen differs from the file. */
  get modified(): boolean {
    return this.dirty.size > 0
  }

  get changedCount(): number {
    return this.dirty.size
  }

  /** Shows a slice of a file, with a note when it is only a slice. */
  show(bytes: Uint8Array<ArrayBuffer>, size: number, truncated: boolean): void {
    this.bytes = bytes
    this.original = bytes.slice()
    this.size = size
    this.truncated = truncated
    this.dirty.clear()
    this.pending = null
    this.at = Math.min(this.at, Math.max(0, bytes.length - 1))
    this.render()
  }

  /**
   * The edits, as the fewest possible writes.
   *
   * Consecutive changed bytes go out as one patch: typing over a four-byte
   * header is one write, not four.
   */
  patches(): { offset: number; bytes: Uint8Array<ArrayBuffer> }[] {
    const offsets = [...this.dirty].sort((a, b) => a - b)
    const runs: { offset: number; bytes: Uint8Array<ArrayBuffer> }[] = []
    let start = -1
    let previous = -2
    for (const offset of offsets) {
      if (offset !== previous + 1) {
        if (start >= 0) runs.push({ offset: start, bytes: this.bytes.slice(start, previous + 1) })
        start = offset
      }
      previous = offset
    }
    if (start >= 0) runs.push({ offset: start, bytes: this.bytes.slice(start, previous + 1) })
    return runs
  }

  /** Called once the patches are on disk: what is on screen is now the file. */
  accept(): void {
    this.original = this.bytes.slice()
    this.dirty.clear()
    this.repaintAll()
  }

  // -------------------------------------------------------------------- input

  private onClick(e: MouseEvent): void {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-at]')
    if (!cell) return
    e.preventDefault()
    this.element.focus()
    this.moveTo(Number(cell.dataset.at), cell.dataset.column === 'ascii' ? 'ascii' : 'hex')
  }

  private onKey(e: KeyboardEvent): void {
    const rowsPerPage = Math.max(1, Math.floor(this.element.clientHeight / 20) - 1)
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -STRIDE,
      ArrowDown: STRIDE,
      PageUp: -STRIDE * rowsPerPage,
      PageDown: STRIDE * rowsPerPage,
    }
    if (e.key in moves) {
      e.preventDefault()
      this.moveTo(this.at + moves[e.key], this.column)
      return
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const row = Math.floor(this.at / STRIDE) * STRIDE
      this.moveTo(e.key === 'Home' ? row : Math.min(row + STRIDE - 1, this.bytes.length - 1), this.column)
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      this.pending = null
      this.moveTo(this.at, this.column === 'hex' ? 'ascii' : 'hex')
      return
    }
    // Ctrl is for the app's shortcuts, not for typing bytes.
    if (e.ctrlKey || e.metaKey || e.altKey) return

    if (this.column === 'ascii') {
      if (e.key.length !== 1) return
      const code = e.key.charCodeAt(0)
      if (code > 0xff) return
      e.preventDefault()
      this.write(this.at, code)
      this.moveTo(this.at + 1, 'ascii')
      return
    }

    const digit = parseInt(e.key, 16)
    if (e.key.length !== 1 || Number.isNaN(digit)) return
    e.preventDefault()
    if (this.pending === null) {
      // First nibble: shown immediately, so what you typed is what you see.
      this.pending = digit
      this.write(this.at, (digit << 4) | (this.bytes[this.at] & 0x0f))
      this.repaint(this.at)
      return
    }
    this.write(this.at, (this.pending << 4) | digit)
    this.pending = null
    this.moveTo(this.at + 1, 'hex')
  }

  private write(at: number, byte: number): void {
    if (at < 0 || at >= this.bytes.length || this.bytes[at] === byte) return
    this.bytes[at] = byte
    // An edit that puts the original byte back is not an edit any more.
    if (byte === this.original[at]) this.dirty.delete(at)
    else this.dirty.add(at)
    this.repaint(at)
    this.onChange()
  }

  private moveTo(at: number, column: 'hex' | 'ascii'): void {
    const next = Math.max(0, Math.min(at, this.bytes.length - 1))
    if (next !== this.at || column !== this.column) this.pending = null
    const previous = this.at
    this.at = next
    this.column = column
    this.repaint(previous)
    this.repaint(next)
    this.rows.get(Math.floor(next / STRIDE))?.scrollIntoView({ block: 'nearest' })
  }

  // -------------------------------------------------------------------- paint

  private render(): void {
    this.element.replaceChildren()
    this.rows.clear()

    const rows = Math.min(Math.ceil(this.bytes.length / STRIDE), MAX_ROWS)
    const table = document.createElement('div')
    table.className = 'hex-rows'
    for (let row = 0; row < rows; row++) {
      const element = this.buildRow(row)
      this.rows.set(row, element)
      table.appendChild(element)
    }
    this.element.appendChild(table)

    const shown = Math.min(this.bytes.length, rows * STRIDE)
    if (shown < this.size) {
      const note = document.createElement('p')
      note.className = 'csv-note'
      note.textContent = this.truncated
        ? `Showing the first ${sizeText(shown)} of ${sizeText(this.size)}. Edits are written at their real offsets.`
        : `Showing the first ${sizeText(shown)} of ${sizeText(this.size)} — the rest is read but not drawn.`
      this.element.appendChild(note)
    }
  }

  private repaintAll(): void {
    for (const [row, element] of this.rows) element.replaceWith(this.remember(row))
  }

  private repaint(at: number): void {
    const row = Math.floor(at / STRIDE)
    const element = this.rows.get(row)
    if (element) element.replaceWith(this.remember(row))
  }

  private remember(row: number): HTMLElement {
    const element = this.buildRow(row)
    this.rows.set(row, element)
    return element
  }

  private buildRow(row: number): HTMLElement {
    const from = row * STRIDE
    const line = document.createElement('div')
    line.className = 'hex-row'

    const offset = document.createElement('span')
    offset.className = 'hex-offset'
    offset.textContent = from.toString(16).padStart(8, '0')
    line.appendChild(offset)

    const hex = document.createElement('span')
    hex.className = 'hex-bytes'
    for (let i = 0; i < STRIDE; i++) {
      const at = from + i
      // A gap at the halfway mark, so counting to a column needs no ruler.
      if (i === 8) hex.appendChild(document.createTextNode(' '))
      if (i) hex.appendChild(document.createTextNode(' '))
      if (at >= this.bytes.length) {
        hex.appendChild(document.createTextNode('  '))
        continue
      }
      hex.appendChild(this.cell(at, HEX[this.bytes[at]], 'hex'))
    }
    line.appendChild(hex)

    const ascii = document.createElement('span')
    ascii.className = 'hex-ascii'
    for (let i = 0; i < STRIDE; i++) {
      const at = from + i
      if (at >= this.bytes.length) break
      const byte = this.bytes[at]
      // Printable ASCII only. Anything else is a dot, including the high range:
      // guessing an encoding here would be inventing information.
      const char = byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'
      ascii.appendChild(this.cell(at, char, 'ascii'))
    }
    line.appendChild(ascii)

    return line
  }

  private cell(at: number, text: string, column: 'hex' | 'ascii'): HTMLElement {
    const span = document.createElement('span')
    span.className = 'hex-cell'
    if (this.dirty.has(at)) span.classList.add('hex-changed')
    if (at === this.at) {
      span.classList.add(column === this.column ? 'hex-at' : 'hex-echo')
    }
    span.dataset.at = String(at)
    span.dataset.column = column
    span.textContent = text
    return span
  }
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} bytes`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Base64 from the host back into bytes. */
export function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** Bytes back into base64, for the patch going the other way. */
export function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
