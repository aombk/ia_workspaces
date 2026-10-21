/**
 * GitHub-flavoured Markdown, rendered without a library and without HTML.
 *
 * Hand-rolled rather than pulled in, for the same reason the icon generator is:
 * this is a terminal, and a Markdown library is a dependency, a bundle-size
 * increase and a supply-chain surface. It began as "enough to read a README" —
 * headings, lists, code — and that turned out to be too little: a document
 * that is mostly tables, which is what people (and agents) actually write,
 * came out as one paragraph of pipes. So it now covers what GitHub renders:
 * tables with alignment, nested lists that continue across lines and start at
 * any number, nested quotes, setext headings, indented code, `~~~` fences,
 * nested inline formatting, strikethrough, autolinks and bare URLs, reference
 * links, footnotes, backslash escapes, entities and hard line breaks.
 *
 * What is still deliberately left out is raw HTML. A README is a file from a
 * repository you may have only just cloned, and passing its HTML into the
 * document would make reading one an execution. A handful of harmless inline
 * tags people use for typography — `<br>`, `<kbd>`, `<sub>`, `<sup>`, `<mark>`
 * and the like — are recognised by name and built fresh, with no attributes, so
 * nothing the file wrote is ever parsed as markup. Everything else shows as the
 * text it is.
 *
 * Returns a DOM fragment, not an HTML string: nothing here is ever parsed as
 * markup, so text can only ever become text.
 */
import { encodeImagePath } from '../shared/images'
import { isNetworkPath } from '../shared/pathUrl'
import { renderFlowchart } from './flowchart'

/** How a document that can be written to answers a tick. See `toggleTaskLine`. */
export interface MarkdownOptions {
  /**
   * A checkbox was ticked or cleared, on this line of the source.
   *
   * Its absence is what makes a checklist read-only: without it the boxes are
   * drawn disabled, because a box that moves when clicked and changes nothing
   * on disk is a worse answer than one that plainly cannot be clicked.
   */
  onToggle?: (line: number, checked: boolean) => void
}

/** A task item's box, wherever the line starts: `- [ ]`, `* [x]`, `2. [ ]`. */
const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/

/**
 * The same document with one box ticked or cleared, or null when that line is
 * not the task it was drawn from.
 *
 * Null is the answer to a file that has changed underneath the reader — an
 * agent rewriting the very checklist you are ticking is the ordinary case here,
 * not a rare one — and the caller shows what is now on disk rather than writing
 * a tick onto whatever line happens to be in that position.
 *
 * The source's own line endings survive: a CRLF file patched with a bare `\n`
 * is a file every line of which reads as changed to whatever shows a diff.
 */
export function toggleTaskLine(source: string, line: number, checked: boolean): string | null {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const target = lines[line]
  if (target === undefined || !TASK_LINE.test(target)) return null
  lines[line] = target.replace(TASK_LINE, (_m, open: string, _box: string, close: string) =>
    `${open}${checked ? 'x' : ' '}${close}`
  )
  return lines.join(eol)
}

/** The folder part of a file path, for resolving what it points at. */
export function folderOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut < 0 ? '' : file.slice(0, cut)
}

/**
 * Resolves a Markdown image path against the folder its file sits in.
 *
 * Returns null for anything that should not become an `<img>`: an absolute URL
 * (see `image` for why remote images are not loaded), a `data:` payload, or a
 * path given with no folder to resolve it against.
 *
 * `..` is honoured because README images genuinely live above the file — a doc
 * in `docs/` reaching `../screenshots/x.png` is ordinary — and there is nothing
 * to defend here: the pane can already open any file on disk, so a path that
 * climbs out of the folder grants no reach the user did not already have.
 */
