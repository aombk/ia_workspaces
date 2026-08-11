/**
 * Two files, side by side.
 *
 * The changes pane answers "what did this repo do", which needs git. This
 * answers the other question: how do *these two files* differ — a `.env`
 * against its `.env.example`, a config before and after an upgrade, two exports
 * from different branches. Neither file has to be tracked, or to live inside a
 * repository at all.
 *
 * It opens empty and waits. Asking for two files through a pair of dialogs
 * before you can see anything is the wrong shape for a pane you might open
 * speculatively, and it forecloses the natural gesture: drag one file onto each
 * side. The picker is still there as a button for when dragging is not
 * convenient, or not possible at all on a host that cannot resolve a drop.
 *
 * Read-only, and no polling: it is pointed at two fixed paths and re-reads only
 * when asked, so it costs nothing sitting in a background tab.
 */
import { backend } from '../backend'
import { store } from './state'
import { classify } from './git/common'
import { FILE_DRAG } from './filesPane'
import type { AuxPane } from './auxPane'

type View = 'split' | 'unified'

/** One row of the side-by-side table. A null side is padding opposite a change. */
interface Row {
  left: { n: number; text: string } | null
  right: { n: number; text: string } | null
  kind: 'ctx' | 'add' | 'del' | 'hunk'
}

