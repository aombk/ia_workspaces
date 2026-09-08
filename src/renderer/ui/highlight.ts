/**
 * The grammars `LiveText` paints with.
 *
 * Both of these obey the same contract, and it is the contract that makes the
 * editor safe: **the runs of a line must concatenate back to that line, exactly**.
 * The styling is a costume over the source, and a costume that drops a
 * character is a costume that writes a different file to disk. `tests/
 * liveText.test.mjs` holds them to it.
 */
import type { Highlighter, Run, StyledLine } from './liveText'
import type { Grammar } from '../../shared/editorModes'
import {
  isCentred,
  isCharacterCue,
  isForcedAction,
  isLyric,
  isPageBreak,
  isParenthetical,
  isSceneHeading,
  isTitleKey,
  isTransition,
} from '../../shared/screenplay'

/** Carry values. Zero always means "nothing spans into this line". */
const PLAIN = 0
const IN_FENCE = 1
const IN_BLOCK_COMMENT = 1

// ------------------------------------------------------------------- markdown

/**
 * `code`, **strong**, *emphasis*, ~~strike~~, [links](url) and bare URLs.
 *
 * Every delimiter is kept and dimmed rather than dropped: what is on screen is
 * what is in the file, character for character, which is what makes clicking
 * anywhere land the caret where it looks like it should.
 */
const INLINE =
  /(`+)([^`]+?)\1|(\*\*|__)([^*_]+?)\3|([*_])([^*_]+?)\5|(~~)([^~]+?)\7|\[([^\]]*)\]\(([^)\s]+)\)|(https?:\/\/[^\s)]+)/g

function inline(src: string): Run[] {
  if (!src) return []
  const runs: Run[] = []
  let last = 0
  for (const m of src.matchAll(INLINE)) {
    const at = m.index
    if (at > last) runs.push({ text: src.slice(last, at) })
    last = at + m[0].length

    if (m[1]) {
      runs.push({ text: m[1], cls: 'md-mark' }, { text: m[2], cls: 'md-code' }, { text: m[1], cls: 'md-mark' })
    } else if (m[3]) {
      runs.push({ text: m[3], cls: 'md-mark' }, { text: m[4], cls: 'md-strong' }, { text: m[3], cls: 'md-mark' })
    } else if (m[5]) {
      runs.push({ text: m[5], cls: 'md-mark' }, { text: m[6], cls: 'md-em' }, { text: m[5], cls: 'md-mark' })
    } else if (m[7]) {
      runs.push({ text: m[7], cls: 'md-mark' }, { text: m[8], cls: 'md-del' }, { text: m[7], cls: 'md-mark' })
    } else if (m[10]) {
      const href = m[10]
      runs.push(
        { text: '[', cls: 'md-mark' },
        { text: m[9], cls: 'md-link', href },
        { text: `](${href})`, cls: 'md-mark' }
      )
    } else if (m[11]) {
      runs.push({ text: m[11], cls: 'md-link', href: m[11] })
    }
  }
  if (last < src.length) runs.push({ text: src.slice(last) })
  return runs
}

