/**
 * A CSV/TSV file as the table it is, editable in place.
 *
 * The delicate part is writing it back. Re-serialising the whole file would
 * "tidy" quoting the author chose on purpose — `"1"` becoming `1`, a trailing
 * space losing its quotes — across thousands of rows nobody touched. So each
 * row keeps the exact line it was parsed from, and only a row you actually
 * edited is rebuilt. Everything else is handed back byte for byte.
 */

/** Past this, a grid is the wrong tool and the browser agrees. */
const MAX_ROWS = 5000

interface Row {
  /** The line exactly as read, used verbatim until this row is edited. */
  raw: string
  cells: string[]
  edited: boolean
}

export class CsvGrid {
  readonly element: HTMLDivElement
  private rows: Row[] = []
  private trailingNewline = false
  private delimiter = ','
  private truncated = 0

  constructor(private readonly onChange: () => void) {
    this.element = document.createElement('div')
    this.element.className = 'csv-grid'
  }

  setDelimiter(delimiter: string): void {
    this.delimiter = delimiter
  }

  get value(): string {
    const text = this.rows.map((row) => (row.edited ? serialise(row.cells, this.delimiter) : row.raw)).join('\n')
    return this.trailingNewline ? `${text}\n` : text
  }

  set value(text: string) {
    // A trailing newline is the normal shape of a text file and must survive a
    // round trip, but it is not a final empty row to show.
    this.trailingNewline = text.endsWith('\n')
    const lines = (this.trailingNewline ? text.slice(0, -1) : text).split('\n')
    this.truncated = Math.max(0, lines.length - MAX_ROWS)
    this.rows = lines.slice(0, MAX_ROWS).map((raw) => ({
      raw,
      cells: parse(raw, this.delimiter),
      edited: false,
    }))
    this.render()
  }

  private render(): void {
    this.element.replaceChildren()
    if (!this.rows.length) return

    const width = Math.max(...this.rows.map((row) => row.cells.length))
    const table = document.createElement('table')
    table.className = 'csv-table'

    // The first row is treated as headings. Almost every CSV has them, and a
    // file that does not still reads correctly — the row is simply bold.
    const head = document.createElement('thead')
    head.appendChild(this.buildRow(this.rows[0], 0, width, true))
    table.appendChild(head)

    const body = document.createElement('tbody')
    for (let i = 1; i < this.rows.length; i++) {
      body.appendChild(this.buildRow(this.rows[i], i, width, false))
    }
    table.appendChild(body)
    this.element.appendChild(table)

    if (this.truncated) {
      const note = document.createElement('p')
      note.className = 'csv-note'
      note.textContent = `${this.truncated.toLocaleString()} further rows are not shown. Switch to Plain text to see the whole file.`
      this.element.appendChild(note)
    }
  }

  private buildRow(row: Row, index: number, width: number, heading: boolean): HTMLTableRowElement {
    const tr = document.createElement('tr')

    const gutter = document.createElement(heading ? 'th' : 'td')
    gutter.className = 'csv-gutter'
    gutter.textContent = heading ? '' : String(index)
    tr.appendChild(gutter)

    for (let column = 0; column < width; column++) {
      const cell = document.createElement(heading ? 'th' : 'td')
      cell.className = 'csv-cell'
      cell.textContent = row.cells[column] ?? ''
      cell.setAttribute('contenteditable', 'plaintext-only')
      cell.addEventListener('input', () => {
        // Short rows are padded on write, so editing past the end of a row adds
        // the columns it implies rather than silently dropping the text.
        while (row.cells.length <= column) row.cells.push('')
        row.cells[column] = cell.textContent ?? ''
        row.edited = true
        this.onChange()
      })
      // Enter in a cell means "done", not "newline inside this value".
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          cell.blur()
        }
      })
      tr.appendChild(cell)
    }
    return tr
  }
}

/** One line into fields, following RFC 4180's doubled-quote escaping. */
export function parse(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let value = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          value += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        value += char
      }
      continue
    }
    if (char === '"' && value === '') {
      quoted = true
      continue
    }
    if (char === delimiter) {
      cells.push(value)
      value = ''
      continue
    }
    value += char
  }
  cells.push(value)
  return cells
}

/** Fields back into a line, quoting only what has to be quoted. */
export function serialise(cells: string[], delimiter: string): string {
  return cells
    .map((cell) => {
      const needsQuotes =
        cell.includes(delimiter) || cell.includes('"') || cell.includes('\n') || cell.includes('\r')
      return needsQuotes ? `"${cell.replace(/"/g, '""')}"` : cell
    })
    .join(delimiter)
}
