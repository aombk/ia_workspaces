// The one invariant the live editor cannot break.
//
// The formatting is spans laid over the source, so the spans must *be* the
// source: every character of the line, in order, once. If a highlighter ever
// drops or duplicates a character, the editor is showing something other than
// the file — and the next keystroke writes that back to disk.
//
// The same file covers the CSV grid, which has the same property in a different
// shape: a value must survive the trip through a cell and back.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-livetext-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    highlight: 'src/renderer/ui/highlight.ts',
    csvGrid: 'src/renderer/ui/csvGrid.ts',
    editorModes: 'src/shared/editorModes.ts',
    eol: 'src/shared/eol.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})

const { markdown, code, json, plain, screenplay } = await import(`file://${out}/highlight.js`)
const { parse, serialise } = await import(`file://${out}/csvGrid.js`)
const { modeForFile, grammarFor, extensionOf, delimiterFor } = await import(
  `file://${out}/editorModes.js`
)
const { normalizeNewlines, toCrlf, dominantEol } = await import(`file://${out}/eol.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const MARKDOWN_LINES = [
  '',
  'plain prose with no markup at all',
  '# Heading one',
  '###### Heading six',
  '#not-a-heading',
  '## Heading with **bold** and `code`',
  '- a list item',
  '  * nested item with *emphasis*',
  '1. numbered',
  '12) also numbered',
  '- [ ] unchecked task',
  '- [x] checked task',
  '> quoted line',
  '>no space after the marker',
  '---',
  '***',
  '```',
  '```ts',
  'const x = `template`',
  'a **bold** b *em* c `code` d ~~gone~~ e',
  '[label](https://example.com) trailing',
  'bare https://example.com/path?q=1 in a sentence',
  '[](https://example.com/empty-label)',
  'unclosed **bold and *em',
  'stars * on * their * own',
  'underscores_in_identifier_names',
  '  indented text  ',
  'trailing spaces   ',
  '\ttab indented',
  'emoji 🙂 and accents éàü',
  '**`code inside bold`**',
]

const CODE_LINES = [
  '',
  'const x = 1',
  'let s = "a string with // not a comment"',
  "let t = 'single \\' escaped'",
  '// a whole-line comment',
  'code() // trailing comment',
  '/* block */ after',
  '/* unterminated block',
  'still inside the block */ and out',
  'const n = 0xFF + 1.5e3',
  'function name(arg) { return arg }',
  'x = `back ${tick}`',
  'no_keywords_here_at_all',
  '  return  ',
  'a/b/c not a comment',
  '"unterminated string',
]

check('markdown runs concatenate back to the source line', () => {
  for (const line of MARKDOWN_LINES) {
    for (const carry of [0, 1]) {
      const { runs } = markdown(line, carry)
      assert.equal(runs.map((r) => r.text).join(''), line, `lost text in: ${JSON.stringify(line)}`)
    }
  }
})

check('code runs concatenate back to the source line', () => {
  const grammar = grammarFor('x.ts')
  for (const line of [...CODE_LINES, ...MARKDOWN_LINES]) {
    for (const carry of [0, 1]) {
      const { runs } = code(grammar)(line, carry)
      assert.equal(runs.map((r) => r.text).join(''), line, `lost text in: ${JSON.stringify(line)}`)
    }
  }
})

check('json runs concatenate back, and keys are marked', () => {
  const grammar = grammarFor('x.json')
  for (const line of ['{', '  "key": "value",', '  "n": 12,', '  "a": { "b": true }', '}']) {
    const { runs } = json(grammar)(line, 0)
    assert.equal(runs.map((r) => r.text).join(''), line)
  }
  const { runs } = json(grammar)('  "key": "value",', 0)
  assert.equal(runs.find((r) => r.cls === 'tok-key')?.text, '"key"')
  assert.equal(runs.find((r) => r.cls === 'tok-string')?.text, '"value"')
})

check('a block comment carries to the next line and then stops', () => {
  const lex = code(grammarFor('x.ts'))
  const first = lex('/* opened', 0)
  assert.equal(first.carry, 1)
  const second = lex('still in', first.carry)
  assert.equal(second.carry, 1)
  assert.equal(second.runs[0].cls, 'tok-comment')
  const third = lex('closed */ code', second.carry)
  assert.equal(third.carry, 0)
})

check('a fence carries, and its contents are not parsed as markup', () => {
  const open = markdown('```ts', 0)
  assert.equal(open.carry, 1)
  const inside = markdown('# not a heading', open.carry)
  assert.equal(inside.runs.length, 1)
  assert.equal(inside.runs[0].cls, undefined)
  assert.equal(markdown('```', inside.carry).carry, 0)
})