export class ComparePane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly headEl: HTMLDivElement
  private readonly pickersEl: HTMLDivElement
  private readonly bodyEl: HTMLDivElement
  private left: string
  private right: string
  private view: View = 'split'
  /**
   * Wrap long lines instead of scrolling sideways.
   *
   * Off by default, and in memory rather than in the store — the same standing
   * as `view`, and for the same reason: which way you want to read *this*
   * comparison is a property of the question you are asking, not of the pane.
   */
  private wrap = false
  private disposed = false
  /** Bumped per request so a slow diff cannot overwrite a newer one. */
  private token = 0

  constructor(readonly paneId: string) {
    const pane = store.pane(paneId)
    this.left = pane?.compareLeft ?? ''
    this.right = pane?.compareRight ?? ''

    this.element = document.createElement('div')
    this.element.className = 'compare-pane'

    this.headEl = document.createElement('div')
    this.headEl.className = 'diff-head'
    this.element.appendChild(this.headEl)

    this.pickersEl = document.createElement('div')
    this.pickersEl.className = 'compare-pickers'
    this.element.appendChild(this.pickersEl)

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'compare-body'
    this.element.appendChild(this.bodyEl)

    this.renderHead()
    this.renderPickers()
    void this.load()
  }

  /** Picks up a re-target from outside, e.g. a future "Compare with…". */
  sync(): void {
    const pane = store.pane(this.paneId)
    const left = pane?.compareLeft ?? ''
    const right = pane?.compareRight ?? ''
    if (this.disposed || (left === this.left && right === this.right)) return
    this.left = left
    this.right = right
    this.applyWrap()
    this.renderHead()
    this.renderPickers()
    void this.load()
  }

  // ------------------------------------------------------------------ chrome

  /**
   * Carries the wrap choice to the CSS.
   *
   * On the pane rather than on the body, so it survives the body being rebuilt
   * by every reload and every switch between split and unified.
   */
  private applyWrap(): void {
    this.element.classList.toggle('wrap', this.wrap)
  }

  /**
   * Locks the two columns together vertically, leaving each free sideways.
   *
   * They have to be real scrollers for each to own a horizontal scrollbar that
   * stays reachable — a single outer scroller would put that bar past the end
   * of the file. Two scrollers means the vertical axis is no longer shared, so
   * it is shared back here.
   *
   * `syncing` is the re-entrancy guard: assigning `scrollTop` fires the other
   * element's scroll event, which would assign back, and the two would fight
   * every frame and never settle.
   */
  private syncColumns(): void {
    const columns = [...this.bodyEl.querySelectorAll<HTMLElement>('.compare-col')]
    this.bodyEl.classList.toggle('columns', columns.length === 2)
    if (columns.length !== 2) return

    let syncing = false
    for (const [i, col] of columns.entries()) {
      const other = columns[1 - i]
      col.addEventListener(
        'scroll',
        () => {
          if (syncing) return
          if (other.scrollTop === col.scrollTop) return
          syncing = true
          other.scrollTop = col.scrollTop
          // Cleared on the next frame rather than immediately: the assignment
          // above queues a scroll event that has not been delivered yet.
          requestAnimationFrame(() => {
            syncing = false
          })
        },
        { passive: true }
      )
    }
  }

  private renderHead(): void {
    this.headEl.replaceChildren()

    const title = document.createElement('span')
    title.className = 'diff-title'
    title.textContent = this.ready() ? `${name(this.left)} → ${name(this.right)}` : 'Compare'
    if (this.ready()) title.title = `${this.left}\n${this.right}`
    this.headEl.appendChild(title)

    for (const [label, value] of [
      ['Side by side', 'split'],
      ['Unified', 'unified'],
    ] as [string, View][]) {
      const btn = document.createElement('button')
      btn.className = 'diff-btn' + (this.view === value ? ' active' : '')
      btn.textContent = label
      btn.addEventListener('click', () => {
        if (this.view === value) return
        this.view = value
        this.renderHead()
        void this.load()
      })
      this.headEl.appendChild(btn)
    }

    // Wrapping is a property of the view, so it sits with the view buttons —
    // and it is a toggle rather than a third mode, because it composes: either
    // layout can be read wrapped or scrolling.
    const wrap = document.createElement('button')
    wrap.className = 'diff-btn' + (this.wrap ? ' active' : '')
    wrap.textContent = 'Wrap'
    wrap.title = this.wrap ? 'Long lines wrap' : 'Long lines scroll sideways'
    wrap.addEventListener('click', () => {
      this.wrap = !this.wrap
      this.applyWrap()
      this.renderHead()
      // The body is rebuilt, not restyled: wrapping and per-side scrollbars are
      // different DOM shapes, so a class alone would leave the old one standing.
      void this.load()
    })
    this.headEl.appendChild(wrap)

    // Which file you picked first is usually arbitrary, and reading a diff
    // backwards is confusing enough that people re-open the pane to fix it.
    const swap = document.createElement('button')
    swap.className = 'diff-btn'
    swap.textContent = 'Swap'
    swap.disabled = !this.ready()
    swap.addEventListener('click', () => this.set(this.right, this.left))
    this.headEl.appendChild(swap)

    const refresh = document.createElement('button')
    refresh.className = 'diff-btn'
    refresh.textContent = 'Refresh'
    refresh.disabled = !this.ready()
    refresh.addEventListener('click', () => void this.load())
    this.headEl.appendChild(refresh)
  }

  /** The two slots a file can be dropped on, side by side above the diff. */
  private renderPickers(): void {
    this.pickersEl.replaceChildren(this.slot('left'), this.slot('right'))
  }

  private slot(side: 'left' | 'right'): HTMLElement {
    const current = side === 'left' ? this.left : this.right

    const el = document.createElement('div')
    el.className = 'compare-slot' + (current ? ' filled' : '')

    const label = document.createElement('div')
    label.className = 'compare-slot__label'
    label.textContent = current ? name(current) : `Drop a file here`
    if (current) label.title = current
    el.appendChild(label)

    const sub = document.createElement('div')
    sub.className = 'compare-slot__hint'
    sub.textContent = current ? current : side === 'left' ? 'the original' : 'the changed one'
    el.appendChild(sub)

    const pick = document.createElement('button')
    pick.className = 'diff-btn'
    pick.textContent = current ? 'Change…' : 'Choose…'
    pick.addEventListener('click', () => void this.choose(side))
    el.appendChild(pick)

    // Accepting the drag has to be declared on both events or the drop never
    // arrives; preventDefault on dragover is what marks this a valid target.
    el.addEventListener('dragover', (e) => {
      if (!hasFile(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      el.classList.add('over')
    })
    el.addEventListener('dragleave', () => el.classList.remove('over'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('over')
      const path = pathFromDrop(e)
      if (path) this.put(side, path)
    })

    return el
  }

  private async choose(side: 'left' | 'right'): Promise<void> {
    const picked = await backend().pickOpenFile({
      title: side === 'left' ? 'Compare — original' : 'Compare — changed',
      anyFile: true,
    })
    if (picked) this.put(side, picked)
  }

  private put(side: 'left' | 'right', path: string): void {
    if (side === 'left') this.set(path, this.right)
    else this.set(this.left, path)
  }

  private set(left: string, right: string): void {
    this.left = left
    this.right = right
    store.setCompareFiles(this.paneId, left, right)
    this.renderHead()
    this.renderPickers()
    void this.load()
  }

  private ready(): boolean {
    return Boolean(this.left && this.right)
  }

  // ------------------------------------------------------------------- diff

  private async load(): Promise<void> {
    const token = ++this.token
    this.bodyEl.replaceChildren()

    if (!this.ready()) {
      this.say(
        this.left || this.right
          ? 'One more file and this will show what changed.'
          : 'Drop a file onto each side, or use Choose… — any two files, tracked or not.'
      )
      return
    }

    let text: string
    try {
      text = await backend().compareFiles(this.left, this.right)
    } catch (err) {
      if (token !== this.token || this.disposed) return
      this.say(err instanceof Error ? err.message : String(err))
      return
    }
    if (token !== this.token || this.disposed) return

    if (!text.trim()) {
      this.say('The two files are identical.')
      return
    }

    this.bodyEl.replaceChildren(
      this.view === 'split' ? splitView(text, this.wrap) : unifiedView(text)
    )
    this.syncColumns()
  }

  private say(message: string): void {
    const el = document.createElement('div')
    el.className = 'diff-empty'
    el.textContent = message
    this.bodyEl.replaceChildren(el)
  }

  dispose(): void {
    this.disposed = true
  }
}

// ------------------------------------------------------------------ rendering

function unifiedView(text: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'diff-text'
  for (const line of text.split('\n')) {
    const span = document.createElement('span')
    span.className = `diff-line diff-line--${classify(line)}`
    // textContent, always: this is the content of files we did not write.
    span.textContent = line || ' '
    pre.appendChild(span)
  }
  return pre
}

/**
 * The side-by-side body, in one of two shapes.
 *
 * Wrapped, it is a grid per row: a left line that wraps to three makes the row
 * three lines tall and its counterpart still sits opposite it. Nothing about
 * that survives being cut into two independently scrolling columns, which is
 * why wrapping and per-side scrollbars are alternatives rather than options.
 *
 * Unwrapped, it is two columns that each scroll sideways on their own, so a
 * three-hundred-character line on one side no longer drags the other side out
 * of view. Every line is exactly one line tall there, so the two columns stay
 * in step by construction — the vertical scroll is what has to be kept in sync,
 * and `ComparePane.syncColumns` does that.
 */
function splitView(text: string, wrap: boolean): HTMLElement {
  const rows = toRows(text)
  if (wrap) return rowGrid(rows)

  const pair = document.createElement('div')
  pair.className = 'compare-columns'

  const columns = [0, 1].map(() => {
    const col = document.createElement('div')
    col.className = 'compare-col'
    const inner = document.createElement('div')
    // Holds the column open to its widest line, so a highlighted line's colour
    // runs the full scrollable width instead of stopping at the fold.
    inner.className = 'compare-col__inner'
    col.appendChild(inner)
    return { col, inner }
  })

  for (const row of rows) {
    if (row.kind === 'hunk') {
      // The header goes on the left and an empty twin on the right: the two
      // columns must gain the same number of lines or they drift apart.
      for (const [i, { inner }] of columns.entries()) {
        const label = document.createElement('div')
        label.className = 'compare-cell compare-cell--hunk'
        label.textContent = i === 0 ? (row.left?.text ?? '') : ''
        inner.appendChild(label)
      }
      continue
    }
    columns[0].inner.appendChild(cell(row.left, row.left && row.kind !== 'ctx' ? 'del' : 'ctx'))
    columns[1].inner.appendChild(cell(row.right, row.right && row.kind !== 'ctx' ? 'add' : 'ctx'))
  }

  pair.append(columns[0].col, columns[1].col)
  return pair
}

/** The wrapped shape: one grid per row, sharing a single scroller. */
function rowGrid(rows: readonly Row[]): HTMLElement {
  const table = document.createElement('div')
  table.className = 'compare-split'

  for (const row of rows) {
    if (row.kind === 'hunk') {
      const sep = document.createElement('div')
      sep.className = 'compare-row compare-row--hunk'
      const label = document.createElement('div')
      label.className = 'compare-cell compare-cell--hunk'
      label.textContent = row.left?.text ?? ''
      sep.appendChild(label)
      table.appendChild(sep)
      continue
    }

    const el = document.createElement('div')
    el.className = 'compare-row'
    el.appendChild(cell(row.left, row.left && row.kind !== 'ctx' ? 'del' : 'ctx'))
    el.appendChild(cell(row.right, row.right && row.kind !== 'ctx' ? 'add' : 'ctx'))
    table.appendChild(el)
  }
  return table
}

function cell(side: { n: number; text: string } | null, kind: string): HTMLElement {
  const el = document.createElement('div')
  el.className = `compare-cell compare-cell--${side ? kind : 'blank'}`

  const num = document.createElement('span')
  num.className = 'compare-num'
  num.textContent = side ? String(side.n) : ''
  el.appendChild(num)

  const text = document.createElement('span')
  text.className = 'compare-text'
  // textContent, always: this is the content of files we did not write.
  text.textContent = side ? side.text || ' ' : ''
  el.appendChild(text)

  return el
}

/**
 * Turns a unified diff into aligned rows.
 *
 * Within a hunk, a run of removals followed by a run of additions is one edit
 * seen from both sides, so the two runs are zipped: first removal opposite first
 * addition, and so on. Whichever run is longer leaves blank cells opposite its
 * tail. Pairing them this way is what makes a changed line readable as a change
 * rather than as a deletion and an unrelated insertion further down.
 */
function toRows(text: string): Row[] {
  const rows: Row[] = []
  let leftNo = 0
  let rightNo = 0
  let dels: { n: number; text: string }[] = []
  let adds: { n: number; text: string }[] = []

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null, kind: dels[i] ? 'del' : 'add' })
    }
    dels = []
    adds = []
  }

  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      flush()
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      if (m) {
        leftNo = Number(m[1])
        rightNo = Number(m[2])
      }
      rows.push({ left: { n: 0, text: line }, right: null, kind: 'hunk' })
      continue
    }
    // Everything before the first hunk is git's own header — file names, index
    // lines, mode changes. The hunk separators carry that information already.
    if (!rows.length) continue

    if (line.startsWith('-')) {
      dels.push({ n: leftNo++, text: line.slice(1) })
    } else if (line.startsWith('+')) {
      adds.push({ n: rightNo++, text: line.slice(1) })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" belongs to the line above, not a row.
      continue
    } else {
      flush()
      const body = line.startsWith(' ') ? line.slice(1) : line
      rows.push({
        left: { n: leftNo++, text: body },
        right: { n: rightNo++, text: body },
        kind: 'ctx',
      })
    }
  }
  flush()
  return rows
}

// --------------------------------------------------------------------- drops

/** Whether a drag carries something we could take a path from. */
function hasFile(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return types.includes(FILE_DRAG) || types.includes('Files')
}

/**
 * The path behind a drop.
 *
 * A drag from our own file tree carries the path outright and works everywhere.
 * A drag from Explorer carries a `File`, and turning that into a location is
 * host-specific — `pathForFile` returns '' where the runtime cannot say, and
 * the picker button is the way through.
 */
function pathFromDrop(e: DragEvent): string {
  const internal = e.dataTransfer?.getData(FILE_DRAG)
  if (internal) return internal
  const file = e.dataTransfer?.files?.[0]
  return file ? backend().pathForFile(file) : ''
}

function name(full: string): string {
  const cut = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'))
  return cut === -1 ? full : full.slice(cut + 1)
}