export function resolveImage(src: string, baseDir: string): string | null {
  if (!baseDir) return null
  // A URL scheme — `https:`, `data:` — is not a file. Two characters at
  // least: a lone letter and a colon is a Windows drive, and matching it here
  // meant `![](C:\pics\a.png)` never rendered, whatever the comment below says.
  if (/^[a-z][a-z0-9+.-]+:/i.test(src)) return null
  // A document pointing at another machine. Loading it would connect there —
  // on Windows, authenticating as you — on the strength of a file somebody
  // else wrote. See `isNetworkPath`. A relative path cannot reach another
  // machine, so images beside a document opened from a share still load.
  if (isNetworkPath(src)) return null

  const sep = baseDir.includes('\\') ? '\\' : '/'
  // Already absolute — a POSIX root, a drive letter or a UNC share.
  const absolute = /^([/\\]|[a-z]:)/i.test(src)
  const parts = absolute ? [] : baseDir.split(/[/\\]/)

  for (const part of src.split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return absolute ? src : parts.join(sep)
}

// ------------------------------------------------------------------ shared

/** A line of the source and where it came from — the number a tick writes back to. */
interface Line {
  text: string
  no: number
}

/** `[label]: url "title"`, collected before anything is drawn. */
interface Definition {
  href: string
  title: string
}

/** Everything one render shares: the folder, the options, and what the document defines. */
interface Context {
  baseDir: string
  opts: MarkdownOptions
  refs: Map<string, Definition>
  /** Footnote bodies by label, and the order they were first cited in. */
  notes: Map<string, Line[]>
  cited: string[]
  /** Slugs already given to a heading, so two "Notes" headings get two anchors. */
  slugs: Map<string, number>
  /** The source as written, for asking whether a task's own line can be patched. */
  source: string[]
}

/** Labels match case-insensitively and with runs of space collapsed, as GitHub does. */
const normalizeLabel = (label: string): string => label.trim().replace(/\s+/g, ' ').toLowerCase()

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

/** Tabs at the start of a line count as four columns, which is all indentation is used for. */
const expandIndent = (text: string): string =>
  text.replace(/^[ \t]+/, (lead) => lead.replace(/\t/g, '    '))

const indentOf = (text: string): number => /^ */.exec(text)![0].length

const isBlank = (text: string): boolean => !text.trim()

// ------------------------------------------------------------------- blocks

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}> ?(.*)$/
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/
const FOOTNOTE = /^ {0,3}\[\^([^\]\s]+)\]:\s?(.*)$/

/** A list marker and what the item's text is indented by. */
function listMarker(text: string): { ordered: boolean; marker: string; start: number; width: number; rest: string } | null {
  const m = LIST_ITEM.exec(text)
  if (!m) return null
  const [, lead, marker, gap = '', rest = ''] = m
  // `-` with nothing after it is an empty item; `-foo` is not an item at all.
  if (!gap && rest) return null
  const ordered = /\d/.test(marker)
  // More than four spaces after the marker is the item starting with indented
  // code, so the text is indented by the marker and one space.
  const spaces = gap.length > 4 ? 1 : Math.max(gap.length, 1)
  return {
    ordered,
    marker: ordered ? marker.slice(-1) : marker,
    start: ordered ? parseInt(marker, 10) : 1,
    width: lead.length + marker.length + spaces,
    rest: gap.length > 4 ? gap.slice(1) + rest : rest,
  }
}

/** The cells of a table row: split on pipes that are not escaped or inside code. */
function splitRow(text: string): string[] {
  let row = text.trim()
  if (row.startsWith('|')) row = row.slice(1)
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1)
  const cells: string[] = []
  let cell = ''
  let ticks = 0
  for (let i = 0; i < row.length; i++) {
    const c = row[i]
    if (c === '\\' && row[i + 1] === '|') {
      cell += '|'
      i++
    } else if (c === '`') {
      let run = 0
      while (row[i + run] === '`') run++
      // A run of backticks opens a code span, and only the same length closes it.
      ticks = ticks === 0 ? run : ticks === run ? 0 : ticks
      cell += '`'.repeat(run)
      i += run - 1
    } else if (c === '|' && ticks === 0) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += c
    }
  }
  cells.push(cell.trim())
  return cells
}

/** Whether a table starts here: a row of pipes with a matching rule under it. */
function tableAt(lines: Line[], i: number): boolean {
  const head = lines[i]?.text
  const rule = lines[i + 1]?.text
  if (head === undefined || rule === undefined || !head.includes('|') || !TABLE_RULE.test(rule)) return false
  // A rule needs a pipe, or a one-column table could not be told from a setext
  // heading's underline.
  if (!rule.includes('|') && !head.trim().startsWith('|')) return false
  return splitRow(head).length === splitRow(rule).length
}

/** Lines that end a paragraph without a blank line in between. */
function interrupts(lines: Line[], i: number): boolean {
  const text = expandIndent(lines[i].text)
  return (
    FENCE_OPEN.test(text) ||
    /^\s*<!--/.test(text) ||
    ATX.test(text) ||
    RULE.test(text) ||
    QUOTE.test(text) ||
    (listMarker(text) !== null && !isBlank(listMarker(text)!.rest)) ||
    tableAt(lines, i)
  )
}

/** A GitHub-style anchor for a heading, unique within the document. */
function slugFor(text: string, ctx: Context): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s/g, '-') || 'section'
  const seen = ctx.slugs.get(base) ?? 0
  ctx.slugs.set(base, seen + 1)
  return seen ? `${base}-${seen}` : base
}

function heading(level: number, text: string, ctx: Context): HTMLElement {
  const h = el(`h${Math.min(Math.max(level, 1), 6)}` as 'h1')
  h.appendChild(inline(text, ctx))
  // An attribute rather than `id`: several documents can be open at once, and
  // ids have to be unique across the whole window.
  h.dataset.anchor = slugFor(h.textContent ?? '', ctx)
  return h
}

