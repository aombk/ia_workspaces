/**
 * The editing commands, as arithmetic on a string.
 *
 * Every one of these takes the whole document plus a selection and returns a
 * new document plus where the selection ended up. No DOM, no caret, no class:
 * the editor applies the result, and `tests/textOps.test.mjs` can hold every
 * edge case — an empty selection, a selection running backwards, the last line
 * without a trailing newline — without a browser anywhere near it.
 *
 * Offsets are character offsets into the text, the same units the editor's
 * caret uses.
 */

/** A selection, or a caret when `from === to`. */
export interface Span {
  from: number
  to: number
}

/** A document and where the selection sits in it. */
export interface Edit {
  text: string
  from: number
  to: number
}

/** Selections can run backwards; every operation here wants them ordered. */
export function ordered(span: Span): Span {
  return span.from <= span.to ? span : { from: span.to, to: span.from }
}

/** The offsets of the lines a selection touches, whole lines included. */
export function lineSpan(text: string, span: Span): Span {
  const { from, to } = ordered(span)
  const start = text.lastIndexOf('\n', from - 1) + 1
  const end = text.indexOf('\n', to)
  return { from: start, to: end === -1 ? text.length : end }
}

/** The index of the line an offset is on. */
export function lineAt(text: string, offset: number): number {
  let line = 0
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++
  return line
}

/** The offset a line starts at. */
export function offsetOfLine(text: string, line: number): number {
  let at = 0
  for (let n = 0; n < line; n++) {
    const next = text.indexOf('\n', at)
    if (next === -1) return text.length
    at = next + 1
  }
  return at
}

// ------------------------------------------------------------ line operations

/** Copies the touched lines below themselves. */
export function duplicateLines(text: string, span: Span): Edit {
  const { from, to } = lineSpan(text, span)
  const block = text.slice(from, to)
  const insertAt = to
  return {
    text: `${text.slice(0, insertAt)}\n${block}${text.slice(insertAt)}`,
    // The copy is selected, not the original: the next thing you do is edit it.
    from: insertAt + 1,
    to: insertAt + 1 + block.length,
  }
}

/** Removes the touched lines, and the newline that separated them. */
export function deleteLines(text: string, span: Span): Edit {
  const { from, to } = lineSpan(text, span)
  // Take the newline *after* the block, or the one before it on the last line,
  // so deleting never leaves a blank line where a line used to be.
  const cutTo = to < text.length ? to + 1 : to
  const cutFrom = to >= text.length && from > 0 ? from - 1 : from
  return { text: text.slice(0, cutFrom) + text.slice(cutTo), from: cutFrom, to: cutFrom }
}

/** Swaps the touched lines with the line above or below. */
export function moveLines(text: string, span: Span, direction: -1 | 1): Edit {
  const block = lineSpan(text, span)
  const lines = text.split('\n')
  const first = lineAt(text, block.from)
  const last = lineAt(text, block.to)
  const target = direction === -1 ? first - 1 : last + 1
  if (target < 0 || target >= lines.length) return { text, from: span.from, to: span.to }

  const moved = lines.splice(first, last - first + 1)
  lines.splice(direction === -1 ? first - 1 : first + 1, 0, ...moved)
  const next = lines.join('\n')
  const shift = offsetOfLine(next, first + direction) - block.from
  return { text: next, from: span.from + shift, to: span.to + shift }
}

/**
 * Rewrites the touched lines, whatever "rewrites" means to the caller.
 *
 * Every operation below is the same three steps — take the whole lines the
 * selection touches, transform that list, put it back and select the result —
 * so they are one function and a lambda rather than eight copies of the
 * bookkeeping. A selection that touches nothing takes the whole document,
 * because "remove duplicate lines" with no selection means the file.
 */
function overLines(text: string, span: Span, transform: (lines: string[]) => string[]): Edit {
  const whole = span.from === span.to
  const { from, to } = whole ? { from: 0, to: text.length } : lineSpan(text, span)
  const block = transform(text.slice(from, to).split('\n')).join('\n')
  return { text: text.slice(0, from) + block + text.slice(to), from, to: from + block.length }
}

/** Sorts the touched lines, case-insensitively, as a person would expect. */
export function sortLines(text: string, span: Span, descending = false): Edit {
  return overLines(text, span, (lines) => {
    const sorted = [...lines].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
    )
    return descending ? sorted.reverse() : sorted
  })
}