check('the plain highlighter never touches the text', () => {
  for (const line of CODE_LINES) {
    assert.equal(
      plain(line, 0)
        .runs.map((r) => r.text)
        .join(''),
      line
    )
  }
})

check('markdown headings carry their level', () => {
  assert.equal(markdown('# one', 0).cls, 'md-h1')
  assert.equal(markdown('### three', 0).cls, 'md-h3')
  assert.equal(markdown('####### seven', 0).cls, 'md-para')
})

check('a link keeps its target', () => {
  const { runs } = markdown('see [docs](https://example.com/x)', 0)
  const link = runs.find((r) => r.cls === 'md-link')
  assert.equal(link.text, 'docs')
  assert.equal(link.href, 'https://example.com/x')
})

check('csv values survive a parse and serialise round trip', () => {
  const rows = [
    'a,b,c',
    'plain,values,here',
    '"quoted, with comma",x,y',
    '"doubled ""quotes"" inside",x,y',
    ',,',
    'trailing,,',
    '"",x,y',
  ]
  for (const row of rows) {
    const cells = parse(row, ',')
    // Re-serialising may normalise quoting, so the invariant is on the values.
    assert.deepEqual(parse(serialise(cells, ','), ','), cells, row)
  }
})

check('a value only gains quotes when it needs them', () => {
  assert.equal(serialise(['a', 'b'], ','), 'a,b')
  assert.equal(serialise(['a,b', 'c'], ','), '"a,b",c')
  assert.equal(serialise(['say "hi"'], ','), '"say ""hi"""')
  assert.equal(serialise(['tab\tsep', 'x'], '\t'), '"tab\tsep"\tx')
})

check('batch files comment with rem, but only at the start of a line', () => {
  const lex = code(grammarFor('setup.bat'))
  assert.equal(lex('REM a comment', 0).runs[0].cls, 'tok-comment')
  assert.equal(lex('  rem indented too', 0).runs[0].cls, 'tok-comment')
  assert.equal(lex(':: also a comment', 0).runs[0].cls, 'tok-comment')
  // The word in the middle of a line is a word, not a marker.
  const spoken = lex('echo rem is a command', 0)
  assert.equal(spoken.runs.every((r) => r.cls !== 'tok-comment'), true)
  // And the whole line still comes back intact either way.
  for (const line of ['REM a comment', 'echo rem is a command', 'rem']) {
    assert.equal(lex(line, 0).runs.map((r) => r.text).join(''), line)
  }
})

check('the lexer always makes progress, whatever it is handed', () => {
  // The bug this guards: `@` starts a word but is not a word character, so the
  // scanner advanced by nothing and `@echo off` — the first line of every batch
  // file — hung the renderer. A lexer that can fail to consume input is a lexer
  // that can lock the window, so this is checked against every awkward opener
  // rather than against the one that happened to be found.
  const openers = ['@', '@echo off', '#', '$', '$var', '_x', '::', '%%f', '!x!', '&', '^', '@@']
  const files = ['x.bat', 'x.ts', 'x.py', 'x.ps1', 'x.sql', 'x.lua', 'x.json']
  for (const file of files) {
    const lex = code(grammarFor(file))
    for (const line of [...openers, ...CODE_LINES]) {
      // esbuild-bundled code cannot be interrupted, so this asserts the
      // property that makes hanging impossible instead of racing a timeout:
      // the runs are finite and reproduce the line.
      const { runs } = lex(line, 0)
      assert.equal(runs.map((r) => r.text).join(''), line, `${file}: ${JSON.stringify(line)}`)
      assert.ok(runs.length <= line.length + 2, `${file}: too many runs for ${JSON.stringify(line)}`)
    }
  }
})

check('a whole batch file lexes, line by line, carrying state', () => {
  const lex = code(grammarFor('setup.bat'))
  const file = [
    '@echo off',
    'rem A comment',
    'setlocal EnableDelayedExpansion',
    'set "ROOT=%~dp0"',
    'set /a COUNT=0',
    'for %%f in ("%ROOT%*.md") do (',
    '  echo found %%~nxf',
    '  set /a COUNT+=1',
    ')',
    'if !COUNT! gtr 0 ( echo total: !COUNT! ) else ( exit /b 1 )',
  ]
  let carry = 0
  for (const line of file) {
    const styled = lex(line, carry)
    carry = styled.carry
    assert.equal(styled.runs.map((r) => r.text).join(''), line)
  }
})

check('the languages that were asked for are recognised', () => {
  for (const name of [
    'x.bat', 'x.cmd', 'x.ps1', 'x.lua', 'x.rb', 'x.php', 'x.swift', 'x.zig',
    'x.java', 'x.cs', 'x.kt', 'x.dart', 'x.scala', 'x.hs', 'x.jl', 'x.r',
    'x.tf', 'x.nix', 'x.vue', 'x.svelte', 'x.less', 'x.proto', 'Makefile',
    'Dockerfile', 'x.gradle', 'x.toml', 'x.yaml',
  ]) {
    assert.equal(modeForFile(name), 'code', name)
    assert.notEqual(grammarFor(name), null, name)
  }
})

