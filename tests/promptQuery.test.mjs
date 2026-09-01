// The prompt search box's small language.
//
// A search box has one failure mode worth defending against and it is silent:
// a query that is misread returns *fewer* results, and fewer results is exactly
// what a search is supposed to do. Nobody notices the day "before:2026-02-01"
// starts excluding the first of February, or the day a Windows path in a prompt
// starts being read as a field filter and matching nothing.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-query-'))
const outfile = path.join(sandbox, 'promptQuery.mjs')
await build({
  entryPoints: ['src/shared/promptQuery.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

const { parseQuery, matches } = await import(`file://${outfile}`)

/** A turn carrying only what the query looks at. */
const turn = (prompt, extra = {}) => ({
  prompt,
  cwd: '/work/alpha',
  at: Date.parse('2026-01-20T12:00:00'),
  images: 0,
  ...extra,
})

const find = (prompts, query) => prompts.filter((p) => matches(p, parseQuery(query))).map((p) => p.prompt)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log(`  ok  ${name}`)
}

console.log('Words')

check('every bare word must appear, in any order', () => {
  const all = [turn('fix the login form'), turn('fix the signup form'), turn('login'), turn('form fix login')]
  assert.deepEqual(find(all, 'fix login'), ['fix the login form', 'form fix login'])
})

check('matching ignores case on both sides', () => {
  assert.deepEqual(find([turn('Fix The Login')], 'fix LOGIN'), ['Fix The Login'])
})

check('an empty box matches everything', () => {
  const all = [turn('a'), turn('b')]
  assert.deepEqual(find(all, '   '), ['a', 'b'])
})

console.log('Phrases and exclusions')

check('a quoted phrase must appear as written', () => {
  const all = [turn('the login form is broken'), turn('the form for login is broken')]
  assert.deepEqual(find(all, '"login form"'), ['the login form is broken'])
})

check('an unclosed quote runs to the end rather than failing', () => {
  // What a box looks like for as long as it takes to type the closing quote. It
  // must keep searching, not go blank.
  assert.deepEqual(find([turn('the login form')], '"login form'), ['the login form'])
})

check('a minus excludes', () => {
  const all = [turn('fix the login form'), turn('fix the login test')]
  assert.deepEqual(find(all, 'login -test'), ['fix the login form'])
})

check('exclusion beats inclusion of the same word', () => {
  assert.deepEqual(find([turn('login')], 'login -login'), [])
})

console.log('Filters')

check('project matches part of the folder', () => {
  const all = [turn('one', { cwd: '/work/alpha' }), turn('two', { cwd: '/work/beta' })]
  assert.deepEqual(find(all, 'project:alpha'), ['one'])
  assert.deepEqual(find(all, 'project:WORK'), ['one', 'two'])
})

check('has:image finds the prompts that carried one', () => {
  const all = [turn('look at this', { images: 2 }), turn('and this')]
  assert.deepEqual(find(all, 'has:image'), ['look at this'])
})

console.log('Dates, in the timezone the person was in')

const on = (iso, text) => turn(text, { at: Date.parse(iso) })

check('after is inclusive of the whole day named', () => {
  const all = [on('2026-01-14T23:59:00', 'before'), on('2026-01-15T00:00:00', 'exactly'), on('2026-01-16T09:00:00', 'after')]
  assert.deepEqual(find(all, 'after:2026-01-15'), ['exactly', 'after'])
})

check('before is inclusive of the whole day named', () => {
  // The reading nobody has is "before the first of February" meaning "not on
  // the first of February". The bound is the end of that day, not its start.
  const all = [on('2026-01-31T10:00:00', 'january'), on('2026-02-01T23:58:00', 'the first'), on('2026-02-02T00:01:00', 'the second')]
  assert.deepEqual(find(all, 'before:2026-02-01'), ['january', 'the first'])
})

check('the two together bracket a range', () => {
  const all = [on('2026-01-01T12:00:00', 'early'), on('2026-01-20T12:00:00', 'middle'), on('2026-02-20T12:00:00', 'late')]
  assert.deepEqual(find(all, 'after:2026-01-10 before:2026-01-31'), ['middle'])
})

console.log('Text that only looks like syntax')

check('an unknown field is searched for as a word', () => {
  // Falling through rather than dropping it: a box that silently ignores what
  // it does not understand is a box that silently returns everything.
  const all = [turn('see https://example.com/x'), turn('nothing here')]
  assert.deepEqual(find(all, 'https://example.com/x'), ['see https://example.com/x'])
})

check('a windows path is a word, not a filter', () => {
  const all = [turn('open C:\\work\\alpha\\app.ts'), turn('open nothing')]
  assert.deepEqual(find(all, 'c:\\work\\alpha\\app.ts'), ['open C:\\work\\alpha\\app.ts'])
})

check('a malformed date is a word rather than a silently empty filter', () => {
  // `after:yesterday` is not a date this understands. Treating it as a filter
  // that matches nothing would return an empty list for a query that looks
  // perfectly reasonable.
  const all = [turn('mentioning after:yesterday in the text')]
  assert.deepEqual(find(all, 'after:yesterday'), ['mentioning after:yesterday in the text'])
})

console.log('Marking what matched')

check('spans cover each occurrence of every positive term', () => {
  const query = parseQuery('form "login form"')
  const text = 'the login form and the other form'
  const spans = query.spans(text)
  assert.deepEqual(
    spans.map((s) => text.slice(s.from, s.to)),
    ['login form', 'form']
  )
})

check('overlapping matches merge instead of nesting', () => {
  // Searching "form" and "forms" would otherwise open a mark inside a mark, and
  // the result visibly doubles back on itself.
  const query = parseQuery('form forms')
  const text = 'many forms here'
  const spans = query.spans(text)
  assert.equal(spans.length, 1)
  assert.equal(text.slice(spans[0].from, spans[0].to), 'forms')
})

check('excluded words are never marked', () => {
  const query = parseQuery('login -form')
  const text = 'the login form'
  assert.deepEqual(
    query.spans(text).map((s) => text.slice(s.from, s.to)),
    ['login']
  )
})

check('an empty query marks nothing', () => {
  assert.deepEqual(parseQuery('').spans('anything at all'), [])
})

console.log(`\n${passed} checks passed`)