/**
 * Renders a run of lines as blocks into `out`.
 *
 * Called for the document and again for whatever a quote or a list item holds,
 * which is how a list inside a quote inside a list comes out right. `tight` is
 * a list item's paragraphs being written as bare text, the way a list with no
 * blank lines in it is shown everywhere.
 */
function blocks(lines: Line[], out: Node, ctx: Context, tight = false): void {
  let i = 0
  while (i < lines.length) {
    const raw = lines[i].text
    const text = expandIndent(raw)

    if (isBlank(text)) {
      i++
      continue
    }

    // Fenced code, with backticks or tildes. The closing fence is optional so an
    // unterminated block at the end of a file still renders as code.
    const fence = FENCE_OPEN.exec(text)
    if (fence) {
      const [, lead, mark, lang] = fence
      const body: string[] = []
      i++
      while (i < lines.length) {
        const line = expandIndent(lines[i].text)
        const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
        if (close && close[1][0] === mark[0] && close[1].length >= mark.length) break
        // The fence's own indent comes off every line, and no more than that.
        body.push(line.slice(Math.min(lead.length, indentOf(line))))
        i++
      }
      if (i < lines.length) i++
      out.appendChild(codeBlock(body.join('\n'), lang))
      continue
    }

    // A comment block, which a README uses for notes to whoever edits it. GitHub
    // shows none of it, and neither does this.
    if (/^\s*<!--/.test(text)) {
      while (i < lines.length && !lines[i].text.includes('-->')) i++
      if (i < lines.length) {
        // Anything written after the close on that same line is content.
        const tail = lines[i].text.slice(lines[i].text.indexOf('-->') + 3)
        if (tail.trim()) {
          lines = [...lines]
          lines[i] = { text: tail, no: lines[i].no }
          continue
        }
        i++
      }
      continue
    }

    // Indented code: four spaces in, and not the continuation of a paragraph
    // (that case never reaches here — the paragraph loop below takes it).
    if (indentOf(text) >= 4) {
      const body: string[] = []
      while (i < lines.length) {
        const line = expandIndent(lines[i].text)
        if (!isBlank(line) && indentOf(line) < 4) break
        body.push(line.slice(4))
        i++
      }
      while (body.length && isBlank(body[body.length - 1])) body.pop()
      out.appendChild(codeBlock(body.join('\n'), ''))
      continue
    }

    const atx = ATX.exec(text)
    if (atx) {
      out.appendChild(heading(atx[1].length, atx[2] ?? '', ctx))
      i++
      continue
    }

    if (RULE.test(text)) {
      out.appendChild(el('hr'))
      i++
      continue
    }

    if (tableAt(lines, i)) {
      i = table(lines, i, out, ctx)
      continue
    }

    if (QUOTE.test(text)) {
      const inner: Line[] = []
      let lazy = false
      while (i < lines.length) {
        const line = expandIndent(lines[i].text)
        const q = QUOTE.exec(line)
        if (q) {
          inner.push({ text: q[1], no: lines[i].no })
          lazy = !isBlank(q[1])
        } else if (lazy && !isBlank(line) && !interrupts(lines, i)) {
          // A paragraph inside a quote carries on without its `>`.
          inner.push({ text: line, no: lines[i].no })
        } else break
        i++
      }
      const quote = el('blockquote')
      blocks(inner, quote, ctx)
      out.appendChild(quote)
      continue
    }

    if (listMarker(text)) {
      i = list(lines, i, out, ctx)
      continue
    }

    // A paragraph runs until a blank line or anything that starts a block — or
    // until an underline turns what came before it into a heading.
    const parts: string[] = [text.replace(/^\s+/, '')]
    i++
    let underline: number | null = null
    while (i < lines.length) {
      const line = expandIndent(lines[i].text)
      if (isBlank(line)) break
      const setext = SETEXT.exec(line)
      if (setext) {
        underline = setext[1][0] === '=' ? 1 : 2
        i++
        break
      }
      if (interrupts(lines, i)) break
      // Trailing spaces are kept: two of them are a hard line break.
      parts.push(line.replace(/^\s+/, ''))
      i++
    }
    if (underline !== null) {
      out.appendChild(heading(underline, parts.join(' '), ctx))
      continue
    }
    const content = inline(parts.join('\n'), ctx)
    if (tight) {
      out.appendChild(content)
    } else {
      const p = el('p')
      p.appendChild(content)
      out.appendChild(p)
    }
  }
}

function codeBlock(body: string, lang: string): HTMLElement {
  // A mermaid block becomes a picture where we can draw it, and stays the code
  // it is where we cannot — a diagram that silently omits the box it failed to
  // parse is worse than the text it replaced. See `shared/flowchart.ts`.
  if (lang.toLowerCase() === 'mermaid') {
    const drawn = renderFlowchart(body)
    if (drawn) {
      const figure = el('div', 'flowchart-figure')
      figure.appendChild(drawn)
      return figure
    }
  }
  const pre = el('pre')
  const code = el('code')
  if (lang) code.dataset.lang = lang
  code.textContent = body
  pre.appendChild(code)
  return pre
}