check('a file opens in the view its extension implies', () => {
  assert.equal(modeForFile('C:\\p\\NOTES.md'), 'markdown')
  assert.equal(modeForFile('C:\\p\\package.json'), 'json')
  assert.equal(modeForFile('C:\\p\\data.csv'), 'csv')
  assert.equal(modeForFile('C:\\p\\data.tsv'), 'csv')
  assert.equal(modeForFile('C:\\p\\main.rs'), 'code')
  assert.equal(modeForFile('C:\\p\\app.exe'), 'hex')
  assert.equal(modeForFile('C:\\p\\notes.txt'), 'text')
  assert.equal(modeForFile('C:\\p\\LICENSE'), 'text')
})

check('a dotfile is all extension', () => {
  assert.equal(extensionOf('C:\\p\\.gitignore'), 'gitignore')
  assert.equal(extensionOf('C:\\p\\a.b.TS'), 'ts')
  assert.equal(extensionOf('plain'), 'plain')
})

check('tsv is tab separated and everything else is not', () => {
  assert.equal(delimiterFor('x.tsv'), '\t')
  assert.equal(delimiterFor('x.csv'), ',')
})

// ------------------------------------------------------------- line endings
//
// The editor works in \n and nothing else, because the editing surface is
// `white-space: pre-wrap` where a lone \r is a line break — it would draw a
// line that split('\n') says is not there. What the file used has to survive
// the trip anyway, or editing one word of a CRLF file rewrites every line of
// it and shows up as a whole-file diff.
console.log('Line endings')

check('crlf and lone cr both normalise', () => {
  assert.equal(normalizeNewlines('a\r\nb'), 'a\nb')
  assert.equal(normalizeNewlines('a\rb'), 'a\nb')
  assert.equal(normalizeNewlines('a\nb'), 'a\nb')
  assert.equal(normalizeNewlines('a\r\n\r\nb'), 'a\n\nb')
})

check('normalising is idempotent', () => {
  const once = normalizeNewlines('a\r\nb\rc\nd')
  assert.equal(normalizeNewlines(once), once)
})

check('no \\r survives, whatever the mix', () => {
  assert.equal(normalizeNewlines('a\r\nb\rc\nd').includes('\r'), false)
})

check('a crlf file round-trips byte for byte', () => {
  // The property that matters: open, change nothing, write — and the file on
  // disk is what it was.
  const original = 'one\r\ntwo\r\nthree\r\n'
  assert.equal(toCrlf(normalizeNewlines(original)), original)
})

check('an lf file is not converted', () => {
  const original = 'one\ntwo\nthree\n'
  assert.equal(dominantEol(original), '\n')
  assert.equal(normalizeNewlines(original), original)
})

check('the ending is decided by majority, not by the first line', () => {
  // A mixed file: what a newly typed line should look like is answered by the
  // bulk of the file, not by whichever ending happens to appear first.
  assert.equal(dominantEol('a\nb\r\nc\r\nd\r\n'), '\r\n')
  assert.equal(dominantEol('a\r\nb\nc\nd\n'), '\n')
})

check('a file with no line endings is lf', () => {
  assert.equal(dominantEol(''), '\n')
  assert.equal(dominantEol('one line'), '\n')
})

check('crlf is counted as one ending, not as an lf too', () => {
  // The subtraction in dominantEol: every \r\n also contains an \n, so a pure
  // CRLF file would otherwise look like a tie and fall through to \n.
  assert.equal(dominantEol('a\r\nb\r\n'), '\r\n')
})

check('toCrlf does not double an existing \\r\\n', () => {
  // Only ever applied to normalised text, and this is what goes wrong if that
  // ever stops being true.
  assert.equal(toCrlf('a\nb'), 'a\r\nb')
  assert.equal(toCrlf(normalizeNewlines('a\r\nb')), 'a\r\nb')
})

console.log(`\n${passed} checks passed`)

// --------------------------------------------------------------- screenplay

const SCREENPLAY_LINES = [
  '',
  '   ',
  'Title: The Long Walk',
  'INT. KITCHEN - DAY',
  '.A FORCED SLUG',
  'EXT./INT. CAR - NIGHT',
  'BOB',
  'BOB (V.O.)',
  'BOB ^',
  '@McAvoy',
  '(quietly, to himself)',
  'He puts the kettle on. [[check this against the treatment]]',
  '!THE END',
  'CUT TO:',
  '> FADE OUT <',
  '# Act One',
  '= She finally says it.',
  '/* cut for now',
  'still cut',
  'back in */',
  'plain action with no markup at all',
]