/** Turns the touched lines upside down. */
export function reverseLines(text: string, span: Span): Edit {
  return overLines(text, span, (lines) => [...lines].reverse())
}

/**
 * Drops blank lines.
 *
 * Blank means nothing but whitespace: a line of three spaces looks empty and
 * is what "remove empty lines" is usually aimed at.
 */
export function removeEmptyLines(text: string, span: Span): Edit {
  return overLines(text, span, (lines) => {
    const kept = lines.filter((line) => line.trim())
    // Never leave nothing at all; an empty block would join the lines either
    // side of it into one.
    return kept.length ? kept : ['']
  })
}

/**
 * Keeps the first of each repeated line.
 *
 * Not sorted first, and not sorted after: the order you had is information,
 * and an operation that quietly reorders a file is one you cannot undo by eye.
 */
export function removeDuplicateLines(text: string, span: Span): Edit {
  return overLines(text, span, (lines) => {
    const seen = new Set<string>()
    return lines.filter((line) => {
      if (seen.has(line)) return false
      seen.add(line)
      return true
    })
  })
}

/**
 * Joins the touched lines into one, with a single space between them.
 *
 * Indentation on the joined-in lines goes: it was there to say where the line
 * sat, and after a join it says nothing.
 */
export function joinLines(text: string, span: Span): Edit {
  return overLines(text, span, (lines) => {
    if (lines.length < 2) return lines
    const [first, ...rest] = lines
    return [rest.reduce((all, line) => `${all.replace(/\s+$/, '')} ${line.trim()}`, first).trim()]
  })
}

/** Drops trailing spaces and tabs from every line of the document. */
export function trimTrailing(text: string, span: Span): Edit {
  const next = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
  const clamp = (n: number) => Math.min(n, next.length)
  return { text: next, from: clamp(span.from), to: clamp(span.to) }
}

// ---------------------------------------------------------------- commenting

/**
 * Comments the touched lines, or uncomments them if they are already commented.
 *
 * "Already commented" means *every* non-blank line is, which is the rule that
 * makes the command its own inverse on a block you just commented. The marker
 * goes at the shallowest indent in the block rather than at column zero, so an
 * indented block keeps its shape.
 */
export function toggleComment(text: string, span: Span, marker: string): Edit {
  if (!marker) return { text, from: span.from, to: span.to }
  const { from, to } = lineSpan(text, span)
  const lines = text.slice(from, to).split('\n')
  const meaningful = lines.filter((line) => line.trim())
  if (!meaningful.length) return { text, from: span.from, to: span.to }

  const commented = meaningful.every((line) => line.trimStart().startsWith(marker))
  let next: string[]
  if (commented) {
    next = lines.map((line) => {
      const at = line.indexOf(marker)
      if (at === -1) return line
      const after = line.slice(at + marker.length)
      // A space we added when commenting is a space we take back now.
      return line.slice(0, at) + (after.startsWith(' ') ? after.slice(1) : after)
    })
  } else {
    const indent = Math.min(
      ...meaningful.map((line) => line.length - line.trimStart().length)
    )
    next = lines.map((line) =>
      line.trim() ? `${line.slice(0, indent)}${marker} ${line.slice(indent)}` : line
    )
  }
  const block = next.join('\n')
  return { text: text.slice(0, from) + block + text.slice(to), from, to: from + block.length }
}

// ---------------------------------------------------------------------- case

export type CaseKind = 'upper' | 'lower' | 'title'

/** Changes the case of the selection, or of the word the caret is in. */
export function changeCase(text: string, span: Span, kind: CaseKind): Edit {
  const range = span.from === span.to ? wordAround(text, span.from) : ordered(span)
  const source = text.slice(range.from, range.to)
  if (!source) return { text, from: span.from, to: span.to }
  const changed =
    kind === 'upper'
      ? source.toUpperCase()
      : kind === 'lower'
        ? source.toLowerCase()
        : source.replace(/\w\S*/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase())
  return {
    text: text.slice(0, range.from) + changed + text.slice(range.to),
    from: range.from,
    to: range.from + changed.length,
  }
}

