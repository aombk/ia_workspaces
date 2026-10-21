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

// ---------------------------------------------------------------- rendering
//
// The renderer builds DOM, so it needs a document. A stub rather than jsdom,
// as in systemStats.test.mjs: it records what was built and serialises it to
// HTML-ish text the checks can read. Nothing is ever parsed from a string, so
// a test that finds `<script>` *in the output* has found a text node.
console.log('\nRendering')

class TextNode {
  constructor(text) {
    this.text = text
    this.tag = '#text'
  }
  get textContent() {
    return this.text
  }
}
class Element {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.classes = new Set()
  }
  appendChild(child) {
    if (child.tag === '#fragment') this.children.push(...child.children)
    else this.children.push(child)
    return child
  }
  append(...children) {
    for (const child of children) this.appendChild(child)
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn
  }
  replaceWith() {}
  get childNodes() {
    return this.children
  }
  set className(value) {
    this.classes = new Set(value.split(' ').filter(Boolean))
  }
  get className() {
    return [...this.classes].join(' ')
  }
  get classList() {
    return { add: (c) => this.classes.add(c) }
  }
  set textContent(value) {
    this.children = [new TextNode(String(value))]
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('')
  }
}
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => new Element('#fragment'),
  createTextNode: (text) => new TextNode(text),
}

const { renderMarkdown } = await import(`file://${out}/markdown.js`)

/** The output as compact HTML — tags, the classes and attributes worth checking, and text. */
const serialize = (node) => {
  if (node.tag === '#text') return node.text.replace(/\n/g, ' ')
  let attrs = ''
  if (node.className) attrs += ` class="${node.className}"`
  if (node.style.textAlign) attrs += ` align="${node.style.textAlign}"`
  if (node.dataset.href) attrs += ` href="${node.dataset.href}"`
  if (node.dataset.wiki) attrs += ` wiki="${node.dataset.wiki}"`
  if (node.dataset.anchor) attrs += ` anchor="${node.dataset.anchor}"`
  if (node.start) attrs += ` start="${node.start}"`
  if (node.tag === 'input') attrs += node.checked ? ' checked' : ''
  if (node.tag === 'input') attrs += node.disabled ? ' disabled' : ''
  return `<${node.tag}${attrs}>${node.children.map(serialize).join('')}</${node.tag}>`
}
const md = (source, opts) => renderMarkdown(source, '', opts).children.map(serialize).join('')

check('a table, with a header, a body and the cells formatted', () => {
  assert.equal(
    md('| A | **B** |\n|---|---|\n| `x` | [y](https://y.example) |'),
    '<div class="md-table"><table><thead><tr><th>A</th><th><strong>B</strong></th></tr></thead>' +
      '<tbody><tr><td><code>x</code></td><td><a href="https://y.example">y</a></td></tr></tbody></table></div>'
  )
})

check('column alignment comes from the colons in the rule', () => {
  const html = md('| l | c | r | n |\n|:--|:-:|--:|---|\n| 1 | 2 | 3 | 4 |')
  assert.match(html, /<th align="left">l<\/th><th align="center">c<\/th><th align="right">r<\/th><th>n<\/th>/)
  assert.match(html, /<td align="left">1<\/td><td align="center">2<\/td><td align="right">3<\/td><td>4<\/td>/)
})

check('a pipe escaped or inside code is part of the cell, not a column', () => {
  assert.match(md('| a | b |\n|---|---|\n| x \\| y | `p|q` |'), /<td>x \| y<\/td><td><code>p\|q<\/code><\/td>/)
})

check('a ragged row is padded or trimmed to the header', () => {
  assert.match(md('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |'), /<tr><td>1<\/td><td><\/td><\/tr><tr><td>1<\/td><td>2<\/td><\/tr>/)
})

check('a table straight after a paragraph or a heading still starts', () => {
  assert.match(md('Intro line\n| a |\n|---|\n| 1 |'), /^<p>Intro line<\/p><div class="md-table">/)
  assert.match(md('### Keys\n| a |\n|---|\n| 1 |'), /^<h3 anchor="keys">Keys<\/h3><div class="md-table">/)
})