check('screenplay runs concatenate back to the source line', () => {
  for (const line of [...SCREENPLAY_LINES, ...MARKDOWN_LINES]) {
    // Every carry the highlighter can hand itself: boneyard, dialogue, action.
    for (const carry of [0, 1, 2, 4]) {
      const { runs } = screenplay(line, carry)
      assert.equal(runs.map((r) => r.text).join(''), line, `lost text in: ${JSON.stringify(line)}`)
    }
  }
})

check('screenplay tells a cue from a shout in the action', () => {
  // After a blank line, capitals are somebody speaking.
  assert.equal(screenplay('BOB', 0).cls, 'fx-character')
  // Straight after action, the same line is the action still shouting.
  const action = screenplay('He turns.', 0)
  assert.equal(screenplay('BOB', action.carry).cls, 'fx-action')
})

check('screenplay keeps a dialogue block open until a blank line', () => {
  const cue = screenplay('BOB', 0)
  const speech = screenplay('I said no.', cue.carry)
  assert.equal(speech.cls, 'fx-dialogue')
  assert.equal(screenplay('(beat)', speech.carry).cls, 'fx-paren')
  assert.equal(screenplay('', speech.carry).carry, 0)
})

check('screenplay holds the boneyard across lines', () => {
  const open = screenplay('/* cut this', 0)
  assert.equal(open.cls, 'fx-boneyard')
  const inside = screenplay('INT. KITCHEN - DAY', open.carry)
  assert.equal(inside.cls, 'fx-boneyard')
  assert.equal(screenplay('done */', inside.carry).carry, 0)
})

check('screenplay marks emphasis without losing the delimiters', () => {
  const runs = screenplay('She is *not* leaving.', 4).runs
  assert.equal(runs.map((r) => r.text).join(''), 'She is *not* leaving.')
  assert.ok(runs.some((r) => r.cls === 'fx-em' && r.text === 'not'))
  // Bold is tried before italic, or the second pair of stars is orphaned.
  const bold = screenplay('**LOUDLY**', 4).runs
  assert.equal(bold.map((r) => r.text).join(''), '**LOUDLY**')
  assert.ok(bold.some((r) => r.cls === 'fx-strong' && r.text === 'LOUDLY'))
})

check('screenplay dims a note wherever it sits on the line', () => {
  const runs = screenplay('He waits. [[is this too long?]]', 4).runs
  assert.equal(runs.map((r) => r.text).join(''), 'He waits. [[is this too long?]]')
  assert.ok(runs.some((r) => r.cls === 'fx-note' && r.text === '[[is this too long?]]'))
})

check('screenplay marks sections and synopses', () => {
  assert.equal(screenplay('# Act One', 0).cls, 'fx-section fx-section1')
  assert.equal(screenplay('= What this scene is for.', 0).cls, 'fx-synopsis')
})

// The six the spec has and this did not, each one measured before it was fixed.

check('screenplay opens no dialogue on the other shouting elements', () => {
  // A cue opens a block, so mistaking one of these for a name did not cost a
  // colour on one line — it took every line under it as something being said.
  for (const line of ['>THE END<', '~LA LA LA', '===']) {
    assert.equal(screenplay(line, 0).carry & 2, 0, `dialogue opened by ${line}`)
  }
})

check('screenplay tells a page break from a synopsis', () => {
  assert.equal(screenplay('===', 0).cls, 'fx-pagebreak')
  assert.equal(screenplay('====', 0).cls, 'fx-pagebreak')
  assert.equal(screenplay('= a note to self', 0).cls, 'fx-synopsis')
})

check('screenplay marks centred text and lyrics as themselves', () => {
  assert.equal(screenplay('>THE END<', 0).cls, 'fx-centred')
  assert.equal(screenplay('~Willy Wonka, Willy Wonka', 0).cls, 'fx-lyric')
})

check('screenplay carries the title page down its indented lines', () => {
  const key = screenplay('Title:', 0)
  assert.equal(key.cls, 'fx-title')
  const value = screenplay('    _**BRICK & STEEL**_', key.carry)
  assert.equal(value.cls, 'fx-title')
  // And a blank line is the end of it, or the whole script is a title page.
  assert.equal(screenplay('', value.carry).carry, 0)
})

check('screenplay leaves an escaped mark alone', () => {
  const BS = String.fromCharCode(92)
  const line = 'a ' + BS + '*x' + BS + '* b'
  const { runs } = screenplay(line, 4)
  assert.equal(runs.map((r) => r.text).join(''), line)
  assert.ok(!runs.some((r) => r.cls === 'fx-em'), 'escaped star still opened an italic')
})