/** A table from line `i`; returns the line after it. */
function table(lines: Line[], i: number, out: Node, ctx: Context): number {
  const head = splitRow(lines[i].text)
  const align = splitRow(lines[i + 1].text).map((rule) => {
    const left = rule.startsWith(':')
    const right = rule.endsWith(':')
    return left && right ? 'center' : right ? 'right' : left ? 'left' : ''
  })
  i += 2

  const tableEl = el('table')
  const row = (cells: string[], tag: 'th' | 'td'): HTMLTableRowElement => {
    const tr = el('tr')
    // As many cells as the header has: missing ones are empty, extra ones are
    // dropped, which is what GitHub does with a ragged row.
    for (let c = 0; c < head.length; c++) {
      const cell = el(tag)
      if (align[c]) cell.style.textAlign = align[c]
      cell.appendChild(inline(cells[c] ?? '', ctx))
      tr.appendChild(cell)
    }
    return tr
  }

  const thead = el('thead')
  thead.appendChild(row(head, 'th'))
  tableEl.appendChild(thead)

  const tbody = el('tbody')
  while (i < lines.length) {
    const line = lines[i].text
    if (isBlank(line) || (!line.includes('|') && interrupts(lines, i))) break
    if (ATX.test(line) || FENCE_OPEN.test(line) || QUOTE.test(line)) break
    tbody.appendChild(row(splitRow(line), 'td'))
    i++
  }
  if (tbody.childNodes.length) tableEl.appendChild(tbody)

  // Wrapped so a wide table scrolls on its own rather than widening the page.
  const wrap = el('div', 'md-table')
  wrap.appendChild(tableEl)
  out.appendChild(wrap)
  return i
}

/** A list from line `i`, items and all; returns the line after it. */
function list(lines: Line[], i: number, out: Node, ctx: Context): number {
  const first = listMarker(expandIndent(lines[i].text))!
  const listEl = first.ordered ? el('ol') : el('ul')
  if (first.ordered && first.start !== 1) (listEl as HTMLOListElement).start = first.start

  const items: { lines: Line[]; first: Line }[] = []
  let loose = false

  while (i < lines.length) {
    const text = expandIndent(lines[i].text)
    const marker = listMarker(text)
    // Same kind of list, same marker: a `-` list and a `*` list side by side are
    // two lists, as are `1.` and `1)`.
    if (!marker || marker.ordered !== first.ordered || marker.marker !== first.marker) break
    if (indentOf(text) >= first.width && items.length) break

    const width = marker.width
    const own: Line[] = [{ text: marker.rest, no: lines[i].no }]
    const head = lines[i]
    i++
    let blankRun = 0
    while (i < lines.length) {
      const line = expandIndent(lines[i].text)
      if (isBlank(line)) {
        blankRun++
        own.push({ text: '', no: lines[i].no })
        i++
        continue
      }
      if (indentOf(line) >= width) {
        if (blankRun) loose = loose || own.some((l) => !isBlank(l.text))
        own.push({ text: line.slice(width), no: lines[i].no })
        blankRun = 0
        i++
        continue
      }
      // A line that is not indented enough still belongs to the item when it
      // carries on the paragraph above it — the "lazy" continuation people
      // write without thinking about it.
      if (!blankRun && !interrupts(lines, i) && !listMarker(line)) {
        own.push({ text: line.trim(), no: lines[i].no })
        i++
        continue
      }
      break
    }
    // Blank lines at the end of an item belong to whatever follows.
    let trailing = 0
    while (own.length > 1 && isBlank(own[own.length - 1].text)) {
      own.pop()
      trailing++
    }
    items.push({ lines: own, first: head })

    // A blank line between two items makes the whole list loose.
    if (trailing) {
      const next = lines[i] && listMarker(expandIndent(lines[i].text))
      if (next && next.ordered === first.ordered && next.marker === first.marker) loose = true
      else break
    }
  }

  for (const item of items) {
    const li = el('li')
    const task = /^\[([ xX])\][ \t]+(.*)$/.exec(item.lines[0].text) ?? /^\[([ xX])\]$/.exec(item.lines[0].text)
    if (task) {
      // `- [ ] thing`, the one list item that is not prose. The line number is
      // carried on the box: what a tick means is a question for whoever owns
      // the file. See `toggleTaskLine` for the patch itself — and a box on a
      // line it could not patch (one inside a quote) is drawn read-only.
      const at = item.first.no
      const writable = !!ctx.opts.onToggle && TASK_LINE.test(ctx.source[at] ?? '')
      li.className = 'md-task'
      const box = el('input', 'md-check')
      box.type = 'checkbox'
      box.checked = task[1] !== ' '
      box.disabled = !writable
      if (writable) {
        box.title = box.checked ? 'Mark as not done' : 'Mark as done'
        box.addEventListener('change', () => ctx.opts.onToggle?.(at, box.checked))
      }
      const label = el('span', 'md-task__text')
      blocks([{ text: task[2] ?? '', no: item.lines[0].no }, ...item.lines.slice(1)], label, ctx, !loose)
      li.append(box, label)
      // On the list rather than the item: what changes is the shape of the
      // whole list — no bullets, and the text lines up under itself.
      listEl.classList.add('md-tasklist')
    } else {
      blocks(item.lines, li, ctx, !loose)
    }
    listEl.appendChild(li)
  }
  out.appendChild(listEl)
  return i
}