export const markdown: Highlighter = (src, carry): StyledLine => {
  const fence = /^\s*(?:```|~~~)/.test(src)
  if (carry === IN_FENCE && !fence) {
    return { cls: 'md-code-line', runs: src ? [{ text: src }] : [], carry: IN_FENCE }
  }
  if (fence) {
    return {
      cls: 'md-code-line',
      runs: [{ text: src, cls: 'md-mark' }],
      carry: carry === IN_FENCE ? PLAIN : IN_FENCE,
    }
  }

  const heading = /^(#{1,6}[ \t]+)(.*)$/.exec(src)
  if (heading) {
    return {
      cls: `md-h${heading[1].trim().length}`,
      runs: [{ text: heading[1], cls: 'md-mark' }, ...inline(heading[2])],
      carry: PLAIN,
    }
  }

  const quote = /^([ \t]*>[ \t]?)(.*)$/.exec(src)
  if (quote) {
    return {
      cls: 'md-quote',
      runs: [{ text: quote[1], cls: 'md-mark' }, ...inline(quote[2])],
      carry: PLAIN,
    }
  }

  if (/^[ \t]*(?:-[ \t]*){3,}$|^[ \t]*(?:\*[ \t]*){3,}$|^[ \t]*(?:_[ \t]*){3,}$/.test(src)) {
    return { cls: 'md-rule', runs: [{ text: src, cls: 'md-mark' }], carry: PLAIN }
  }

  const item = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(src)
  if (item) {
    const done = Boolean(item[2]) && /\[[xX]\]/.test(item[2])
    const runs: Run[] = [{ text: item[1], cls: 'md-mark' }]
    if (item[2]) runs.push({ text: item[2], cls: done ? 'md-done' : 'md-mark' })
    return {
      cls: done ? 'md-item md-checked' : 'md-item',
      runs: [...runs, ...inline(item[3])],
      carry: PLAIN,
    }
  }

  return { cls: 'md-para', runs: inline(src), carry: PLAIN }
}

// ----------------------------------------------------------------- screenplay

/** Inside `/* … *​/`: Fountain's boneyard, the draft's cutting-room floor. */
const IN_BONEYARD = 1
/** Under a character cue, where every line is something they say. */
const IN_DIALOGUE = 2
/** The previous line was action, which is the one place a cue cannot follow. */
const AFTER_ACTION = 4
/** Still in the title page, where an indented line continues the key above. */
const IN_TITLE = 8

/**
 * The inline half of Fountain: notes, and the three emphasis marks.
 *
 * Split out rather than styled a line at a time because all four turn up in the
 * middle of something else — a note parked at the end of a line of action, a
 * word in italics inside a speech — and colouring the whole line would say the
 * line was the note.
 *
 * Every delimiter is kept and dimmed rather than dropped, exactly as the
 * markdown highlighter does it and for the same reason: what is on screen has
 * to be what is in the file, character for character, or a click puts the caret
 * somewhere other than where it looks. `tests/liveText.test.mjs` holds it to it.
 *
 * Bold before italic in the alternation, or `**word**` matches as an italic
 * wrapping an empty string and the second pair of stars is left behind.
 *
 * A backslash escape comes first of all, and consuming it here is the whole
 * mechanism: `\*` is taken as two plain characters, so the star it hides is
 * never available to open a run. Fountain's own way of writing about a
 * multiplication sign in a line of action.
 */
const INLINE_FX = /(\\.)|(\[\[[^\]]*\]\])|(\*\*)([^*]+?)\3|(\*)([^*]+?)\5|(_)([^_]+?)\7/g

function inlineFx(src: string, cls?: string): Run[] {
  if (!src) return []
  const runs: Run[] = []
  let last = 0
  for (const m of src.matchAll(INLINE_FX)) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index), cls })
    if (m[1]) {
      // Kept whole, backslash included: the file says `\*` and so must the
      // screen, or the caret stops agreeing with the text.
      runs.push({ text: m[1], cls })
    } else if (m[2]) {
      runs.push({ text: m[2], cls: 'fx-note' })
    } else if (m[3]) {
      runs.push(
        { text: m[3], cls: 'fx-mark' },
        { text: m[4], cls: 'fx-strong' },
        { text: m[3], cls: 'fx-mark' }
      )
    } else if (m[5]) {
      runs.push(
        { text: m[5], cls: 'fx-mark' },
        { text: m[6], cls: 'fx-em' },
        { text: m[5], cls: 'fx-mark' }
      )
    } else {
      runs.push(
        { text: m[7], cls: 'fx-mark' },
        { text: m[8], cls: 'fx-underline' },
        { text: m[7], cls: 'fx-mark' }
      )
    }
    last = m.index + m[0].length
  }
  if (last < src.length) runs.push({ text: src.slice(last), cls })
  return runs
}

/**
 * Fountain, one line at a time.
 *
 * The format is defined by context — a name is a character cue *because* a
 * blank line is above it and dialogue is below — and this is handed a line and
 * a number. What it can see backwards it keeps in the carry: whether a dialogue
 * block is open, whether the line above was action, whether the boneyard is.
 *
 * What it cannot see is forwards, and that is a real limit rather than a bug to
 * fix later: a lone shouted line with a blank under it is action in the spec
 * and a character cue here. `outlineOf` gets this right, because it holds the
 * whole file — so the cast list down the side is the authority, not the colour.
 * Where the colour is wrong the fix is Fountain's own: `!` forces action.
 *
 * The inline marks — notes and the three emphases — are `inlineFx`'s, and every
 * branch here runs its text through it: a note or an italic can turn up in any
 * of them.
 */
