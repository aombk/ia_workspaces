// The editor's commands, exercised as arithmetic on a string.
//
// These are the operations that rewrite a file under you — duplicate a line,
// replace every match, comment a block — so the interesting cases are the ones
// where a naive implementation quietly eats a character: the last line without
// a trailing newline, a selection running backwards, a caret with nothing
// selected at all.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-textops-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { textOps: 'src/renderer/ui/textOps.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})

const ops = await import(`file://${out}/textOps.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

/** A document with the selection written as | … |, for readable cases. */
const parse = (marked) => {
  const from = marked.indexOf('|')
  const to = marked.indexOf('|', from + 1)
  return { text: marked.replace(/\|/g, ''), from, to: to === -1 ? from : to - 1 }
}

const DOC = 'alpha\nbeta\ngamma'

check('line span covers whole lines, from anywhere on them', () => {
  assert.deepEqual(ops.lineSpan(DOC, { from: 7, to: 8 }), { from: 6, to: 10 })
  assert.deepEqual(ops.lineSpan(DOC, { from: 0, to: 0 }), { from: 0, to: 5 })
  // The last line has no newline after it; the span must end at the text.
  assert.deepEqual(ops.lineSpan(DOC, { from: 12, to: 12 }), { from: 11, to: 16 })
})

check('a backwards selection is handled like a forwards one', () => {
  assert.deepEqual(ops.lineSpan(DOC, { from: 8, to: 7 }), { from: 6, to: 10 })
  assert.deepEqual(ops.ordered({ from: 9, to: 2 }), { from: 2, to: 9 })
})

check('duplicate copies the line below and selects the copy', () => {
  const edit = ops.duplicateLines(DOC, { from: 7, to: 7 })
  assert.equal(edit.text, 'alpha\nbeta\nbeta\ngamma')
  assert.equal(edit.text.slice(edit.from, edit.to), 'beta')
})

check('duplicate works on the last line, which has no newline', () => {
  const edit = ops.duplicateLines(DOC, { from: 12, to: 12 })
  assert.equal(edit.text, 'alpha\nbeta\ngamma\ngamma')
})

check('duplicate covers every line the selection touches', () => {
  const edit = ops.duplicateLines(DOC, { from: 2, to: 8 })
  assert.equal(edit.text, 'alpha\nbeta\nalpha\nbeta\ngamma')
})

check('delete removes the line and its newline, leaving no gap', () => {
  assert.equal(ops.deleteLines(DOC, { from: 7, to: 7 }).text, 'alpha\ngamma')
  assert.equal(ops.deleteLines(DOC, { from: 0, to: 0 }).text, 'beta\ngamma')
  // The last line takes the newline *before* it instead.
  assert.equal(ops.deleteLines(DOC, { from: 12, to: 12 }).text, 'alpha\nbeta')
  assert.equal(ops.deleteLines('only', { from: 1, to: 1 }).text, '')
})

check('move swaps with the neighbouring line and carries the selection', () => {
  const down = ops.moveLines(DOC, { from: 0, to: 0 }, 1)
  assert.equal(down.text, 'beta\nalpha\ngamma')
  assert.equal(down.from, 5)

  const up = ops.moveLines(DOC, { from: 7, to: 7 }, -1)
  assert.equal(up.text, 'beta\nalpha\ngamma')
})

check('move at the edges does nothing at all', () => {
  assert.equal(ops.moveLines(DOC, { from: 0, to: 0 }, -1).text, DOC)
  assert.equal(ops.moveLines(DOC, { from: 12, to: 12 }, 1).text, DOC)
})

check('sort orders the touched lines, naturally and case-blind', () => {
  const edit = ops.sortLines('b\nA\na10\na9', { from: 0, to: 12 })
  assert.deepEqual(edit.text.split('\n'), ['A', 'a9', 'a10', 'b'])
})

check('trim takes trailing whitespace and nothing else', () => {
  const edit = ops.trimTrailing('a  \n  b\t\nc', { from: 0, to: 0 })
  assert.equal(edit.text, 'a\n  b\nc')
})

check('comment adds a marker, and adding twice takes it away', () => {
  const source = 'const a = 1\nconst b = 2'
  const commented = ops.toggleComment(source, { from: 0, to: source.length }, '//')
  assert.equal(commented.text, '// const a = 1\n// const b = 2')
  const back = ops.toggleComment(commented.text, { from: 0, to: commented.text.length }, '//')
  assert.equal(back.text, source)
})

check('comment keeps the block indented as it was', () => {
  const source = '  if (x) {\n    go()\n  }'
  const edit = ops.toggleComment(source, { from: 0, to: source.length }, '//')
  assert.equal(edit.text, '  // if (x) {\n  //   go()\n  // }')
  assert.equal(ops.toggleComment(edit.text, { from: 0, to: edit.text.length }, '//').text, source)
})

check('a part-commented block becomes fully commented, not uncommented', () => {
  const source = '// done\nnot done'
  const edit = ops.toggleComment(source, { from: 0, to: source.length }, '//')
  assert.equal(edit.text, '// // done\n// not done')
})

check('blank lines are left alone by commenting', () => {
  const edit = ops.toggleComment('a\n\nb', { from: 0, to: 3 }, '#')
  assert.equal(edit.text, '# a\n\n# b')
})

check('reverse turns the touched lines upside down', () => {
  assert.equal(ops.reverseLines('a\nb\nc', { from: 0, to: 5 }).text, 'c\nb\na')
})

check('sort descending is sort, backwards', () => {
  const edit = ops.sortLines('b\na\nc', { from: 0, to: 5 }, true)
  assert.deepEqual(edit.text.split('\n'), ['c', 'b', 'a'])
})

check('remove empty lines drops the blank ones, whitespace included', () => {
  const edit = ops.removeEmptyLines('a\n\n  \nb\n\t\nc', { from: 0, to: 0 })
  assert.equal(edit.text, 'a\nb\nc')
})

check('removing every line leaves one empty one, not nothing', () => {
  assert.equal(ops.removeEmptyLines('\n\n', { from: 0, to: 0 }).text, '')
})

check('remove duplicates keeps the first of each, in the order it was', () => {
  const edit = ops.removeDuplicateLines('b\na\nb\nc\na', { from: 0, to: 0 })
  assert.deepEqual(edit.text.split('\n'), ['b', 'a', 'c'])
})

check('duplicates are removed exactly, not case-blind', () => {
  assert.equal(ops.removeDuplicateLines('a\nA', { from: 0, to: 0 }).text, 'a\nA')
})

check('join makes one line, with single spaces and no stray indent', () => {
  const edit = ops.joinLines('one  \n   two\n\tthree', { from: 0, to: 0 })
  assert.equal(edit.text, 'one two three')
})

check('joining a single line changes nothing', () => {
  assert.equal(ops.joinLines('alone', { from: 0, to: 0 }).text, 'alone')
})

check('a caret with no selection means the whole document', () => {
  // These are the operations where "just the line I am on" would be useless.
  assert.equal(ops.removeEmptyLines('a\n\nb', { from: 0, to: 0 }).text, 'a\nb')
  assert.equal(ops.removeDuplicateLines('a\na', { from: 3, to: 3 }).text, 'a')
})

check('with a selection, only the touched lines are rewritten', () => {
  // A selection inside the middle leaves the outer lines alone.
  const edit = ops.removeEmptyLines('keep\n\nb\n\nkeep', { from: 5, to: 8 })
  assert.equal(edit.text, 'keep\nb\nkeep')
})

check('case changes the selection', () => {
  assert.equal(ops.changeCase('hello world', { from: 0, to: 5 }, 'upper').text, 'HELLO world')
  assert.equal(ops.changeCase('HELLO world', { from: 0, to: 5 }, 'lower').text, 'hello world')
  assert.equal(ops.changeCase('hello world', { from: 0, to: 11 }, 'title').text, 'Hello World')
})

check('case with no selection takes the word under the caret', () => {
  const edit = ops.changeCase('alpha beta gamma', { from: 8, to: 8 }, 'upper')
  assert.equal(edit.text, 'alpha BETA gamma')
  assert.equal(edit.text.slice(edit.from, edit.to), 'BETA')
})

check('find is case-insensitive unless told otherwise', () => {
  assert.equal(ops.findAll('Ab ab AB', 'ab').length, 3)
  assert.equal(ops.findAll('Ab ab AB', 'ab', { caseSensitive: true }).length, 1)
})

check('whole word does not match inside a word', () => {
  assert.equal(ops.findAll('cat concat cat.', 'cat', { wholeWord: true }).length, 2)
})

check('a broken regex matches nothing rather than throwing', () => {
  assert.deepEqual(ops.findAll('anything', '([', { regex: true }), [])
  assert.equal(ops.findAll('a1 b22', '\\d+', { regex: true }).length, 2)
})

check('find next wraps, and backwards finds the one before', () => {
  const text = 'x a y a z'
  assert.deepEqual(ops.findNext(text, 'a', 0), { from: 2, to: 3 })
  assert.deepEqual(ops.findNext(text, 'a', 3), { from: 6, to: 7 })
  // Past the last match, it comes back to the first.
  assert.deepEqual(ops.findNext(text, 'a', 8), { from: 2, to: 3 })
  assert.deepEqual(ops.findNext(text, 'a', 6, {}, true), { from: 2, to: 3 })
  // Before the first, backwards wraps to the last.
  assert.deepEqual(ops.findNext(text, 'a', 0, {}, true), { from: 6, to: 7 })
  assert.equal(ops.findNext(text, 'zzz', 0), null)
})

check('replace all replaces every match and counts them', () => {
  const { edit, count } = ops.replaceAll('a b a b a', 'a', 'X')
  assert.equal(edit.text, 'X b X b X')
  assert.equal(count, 3)
})

check('replace all with a longer replacement does not shift itself', () => {
  const { edit } = ops.replaceAll('aaa', 'a', 'aa')
  assert.equal(edit.text, 'aaaaaa')
})

check('replacing one span reports where it ended', () => {
  const edit = ops.replaceSpan('hello world', { from: 6, to: 11 }, 'there')
  assert.equal(edit.text, 'hello there')
  assert.equal(edit.text.slice(edit.from, edit.to), 'there')
})

check('the marked-selection helper agrees with the operations', () => {
  const { text, from, to } = parse('alpha\n|beta|\ngamma')
  assert.equal(text.slice(from, to), 'beta')
  assert.equal(ops.deleteLines(text, { from, to }).text, 'alpha\ngamma')
})

// --- the find bar's two questions ------------------------------------------
//
// A find bar sends "the query changed" and "go to the next one" down one
// channel, and they must start from different places. These pin that down,
// because getting it wrong is invisible until you are three letters into a
// search and looking at the wrong match.

const stepTo = (text, query, anchor, opts = {}) =>
  ops.findFrom(text, query, opts, {
    anchor,
    caret: { from: 0, to: 0 },
    restart: false,
    backwards: false,
  })
const retype = (text, query, anchor, opts = {}) =>
  ops.findFrom(text, query, opts, {
    anchor,
    caret: { from: 0, to: 0 },
    restart: true,
    backwards: false,
  })

check('typing another letter keeps the match under the cursor', () => {
  const text = 'xx abc yy abc'
  // 'ab' is found at 3..5; typing the 'c' must land on 3..6 rather than skip to
  // the second 'abc'. This is the bug that makes a search impossible to aim.
  const first = retype(text, 'ab', null)
  assert.deepEqual(first, { from: 3, to: 5 })
  assert.deepEqual(retype(text, 'abc', first), { from: 3, to: 6 })
})

check('Enter steps past the match rather than finding it again', () => {
  const text = 'xx abc yy abc'
  const first = retype(text, 'abc', null)
  assert.deepEqual(first, { from: 3, to: 6 })
  const second = stepTo(text, 'abc', first)
  assert.deepEqual(second, { from: 10, to: 13 })
  // And wraps rather than stopping at the last one.
  assert.deepEqual(stepTo(text, 'abc', second), { from: 3, to: 6 })
})

check('the first search of all starts from the caret, and wraps past it', () => {
  const text = 'abc abc'
  const from = (caret) =>
    ops.findFrom(text, 'abc', {}, {
      anchor: null,
      caret: { from: caret, to: caret },
      restart: true,
      backwards: false,
    })
  // The caret is where you were reading, so the search begins there rather than
  // at the top of the file: with it at 4 the match starting at 4 is the answer.
  assert.deepEqual(from(4), { from: 4, to: 7 })
  // One character further in and that match no longer *starts* at or after the
  // caret, so there is nothing ahead and the search wraps — which is what makes
  // a find bar reach every match rather than stopping at the end.
  assert.deepEqual(from(5), { from: 0, to: 3 })
})

check('backwards reaches the previous match from either request', () => {
  const text = 'abc abc abc'
  const middle = { from: 4, to: 7 }
  const back = (restart) =>
    ops.findFrom(text, 'abc', {}, {
      anchor: middle,
      caret: { from: 0, to: 0 },
      restart,
      backwards: true,
    })
  assert.deepEqual(back(false), { from: 0, to: 3 })
  assert.deepEqual(back(true), { from: 0, to: 3 })
})

check('a query that matches nothing reports nothing rather than throwing', () => {
  assert.equal(retype('abc', 'zzz', null), null)
  assert.equal(retype('abc', '', null), null)
})

console.log(`\n${passed} checks passed`)