// ------------------------------------------------------------------ inline

/** The tags a document may use for typography. Built fresh, never parsed. */
const INLINE_TAGS = new Set(['b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark', 'kbd', 'sub', 'sup', 'small', 'code', 'q', 'abbr', 'cite', 'var', 'samp'])

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', laquo: '«', raquo: '»', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', times: '×', divide: '÷', plusmn: '±', deg: '°',
  middot: '·', bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  le: '≤', ge: '≥', ne: '≠', check: '✓', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad', ensp: '\u2002', emsp: '\u2003',
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)
const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c)

/** Where the run of `ch` starting at `at` ends. */
function runEnd(s: string, at: number, ch: string): number {
  let end = at
  while (s[end] === ch) end++
  return end
}

/** The index just past a code span opening at `at`, or -1 when it never closes. */
function codeSpanEnd(s: string, at: number): number {
  const open = runEnd(s, at, '`') - at
  let i = at + open
  while (i < s.length) {
    const next = s.indexOf('`', i)
    if (next < 0) return -1
    const len = runEnd(s, next, '`') - next
    if (len === open) return next + len
    i = next + len
  }
  return -1
}

/** Whether a delimiter run can open emphasis, by the flanking rules. */
function canOpen(s: string, at: number, end: number, ch: string): boolean {
  if (isSpace(s[end])) return false
  // `_` inside a word is a word character, not emphasis: `snake_case_name`.
  if (ch === '_' && isWordChar(s[at - 1])) return false
  return true
}

function canClose(s: string, at: number, end: number, ch: string): boolean {
  if (isSpace(s[at - 1])) return false
  if (ch === '_' && isWordChar(s[end])) return false
  return true
}

/**
 * Where the emphasis opened at `from` closes: the start of a closing run at
 * least `need` long, skipping code spans, escapes and nested pairs on the way.
 */
function findCloser(s: string, from: number, ch: string, need: number): number {
  let i = from
  while (i < s.length) {
    const c = s[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '`') {
      const end = codeSpanEnd(s, i)
      i = end < 0 ? runEnd(s, i, '`') : end
      continue
    }
    if (c === ch) {
      const end = runEnd(s, i, ch)
      const len = end - i
      if (canClose(s, i, end, ch) && (len === need || (len >= need && need === 2) || len >= 3)) return i
      // A pair nested inside this one is stepped over whole, so `*a **b** c*`
      // closes at the last star rather than at the first `**`.
      // Only the stars the inner pair uses are stepped over: in `**a *b***` the
      // last run closes the `*` and then, with what is left of it, the `**`.
      if (canOpen(s, i, end, ch)) {
        const innerNeed = len >= 2 ? 2 : 1
        const inner = findCloser(s, end, ch, innerNeed)
        if (inner >= 0) {
          i = inner + innerNeed
          continue
        }
      }
      i = end
      continue
    }
    i++
  }
  return -1
}

/** The end of a bracketed label opening at `at`, balanced, or -1. */
function bracketEnd(s: string, at: number): number {
  let depth = 0
  for (let i = at; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '`') {
      const end = codeSpanEnd(s, i)
      if (end > 0) i = end - 1
      continue
    }
    if (c === '[') depth++
    else if (c === ']' && --depth === 0) return i
  }
  return -1
}

/** `(url "title")` from `at`, with balanced parentheses in the URL. */
function destination(s: string, at: number): { href: string; title: string; end: number } | null {
  if (s[at] !== '(') return null
  let i = at + 1
  while (s[i] === ' ' || s[i] === '\n') i++
  let href = ''
  if (s[i] === '<') {
    const close = s.indexOf('>', i)
    if (close < 0) return null
    href = s.slice(i + 1, close)
    i = close + 1
  } else {
    let depth = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '\\' && PUNCTUATION.test(s[i + 1] ?? '')) {
        href += s[i + 1]
        i += 2
        continue
      }
      if (/\s/.test(c)) break
      if (c === '(') depth++
      if (c === ')') {
        if (depth === 0) break
        depth--
      }
      href += c
      i++
    }
  }
  while (s[i] === ' ' || s[i] === '\n') i++
  let title = ''
  const quote = s[i]
  if (quote === '"' || quote === "'" || quote === '(') {
    const closer = quote === '(' ? ')' : quote
    const close = s.indexOf(closer, i + 1)
    if (close < 0) return null
    title = s.slice(i + 1, close)
    i = close + 1
    while (s[i] === ' ' || s[i] === '\n') i++
  }
  if (s[i] !== ')') return null
  return { href, title, end: i + 1 }
}