export const screenplay: Highlighter = (src, carry): StyledLine => {
  const text = src.trim()

  if (carry & IN_BONEYARD) {
    const closes = src.includes('*/')
    return {
      cls: 'fx-boneyard',
      runs: src ? [{ text: src, cls: 'fx-note' }] : [],
      carry: closes ? PLAIN : IN_BONEYARD,
    }
  }
  if (text.startsWith('/*')) {
    return {
      cls: 'fx-boneyard',
      runs: [{ text: src, cls: 'fx-note' }],
      carry: text.includes('*/') ? PLAIN : IN_BONEYARD,
    }
  }

  // A blank line closes whatever was open. It is the only punctuation this
  // format really has.
  if (!text) return { cls: 'fx-blank', runs: src ? [{ text: src }] : [], carry: PLAIN }

  // An indented line under a title key is the rest of that key's value —
  // `Title:` on its own with the title beneath it is how most scripts open.
  // Without this the indented line was judged on its own and, being in
  // capitals often enough, opened a dialogue block on the second line of the
  // file that then swallowed `Credit:` as something a character said.
  if (carry & IN_TITLE && /^\s+\S/.test(src)) {
    return { cls: 'fx-title', runs: inlineFx(src), carry: IN_TITLE }
  }

  if (isTitleKey(text)) {
    const at = src.indexOf(':')
    return {
      cls: 'fx-title',
      runs: [
        { text: src.slice(0, at + 1), cls: 'fx-mark' },
        ...inlineFx(src.slice(at + 1)),
      ],
      carry: IN_TITLE,
    }
  }

  // Before the synopsis, which is the same character and one of them.
  if (isPageBreak(text)) {
    return { cls: 'fx-pagebreak', runs: [{ text: src, cls: 'fx-mark' }], carry: PLAIN }
  }

  const section = /^(\s*#{1,6}\s*)(.*)$/.exec(src)
  if (section) {
    return {
      cls: `fx-section fx-section${section[1].trim().length}`,
      runs: [{ text: section[1], cls: 'fx-mark' }, ...inlineFx(section[2])],
      carry: PLAIN,
    }
  }

  const synopsis = /^(\s*=\s*)(.*)$/.exec(src)
  if (synopsis) {
    return {
      cls: 'fx-synopsis',
      runs: [{ text: synopsis[1], cls: 'fx-mark' }, ...inlineFx(synopsis[2])],
      carry: PLAIN,
    }
  }

  // Both of these shout, and both used to be read as somebody speaking — which
  // is not a wrong colour on one line but a dialogue block opened under it.
  if (isLyric(text)) {
    const at = src.indexOf('~')
    return {
      cls: 'fx-lyric',
      runs: [{ text: src.slice(0, at + 1), cls: 'fx-mark' }, ...inlineFx(src.slice(at + 1))],
      carry: PLAIN,
    }
  }

  if (isCentred(text)) {
    return { cls: 'fx-centred', runs: inlineFx(src), carry: PLAIN }
  }

  if (isForcedAction(text)) {
    const at = src.indexOf('!')
    return {
      cls: 'fx-action',
      runs: [{ text: src.slice(0, at + 1), cls: 'fx-mark' }, ...inlineFx(src.slice(at + 1))],
      carry: AFTER_ACTION,
    }
  }

  if (isSceneHeading(text)) {
    return { cls: 'fx-scene', runs: inlineFx(src), carry: PLAIN }
  }

  if (isTransition(text)) {
    return { cls: 'fx-transition', runs: inlineFx(src), carry: PLAIN }
  }

  if (carry & IN_DIALOGUE) {
    if (isParenthetical(text)) {
      return { cls: 'fx-paren', runs: inlineFx(src), carry: IN_DIALOGUE }
    }
    return { cls: 'fx-dialogue', runs: inlineFx(src), carry: IN_DIALOGUE }
  }

  // Only where a blank line, a slug or the top of the file is above: after a
  // line of action, capitals are somebody shouting, not somebody speaking.
  if (!(carry & AFTER_ACTION) && isCharacterCue(text)) {
    return { cls: 'fx-character', runs: inlineFx(src), carry: IN_DIALOGUE }
  }

  return { cls: 'fx-action', runs: inlineFx(src), carry: AFTER_ACTION }
}

// ----------------------------------------------------------------------- code

/** The plainest highlighter there is, for a file with no grammar of its own. */
export const plain: Highlighter = (src) => ({
  cls: 'md-src',
  runs: src ? [{ text: src }] : [],
  carry: PLAIN,
})

const WORD_START = /[A-Za-z_$@]/
const WORD_REST = /[A-Za-z0-9_$-]/

/**
 * Comments, strings, numbers and keywords — and nothing else.
 *
 * A real parser per language is a project; this is a lexer that four fifths of
 * files agree with, and the fifth still reads correctly because anything it
 * fails to classify is left as plain text rather than mangled.
 */
export function code(grammar: Grammar): Highlighter {
  return (src, carry): StyledLine => {
    const runs: Run[] = []
    let i = 0
    let plainFrom = 0
    let state = carry

    // A marker that only counts at the start of a line, before anything else
    // has had a chance to read it as a word.
    if (carry !== IN_BLOCK_COMMENT && grammar.lineStart?.length) {
      const indent = src.length - src.trimStart().length
      const head = src.slice(indent).toLowerCase()
      const marker = grammar.lineStart.find(
        (m) => head === m || head.startsWith(`${m} `) || head.startsWith(`${m}	`)
      )
      if (marker) {
        return {
          cls: 'md-src',
          runs: [{ text: src, cls: 'tok-comment' }],
          carry: PLAIN,
        }
      }
    }

    const flush = (to: number) => {
      if (to > plainFrom) runs.push({ text: src.slice(plainFrom, to) })
    }

    // A block comment opened on an earlier line owns this one until it closes.
    if (state === IN_BLOCK_COMMENT && grammar.block) {
      const end = src.indexOf(grammar.block[1])
      if (end === -1) {
        return {
          cls: 'md-src',
          runs: src ? [{ text: src, cls: 'tok-comment' }] : [],
          carry: IN_BLOCK_COMMENT,
        }
      }
      const stop = end + grammar.block[1].length
      runs.push({ text: src.slice(0, stop), cls: 'tok-comment' })
      i = stop
      plainFrom = stop
      state = PLAIN
    }

    while (i < src.length) {
      const rest = src.slice(i)

      if (grammar.block && rest.startsWith(grammar.block[0])) {
        flush(i)
        const end = src.indexOf(grammar.block[1], i + grammar.block[0].length)
        const stop = end === -1 ? src.length : end + grammar.block[1].length
        runs.push({ text: src.slice(i, stop), cls: 'tok-comment' })
        i = stop
        plainFrom = i
        if (end === -1) state = IN_BLOCK_COMMENT
        continue
      }

      const lineComment = grammar.line.find((marker) => rest.startsWith(marker))
      if (lineComment) {
        flush(i)
        runs.push({ text: src.slice(i), cls: 'tok-comment' })
        return { cls: 'md-src', runs, carry: state }
      }

      const quote = grammar.quotes.find((q) => rest.startsWith(q))
      if (quote) {
        flush(i)
        let j = i + quote.length
        while (j < src.length) {
          if (src[j] === '\\') {
            j += 2
            continue
          }
          if (src.startsWith(quote, j)) {
            j += quote.length
            break
          }
          j++
        }
        const stop = Math.min(j, src.length)
        runs.push({ text: src.slice(i, stop), cls: 'tok-string' })
        i = stop
        plainFrom = i
        continue
      }

      const char = src[i]
      const previous = i > 0 ? src[i - 1] : ''
      if (/[0-9]/.test(char) && !WORD_REST.test(previous)) {
        flush(i)
        let j = i
        while (j < src.length && /[0-9a-fA-FxX._]/.test(src[j])) j++
        runs.push({ text: src.slice(i, j), cls: 'tok-number' })
        i = j
        plainFrom = i
        continue
      }

      if (WORD_START.test(char) && !WORD_REST.test(previous)) {
        // From `i + 1`, not `i`: the first character has already matched
        // `WORD_START`, and some of those — `@`, which begins every batch file
        // — are not in `WORD_REST`. Scanning from `i` then advanced by nothing,
        // `i = j` put the cursor back where it was, and the lexer span forever
        // on `@echo off`.
        let j = i + 1
        while (j < src.length && WORD_REST.test(src[j])) j++
        const word = src.slice(i, j)
        if (grammar.keywords.has(word.toLowerCase())) {
          flush(i)
          runs.push({ text: word, cls: 'tok-keyword' })
          plainFrom = j
        }
        i = j
        continue
      }

      i++
    }

    flush(src.length)
    return { cls: 'md-src', runs, carry: state }
  }
}

/**
 * JSON, which is code plus one thing worth seeing: which strings are keys.
 *
 * Keys are what you scan a config file for, and telling them from values at a
 * glance is most of what a JSON view is for.
 */
export function json(grammar: Grammar): Highlighter {
  const lex = code(grammar)
  return (src, carry) => {
    const styled = lex(src, carry)
    for (let i = 0; i < styled.runs.length; i++) {
      const run = styled.runs[i]
      if (run.cls !== 'tok-string') continue
      // The next non-space character decides: a colon makes it a key.
      const after = styled.runs
        .slice(i + 1)
        .map((r) => r.text)
        .join('')
      if (/^\s*:/.test(after)) run.cls = 'tok-key'
    }
    return styled
  }
}