check('a line of dashes under text without pipes is a heading, not a table', () => {
  assert.equal(md('Title\n---'), '<h2 anchor="title">Title</h2>')
  assert.equal(md('Title\n==='), '<h1 anchor="title">Title</h1>')
})

check('a list item carries on over an indented or lazy line', () => {
  assert.equal(md('- one\n  carried on\n- two\nlazy too'), '<ul><li>one carried on</li><li>two lazy too</li></ul>')
})

check('lists nest by indentation', () => {
  assert.equal(
    md('- a\n  - b\n    - c\n- d'),
    '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'
  )
  assert.equal(md('1. a\n   1. b'), '<ol><li>a<ol><li>b</li></ol></li></ol>')
})

check('an ordered list keeps the number it starts at', () => {
  assert.equal(md('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>')
})

check('a blank line between items makes the list loose, with paragraphs', () => {
  assert.equal(md('- a\n\n- b'), '<ul><li><p>a</p></li><li><p>b</p></li></ul>')
})

check('a different marker starts a different list', () => {
  assert.equal(md('- a\n* b'), '<ul><li>a</li></ul><ul><li>b</li></ul>')
})

check('a paragraph can be interrupted by a list', () => {
  assert.equal(md('Steps:\n1. one\n2. two'), '<p>Steps:</p><ol><li>one</li><li>two</li></ol>')
})

check('a task in a nested list ticks its own line of the source', () => {
  const ticks = []
  const frag = renderMarkdown('- parent\n  - [ ] child', '', { onToggle: (line, on) => ticks.push([line, on]) })
  const box = frag.children[0].children[0].children[1].children[0].children[0]
  assert.equal(box.tag, 'input')
  assert.equal(box.disabled, false)
  box.checked = true
  box.listeners.change()
  assert.deepEqual(ticks, [[1, true]])
})

check('a task inside a quote is drawn, but read-only — its line cannot be patched', () => {
  assert.match(md('> - [x] done', { onToggle: () => {} }), /<input class="md-check" checked disabled>/)
})

check('emphasis nests inside emphasis, and around code and links', () => {
  assert.equal(md('**bold `code` and *it***'), '<p><strong>bold <code>code</code> and <em>it</em></strong></p>')
  assert.equal(md('*it **bold** it*'), '<p><em>it <strong>bold</strong> it</em></p>')
  assert.equal(md('***both***'), '<p><strong><em>both</em></strong></p>')
  assert.equal(md('**[link](https://a.example)**'), '<p><strong><a href="https://a.example">link</a></strong></p>')
  assert.equal(md('[**bold** link](https://a.example)'), '<p><a href="https://a.example"><strong>bold</strong> link</a></p>')
})

check('underscores inside a word are not emphasis', () => {
  assert.equal(md('snake_case_name and _this_'), '<p>snake_case_name and <em>this</em></p>')
})

check('an asterisk with space around it is just an asterisk', () => {
  assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>')
})

check('strikethrough', () => {
  assert.equal(md('~~gone~~ stays'), '<p><del>gone</del> stays</p>')
})

check('autolinks and bare URLs, without the punctuation after them', () => {
  assert.equal(md('<https://a.example/x>'), '<p><a href="https://a.example/x">https://a.example/x</a></p>')
  assert.equal(md('See https://a.example/x.'), '<p>See <a href="https://a.example/x">https://a.example/x</a>.</p>')
  assert.equal(
    md('(at https://en.wikipedia.org/wiki/Foo_(bar))'),
    '<p>(at <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>)</p>'
  )
  assert.equal(md('www.a.example'), '<p><a href="https://www.a.example">www.a.example</a></p>')
})

check('a URL as the text of a link is not a second link inside it', () => {
  assert.equal(md('[https://a.example](https://b.example)'), '<p><a href="https://b.example">https://a.example</a></p>')
})

check('reference links and images resolve, and their definitions are not drawn', () => {
  assert.equal(
    md('Read [the docs][d] or [D].\n\n[d]: https://d.example "Docs"'),
    '<p>Read <a href="https://d.example">the docs</a> or <a href="https://d.example">D</a>.</p>'
  )
})

check('brackets that are not a link stay as they were written', () => {
  assert.equal(md('**FLUX.2 [klein] 4B**'), '<p><strong>FLUX.2 [klein] 4B</strong></p>')
})

check('footnotes are numbered where cited and listed at the end', () => {
  const html = md('Claim[^a] and more[^b].\n\n[^b]: Second.\n[^a]: First.')
  assert.match(html, /^<p>Claim<sup class="md-footnote-ref"><a class="md-anchor">1<\/a><\/sup> and more<sup class="md-footnote-ref"><a class="md-anchor">2<\/a><\/sup>\.<\/p>/)
  assert.match(html, /<section class="md-footnotes"><hr><\/hr><ol><li anchor="fn-a">First\.<\/li><li anchor="fn-b">Second\.<\/li><\/ol><\/section>$/)
})

check('backslash escapes, entities and both kinds of hard break', () => {
  assert.equal(md('\\*not em\\* &amp; &copy; &#169; &#x2192;'), '<p>*not em* & © © →</p>')
  assert.equal(md('one  \ntwo\\\nthree\nfour'), '<p>one<br></br>two<br></br>three four</p>')
})

check('quotes nest, and hold lists and carry on lazily', () => {
  assert.equal(md('> a\n> > b'), '<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>')
  assert.equal(md('> - x\n> - y'), '<blockquote><ul><li>x</li><li>y</li></ul></blockquote>')
  assert.equal(md('> one\ntwo'), '<blockquote><p>one two</p></blockquote>')
})

check('code: tilde fences, longer fences, indented blocks, and spans with backticks in', () => {
  assert.equal(md('~~~js\nlet a\n~~~'), '<pre><code>let a</code></pre>')
  assert.equal(md('````\n```\ninner\n```\n````'), '<pre><code>```\ninner\n```</code></pre>'.replace(/\n/g, ' '))
  assert.equal(md('para\n\n    indented\n    code'), '<p>para</p><pre><code>indented code</code></pre>')
  assert.equal(md('`` a ` b ``'), '<p><code>a ` b</code></p>')
})

check('headings: closing hashes dropped, and every one gets a unique anchor', () => {
  assert.equal(md('## Notes ##\n## Notes\n## 3.1 Text → image!'), '<h2 anchor="notes">Notes</h2><h2 anchor="notes-1">Notes</h2><h2 anchor="31-text--image">3.1 Text → image!</h2>')
})

check('a #heading link is an in-page link, not an inert one', () => {
  assert.equal(md('[Go](#notes)'), '<p><a class="md-anchor">Go</a></p>')
})

check('the safe inline tags are built; everything else stays text', () => {
  assert.equal(md('<kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O<br>x'), '<p><kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O<br></br>x</p>')
  assert.equal(md('<script>alert(1)</script>'), '<p><script>alert(1)</script></p>'.replace(/<(\/?)script>/g, '<$1script>'))
  const frag = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
  assert.equal(frag.children[0].children.every((c) => c.tag === '#text'), true, 'nothing but text')
})

check('a javascript: link is drawn as text, not something to click', () => {
  assert.equal(md('[x](javascript:alert(1))'), '<p><a class="md-link-inert">x</a></p>')
})

check('what already worked still does: wiki links, comments, tasks', () => {
  assert.equal(md('[[my note|the note]]'), '<p><button class="md-wikilink" wiki="my note">the note</button></p>')
  assert.equal(md('a <!-- hidden --> b\n\n<!--\nblock\n-->\nc'), '<p>a  b</p><p>c</p>')
  assert.equal(md('- [ ] open\n- [x] done'), '<ul class="md-tasklist"><li class="md-task"><input class="md-check" disabled></input><span class="md-task__text">open</span></li><li class="md-task"><input class="md-check" checked disabled></input><span class="md-task__text">done</span></li></ul>')
})

check('a very long paragraph renders in linear time', () => {
  const started = Date.now()
  md('word *x* [y] `z` '.repeat(20000))
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`)
})

console.log(`\n${passed} checks passed`)