/** What a link points at: inline, `[text][label]`, `[text][]` or `[text]`. */
function linkTarget(
  s: string,
  labelEnd: number,
  label: string,
  ctx: Context
): { href: string; title: string; end: number } | null {
  const inlineDest = destination(s, labelEnd + 1)
  if (inlineDest) return inlineDest
  if (s[labelEnd + 1] === '[') {
    const close = s.indexOf(']', labelEnd + 2)
    if (close > 0) {
      const ref = s.slice(labelEnd + 2, close) || label
      const def = ctx.refs.get(normalizeLabel(ref))
      if (def) return { ...def, end: close + 1 }
    }
  }
  const def = ctx.refs.get(normalizeLabel(label))
  return def ? { ...def, end: labelEnd + 1 } : null
}

/**
 * A link's element. Only http(s) survives as something to click: `javascript:`
 * is the reason, and a relative path is the other — it would resolve against
 * the app's own origin and mean nothing. A `#heading` link scrolls the page to
 * that heading, which is what a table of contents is for.
 */
function linkElement(href: string, title: string): HTMLElement {
  const a = el('a')
  if (title) a.title = title
  if (/^https?:\/\//i.test(href)) {
    a.dataset.href = href
    if (!title) a.title = href
  } else if (href.startsWith('#') && href.length > 1) {
    a.className = 'md-anchor'
    const slug = decodeURIComponent(href.slice(1)).toLowerCase()
    a.addEventListener('click', (e) => {
      e.preventDefault()
      const root = a.closest('.markdown') ?? document
      root.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(slug)}"]`)?.scrollIntoView({ block: 'start' })
    })
  } else {
    a.className = 'md-link-inert'
    if (href && !title) a.title = href
  }
  return a
}

/**
 * Local images only, through the app's own image protocol. A remote image is a
 * network request made by opening a file, which tells whoever is serving it
 * that you read this README and from where — the same reason raw HTML is not
 * passed through. Those keep their alt text instead.
 */
function image(src: string, alt: string, title: string, ctx: Context): Node {
  const missing = (): HTMLElement => {
    const note = el('span', 'md-image-missing')
    note.textContent = alt ? `[${alt}]` : `[${src}]`
    return note
  }
  const target = resolveImage(src, ctx.baseDir)
  if (!target) return missing()
  const img = el('img', 'md-image')
  img.src = encodeImagePath(target)
  img.alt = alt
  if (title) img.title = title
  img.loading = 'lazy'
  // A path that is simply wrong should read as a caption, not as a torn icon.
  img.addEventListener('error', () => img.replaceWith(missing()))
  return img
}

/** A footnote reference, numbered by the order notes are first cited in. */
function footnoteRef(label: string, ctx: Context): HTMLElement {
  let n = ctx.cited.indexOf(label)
  if (n < 0) n = ctx.cited.push(label) - 1
  const sup = el('sup', 'md-footnote-ref')
  const a = linkElement(`#fn-${label}`, '')
  a.textContent = String(n + 1)
  sup.appendChild(a)
  return sup
}

/**
 * Inline Markdown into nodes: code, escapes, entities, emphasis of every kind
 * nested in every other, links (inline, reference, auto and bare), images,
 * `[[wiki links]]`, footnote references, the safe inline tags, and line breaks.
 */
