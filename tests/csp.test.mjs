// Every custom scheme is granted the directives the element that loads it
// actually consults.
//
// This exists because of a bug that cost an afternoon and left no evidence.
// `iaw-doc:` was named in `object-src`, which is the directive for the
// `<embed>` element — and the reader still showed an empty grey pane. Chromium
// does not render a PDF inside the embed: it hands the stream to its own
// viewer, which is a plugin *document* in an internal frame, so the real load
// is governed by `frame-src`. With `default-src 'none'` and no `frame-src`, the
// frame was blocked before the protocol handler was ever asked for a byte.
//
// Nothing caught it. The handler had tests and passed them, the URL codec had
// tests and passed them, the scheme name matched, `tsc` was clean, and the only
// symptom anywhere was one console line in a window nobody had open.
//
// So: the CSP is read from the real `index.html` and checked against what each
// scheme is for. A directive that gets dropped in an edit fails here instead of
// silently blanking a pane.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const html = fs.readFileSync('src/renderer/index.html', 'utf8')

const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(html)
assert.ok(meta, 'index.html has no Content-Security-Policy meta tag')

/** `directive-name` -> the list of sources it grants. */
const policy = new Map(
  meta[1]
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...sources] = part.split(/\s+/)
      return [name, sources]
    })
)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const grants = (directive, source) => (policy.get(directive) ?? []).includes(source)

console.log('Content-Security-Policy')

check('the baseline is deny-everything', () => {
  // Every grant below is meaningful only because nothing is allowed by default.
  assert.deepEqual(policy.get('default-src'), ["'none'"])
})

check('images: iaw-img: is granted img-src', () => {
  // `<img>` reads img-src and nothing else.
  assert.ok(grants('img-src', 'iaw-img:'), 'img-src does not grant iaw-img:')
})

check('documents: iaw-doc: is granted BOTH object-src and frame-src', () => {
  // object-src covers the `<embed>` element; frame-src covers the plugin
  // document Chromium loads inside it. Granting only the first is the bug this
  // file was written for — it blanks the reader with no error a user can see.
  assert.ok(grants('object-src', 'iaw-doc:'), 'object-src does not grant iaw-doc:')
  assert.ok(
    grants('frame-src', 'iaw-doc:'),
    'frame-src does not grant iaw-doc: — the PDF viewer is a framed plugin document, ' +
      'so object-src alone renders an empty pane'
  )
})

check('media: iaw-media: is granted media-src', () => {
  // `<audio>` and `<video>` read media-src. No other directive covers them, and
  // in particular img-src does not.
  assert.ok(grants('media-src', 'iaw-media:'), 'media-src does not grant iaw-media:')
})

check('no scheme is granted a directive it has no business in', () => {
  // The separation is the point of having three schemes rather than one wide
  // grant: an injected `<img>` must not be able to become a plugin document,
  // and an injected `<embed>` must not be able to read the image scheme.
  assert.ok(!grants('img-src', 'iaw-doc:'), 'iaw-doc: must not be reachable from an <img>')
  assert.ok(!grants('object-src', 'iaw-img:'), 'iaw-img: must not be embeddable as a plugin')
  assert.ok(!grants('frame-src', 'iaw-img:'), 'iaw-img: must not be framable')
  assert.ok(!grants('object-src', 'iaw-media:'), 'iaw-media: must not be embeddable as a plugin')
})

check('the renderer still cannot reach the network', () => {
  // Whatever else changes, a pane must not be able to phone home. `connect-src`
  // is the local IPC bridge only, and there is no `https:` anywhere.
  for (const [name, sources] of policy) {
    for (const src of sources) {
      assert.ok(
        !/^https?:\/\/(?!ipc\.localhost)/.test(src),
        `${name} grants a remote origin: ${src}`
      )
    }
  }
})

check('every scheme the app registers is named somewhere in the policy', () => {
  // A scheme registered in main and forgotten in the CSP is a pane that fails
  // exactly the way the document one did.
  const named = new Set([...policy.values()].flat())
  for (const scheme of ['iaw-img:', 'iaw-doc:', 'iaw-media:']) {
    assert.ok(named.has(scheme), `${scheme} is registered but never granted`)
  }
})

console.log(`\n${passed} checks passed`)