/** The word under an offset, for the commands that work without a selection. */
export function wordAround(text: string, at: number): Span {
  const isWord = (char: string) => /[A-Za-z0-9_$-]/.test(char)
  let from = at
  let to = at
  while (from > 0 && isWord(text[from - 1])) from--
  while (to < text.length && isWord(text[to])) to++
  return { from, to }
}

// ---------------------------------------------------------------------- find

export interface FindOptions {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

/** Every match in the document, in order. Empty when the query cannot match. */
export function findAll(text: string, query: string, opts: FindOptions = {}): Span[] {
  if (!query) return []
  const found: Span[] = []
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, opts.caseSensitive ? 'g' : 'gi')
    } catch {
      // A half-typed pattern is not an error worth shouting about; it simply
      // matches nothing until it is finished.
      return []
    }
    for (const match of text.matchAll(re)) {
      // A zero-width match would loop forever and means nothing to a reader.
      if (!match[0]) continue
      found.push({ from: match.index, to: match.index + match[0].length })
    }
    return found
  }

  const haystack = opts.caseSensitive ? text : text.toLowerCase()
  const needle = opts.caseSensitive ? query : query.toLowerCase()
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const end = at + needle.length
    if (!opts.wholeWord || isWholeWord(text, at, end)) found.push({ from: at, to: end })
    at = haystack.indexOf(needle, at + 1)
  }
  return found
}

function isWholeWord(text: string, from: number, to: number): boolean {
  const word = /[A-Za-z0-9_]/
  const before = from > 0 ? text[from - 1] : ''
  const after = to < text.length ? text[to] : ''
  return !word.test(before) && !word.test(after)
}

/** The next match at or after `from`, wrapping to the top. */
export function findNext(
  text: string,
  query: string,
  from: number,
  opts: FindOptions = {},
  backwards = false
): Span | null {
  const all = findAll(text, query, opts)
  if (!all.length) return null
  if (backwards) {
    const before = all.filter((span) => span.to < from || (span.to === from && span.from < from))
    return before.length ? before[before.length - 1] : all[all.length - 1]
  }
  return all.find((span) => span.from >= from) ?? all[0]
}

/**
 * The next match for an interactive find bar, given the last one it landed on.
 *
 * `findNext` answers "what comes after this offset", which is one question. A
 * find bar asks two, down the same channel, and they want different offsets:
 *
 * - **The query changed** — another letter typed, a toggle flipped. That is the
 *   same search getting more specific, so it starts at the *beginning* of the
 *   current match. Type `a`, then `ab`, and the `ab` under the cursor is what
 *   you get. Starting past the match instead makes every keystroke walk forward
 *   through the file, which is the behaviour of a search you cannot aim.
 * - **A step** — Enter, or the arrows. That starts *past* the current match, or
 *   it hands back the one already found and Enter appears not to work.
 *
 * `anchor` is the match last landed on, or null to start from the caret, which
 * is what the first search after the bar opens should do. It is passed in
 * rather than read from the document because the document has no selection to
 * read while a text input holds the keyboard — see `EditorPane.runFind`.
 */
export function findFrom(
  text: string,
  query: string,
  opts: FindOptions,
  where: { anchor: Span | null; caret: Span; restart: boolean; backwards: boolean }
): Span | null {
  const span = where.anchor ?? where.caret
  const lo = Math.min(span.from, span.to)
  const hi = Math.max(span.from, span.to)
  // Backwards always starts at the near edge: `findNext` looks for matches that
  // *end* before it, so the current match is excluded either way.
  const from = where.backwards || where.restart ? lo : hi
  return findNext(text, query, from, opts, where.backwards)
}

/** Replaces one span, and reports where the replacement ends. */
export function replaceSpan(text: string, span: Span, replacement: string): Edit {
  const { from, to } = ordered(span)
  return {
    text: text.slice(0, from) + replacement + text.slice(to),
    from,
    to: from + replacement.length,
  }
}

/** Replaces every match, right to left so earlier offsets stay valid. */
export function replaceAll(
  text: string,
  query: string,
  replacement: string,
  opts: FindOptions = {}
): { edit: Edit; count: number } {
  const all = findAll(text, query, opts)
  let next = text
  for (let i = all.length - 1; i >= 0; i--) {
    next = next.slice(0, all[i].from) + replacement + next.slice(all[i].to)
  }
  return { edit: { text: next, from: 0, to: 0 }, count: all.length }
}