function inline(s: string, ctx: Context, inLink = false): DocumentFragment {
  const frag = document.createDocumentFragment()
  let text = ''
  const flush = (): void => {
    if (text) frag.appendChild(document.createTextNode(text))
    text = ''
  }
  const push = (node: Node): void => {
    flush()
    frag.appendChild(node)
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    // A bounded look ahead, and only for the rules that match by pattern.
    // Sliced to the end of the string on every character, a long paragraph
    // cost its length squared; nothing those rules match is anywhere near this.
    const rest = c === '<' || c === '&' || c === '[' || c === 'h' || c === 'w' ? s.slice(i, i + 4096) : ''

    if (c === '\\') {
      if (s[i + 1] === '\n') {
        push(el('br'))
        i += 2
        continue
      }
      if (PUNCTUATION.test(s[i + 1] ?? '')) {
        text += s[i + 1]
        i += 2
        continue
      }
    }

    if (c === '\n') {
      // Two spaces before a line end are a hard break; one line end alone is a
      // space, as in every Markdown reader.
      if (/ {2,}$/.test(text)) {
        text = text.replace(/ +$/, '')
        push(el('br'))
      } else {
        text = text.replace(/ +$/, '') + '\n'
      }
      i++
      continue
    }

    if (c === '`') {
      const end = codeSpanEnd(s, i)
      const open = runEnd(s, i, '`') - i
      if (end < 0) {
        text += '`'.repeat(open)
        i += open
        continue
      }
      let body = s.slice(i + open, end - open).replace(/\n/g, ' ')
      if (/^ .* $/.test(body) && body.trim()) body = body.slice(1, -1)
      const code = el('code')
      code.textContent = body
      push(code)
      i = end
      continue
    }

    if (c === '&') {
      const entity = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/.exec(rest)
      if (entity) {
        const [whole, dec, hex, name] = entity
        const point = dec ? parseInt(dec, 10) : hex ? parseInt(hex, 16) : -1
        const value = point >= 0 ? (point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\ufffd') : ENTITIES[name]
        if (value !== undefined) {
          text += value
          i += whole.length
          continue
        }
      }
    }

    if (c === '<') {
      // An HTML comment, kept out of the page as a note to whoever edits it.
      if (rest.startsWith('<!--')) {
        const close = s.indexOf('-->', i + 4)
        i = close < 0 ? s.length : close + 3
        continue
      }
      const auto = /^<((?:https?|ftp):\/\/[^\s<>]+)>/i.exec(rest)
      if (auto && !inLink) {
        const a = linkElement(auto[1], '')
        a.textContent = auto[1]
        push(a)
        i += auto[0].length
        continue
      }
      const mail = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(rest)
      if (mail) {
        text += mail[1]
        i += mail[0].length
        continue
      }
      const br = /^<br\s*\/?>/i.exec(rest)
      if (br) {
        push(el('br'))
        i += br[0].length
        continue
      }
      const tag = /^<([a-z]+)>/i.exec(rest)
      if (tag && INLINE_TAGS.has(tag[1].toLowerCase())) {
        const name = tag[1].toLowerCase()
        const close = s.toLowerCase().indexOf(`</${name}>`, i + tag[0].length)
        if (close > 0) {
          const node = document.createElement(name)
          node.appendChild(inline(s.slice(i + tag[0].length, close), ctx, inLink))
          push(node)
          i = close + name.length + 3
          continue
        }
      }
    }

    if (c === '!' && s[i + 1] === '[') {
      const end = bracketEnd(s, i + 1)
      if (end > 0) {
        const alt = s.slice(i + 2, end)
        const target = linkTarget(s, end, alt, ctx)
        if (target) {
          push(image(target.href, alt.replace(/\\(.)/g, '$1'), target.title, ctx))
          i = target.end
          continue
        }
      }
    }

    // No link inside a link: the label of one is drawn as text and formatting.
    if (c === '[' && !inLink) {
      // `[[name]]`, or `[[name|what to call it]]`: the convention Obsidian and
      // every wiki before it use. Nothing is resolved here — the pane that
      // shows the document decides what a click does.
      const wiki = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
      if (wiki) {
        const button = el('button', 'md-wikilink')
        button.type = 'button'
        button.dataset.wiki = wiki[1].trim()
        button.textContent = (wiki[2] ?? wiki[1]).trim()
        button.title = `Open ${wiki[1].trim()}`
        push(button)
        i += wiki[0].length
        continue
      }
      const note = /^\[\^([^\]\s]+)\]/.exec(rest)
      if (note && ctx.notes.has(note[1])) {
        push(footnoteRef(note[1], ctx))
        i += note[0].length
        continue
      }
      const end = bracketEnd(s, i)
      if (end > 0) {
        const label = s.slice(i + 1, end)
        const target = linkTarget(s, end, label, ctx)
        if (target) {
          const a = linkElement(target.href, target.title)
          a.appendChild(inline(label, ctx, true))
          push(a)
          i = target.end
          continue
        }
      }
    }

    // A bare URL, as GitHub links one: `https://…` or `www.…` starting a word,
    // with trailing punctuation left out of it.
    if ((c === 'h' || c === 'w') && !inLink && !isWordChar(s[i - 1])) {
      const bare = /^(?:https?:\/\/|www\.)[^\s<]+/i.exec(rest)
      if (bare) {
        let url = bare[0]
        // Punctuation that ends the sentence is not the URL's, and a closing
        // paren is the URL's only if it has an opening one: `(see …/Foo_(bar))`.
        for (;;) {
          if (/[.,:;"'!?*_~\]]$/.test(url)) url = url.slice(0, -1)
          else if (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
          else break
        }
        if (/^(?:https?:\/\/|www\.)$/i.test(url)) {
          text += c
          i++
          continue
        }
        const a = linkElement(url.startsWith('www.') ? `https://${url}` : url, '')
        a.textContent = url
        push(a)
        i += url.length
        continue
      }
    }

    if (c === '~' && s[i + 1] === '~') {
      const end = runEnd(s, i, '~')
      if (end - i === 2 && !isSpace(s[end])) {
        const close = s.indexOf('~~', end)
        if (close > end && !isSpace(s[close - 1])) {
          const del = el('del')
          del.appendChild(inline(s.slice(end, close), ctx, inLink))
          push(del)
          i = close + 2
          continue
        }
      }
    }

    if (c === '*' || c === '_') {
      const end = runEnd(s, i, c)
      const len = end - i
      if (canOpen(s, i, end, c)) {
        // Strong and emphasis together, then strong, then emphasis — the
        // longest pair that actually closes.
        for (const want of len >= 3 ? [3, 2, 1] : len === 2 ? [2, 1] : [1]) {
          const close = findCloser(s, end, c, want)
          if (close < 0) continue
          const closeLen = runEnd(s, close, c) - close
          if (closeLen < want) continue
          // Leftover delimiters on the left are literal, as they are anywhere.
          text += c.repeat(len - want)
          const inner = inline(s.slice(end, close), ctx, inLink)
          let node: HTMLElement
          if (want === 3) {
            node = el('strong')
            const em = el('em')
            em.appendChild(inner)
            node.appendChild(em)
          } else {
            node = el(want === 2 ? 'strong' : 'em')
            node.appendChild(inner)
          }
          push(node)
          i = close + want
          break
        }
        if (i !== end - len) continue
      }
      text += s.slice(i, end)
      i = end
      continue
    }

    text += c
    i++
  }
  flush()
  return frag
}

// ------------------------------------------------------------------ document

/**
 * Pulls `[label]: url` and `[^note]: text` out of the source — outside code —
 * since a reference can be used above where it is defined.
 */
function collectDefinitions(lines: Line[], ctx: Context): Line[] {
  const kept: Line[] = []
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text
    const open = FENCE_OPEN.exec(expandIndent(text))
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(text)) fence = null
      kept.push(lines[i])
      continue
    }
    if (open) {
      fence = open[2]
      kept.push(lines[i])
      continue
    }
    const note = FOOTNOTE.exec(text)
    if (note) {
      const body: Line[] = [{ text: note[2], no: lines[i].no }]
      // The note carries on over indented lines, and blank lines between them.
      while (i + 1 < lines.length && (indentOf(expandIndent(lines[i + 1].text)) >= 4 || (isBlank(lines[i + 1].text) && indentOf(expandIndent(lines[i + 2]?.text ?? '')) >= 4))) {
        i++
        body.push({ text: expandIndent(lines[i].text).slice(4), no: lines[i].no })
      }
      ctx.notes.set(note[1], body)
      continue
    }
    const def = DEFINITION.exec(text)
    // Only where a paragraph could not be carrying on, which is a blank line or
    // another definition above it.
    if (def && !def[1].startsWith('^') && (i === 0 || isBlank(lines[i - 1].text) || DEFINITION.test(lines[i - 1].text))) {
      const key = normalizeLabel(def[1])
      if (!ctx.refs.has(key)) ctx.refs.set(key, { href: def[2], title: def[3] ?? def[4] ?? def[5] ?? '' })
      continue
    }
    kept.push(lines[i])
  }
  return kept
}

/**
 * Renders Markdown source into a fragment ready to mount.
 *
 * `baseDir` is the folder the source came from, which is what makes a relative
 * image path mean anything. Omitted — for text with no file behind it — images
 * fall back to their alt text rather than pointing at nowhere.
 */
export function renderMarkdown(
  source: string,
  baseDir = '',
  opts: MarkdownOptions = {}
): DocumentFragment {
  const out = document.createDocumentFragment()
  const raw = source.replace(/\r\n?/g, '\n').split('\n')
  const ctx: Context = { baseDir, opts, refs: new Map(), notes: new Map(), cited: [], slugs: new Map(), source: raw }
  const lines = raw.map((text, no) => ({ text, no }))

  blocks(collectDefinitions(lines, ctx), out, ctx)

  // Footnotes at the foot, in the order they were cited, each with a way back.
  if (ctx.cited.length) {
    const section = el('section', 'md-footnotes')
    section.appendChild(el('hr'))
    const ol = el('ol')
    // Cited notes can cite further notes, so the list grows while it is drawn.
    for (let n = 0; n < ctx.cited.length; n++) {
      const label = ctx.cited[n]
      const li = el('li')
      li.dataset.anchor = `fn-${label}`.toLowerCase()
      blocks(ctx.notes.get(label) ?? [], li, ctx, true)
      ol.appendChild(li)
    }
    section.appendChild(ol)
    out.appendChild(section)
  }

  return out
}
