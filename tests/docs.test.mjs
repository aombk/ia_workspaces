// Documents: what counts as one, and how a path on disk becomes a URL.
//
// The interesting half is the codec. A path is not a URL and never was —
// Windows writes them with backslashes, drive letters read as schemes, and real
// filenames carry `#`, `?`, `%` and every plane of unicode. `pathUrl.ts` steps
// around all of it by encoding the whole path into one base64url segment, so
// the URL parser is never asked to have an opinion about any of it. These
// checks are the ones that would catch that going wrong: a Windows path coming
// back with a slash in it, an emoji filename throwing on the way out.
//
// The other half is the boundary between the two schemes. A PDF reaches the
// page through `object-src` and an image through `img-src`, and the only thing
// keeping those two grants apart is that each decoder refuses the other's URLs.
// That is asserted here in both directions, because a regression there is not a
// broken picture — it is every `<img>` on the page becoming one injected tag
// away from an embedded plugin document.
//
// Bundled with esbuild so the real TypeScript runs, like every other suite.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-docs-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    docs: 'src/shared/docs.ts',
    images: 'src/shared/images.ts',
    pathUrl: 'src/shared/pathUrl.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})

const {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_SCHEME,
  isDocumentPath,
  encodeDocumentPath,
  decodeDocumentPath,
} = await import(`file://${out}/docs.js`)
const { IMAGE_SCHEME, isImagePath, encodeImagePath, decodeImagePath } = await import(
  `file://${out}/images.js`
)
const { schemePrefix, encodePathUrl, decodePathUrl } = await import(`file://${out}/pathUrl.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const DOC_PREFIX = 'iaw-doc://f/'
const IMG_PREFIX = 'iaw-img://f/'

/** The part of a URL after the scheme and host — the bit that must be one segment. */
const bodyOf = (url, prefix) => url.slice(prefix.length)

/**
 * Paths chosen because each one is a different way to break a naive URL.
 *
 * Not a grab bag: drive letters look like schemes, backslashes look like
 * nothing at all to a URL parser, `#` truncates, `?` starts a query, `%`
 * begins an escape that is not there, `+` and `/` and `=` are the three
 * characters plain base64 would leak into the segment, and the last two are
 * above U+00FF — the range `btoa` refuses outright.
 */
const AWKWARD_PATHS = [
  'C:\\Users\\me\\Documents\\plans.pdf',
  'C:\\Users\\me\\My Documents\\Q3 report (final).pdf',
  '/home/me/docs/100% margin.pdf',
  '/home/me/docs/a#b?c.pdf',
  '/home/me/docs/a+b/c=d.pdf',
  '/home/me/docs/../sibling/notes.pdf',
  'C:\\docs\\back\\\\slash.pdf',
  '/home/me/docs/ünïcode – ✨.pdf',
  '/home/me/docs/📄 drawings 🏗️.pdf',
  '/home/me/docs/日本語のファイル名.pdf',
]

// ---------------------------------------------------------- what is a document
console.log('Recognising documents')
{
  check('PDF is the whole list, and it is a list on purpose', () => {
    // A set rather than a constant because the next format that a host learns
    // to render should be a line here, not a new branch in the reader.
    assert.deepEqual([...DOCUMENT_EXTENSIONS], ['pdf'])
  })

  check('a pdf is a document whatever case it was saved in', () => {
    // Windows and macOS both hand back whatever case the file was created
    // with, and nobody types the extension consistently.
    for (const name of [
      'plans.pdf',
      'PLANS.PDF',
      'Plans.Pdf',
      'C:\\Users\\me\\plans.PDF',
      '/home/me/docs/plans.pDf',
    ]) {
      assert.equal(isDocumentPath(name), true, name)
    }
  })

  check('nothing else is', () => {
    for (const name of ['notes.txt', 'a.md', 'photo.png', 'archive.zip', 'book.epub']) {
      assert.equal(isDocumentPath(name), false, name)
    }
  })

  check('a file with no extension at all is not one', () => {
    // The common shape in a repo — LICENSE, Makefile, a bare script — and the
    // case a regex without an anchor happily mishandles.
    for (const name of ['README', 'Makefile', '/home/me/notes', 'C:\\bin\\tool']) {
      assert.equal(isDocumentPath(name), false, name)
    }
  })

  check('the extension has to end the name, not merely appear in it', () => {
    // This is the anchor doing its job. `plans.pdf.txt` is a text file someone
    // renamed, and handing it to a plugin document because the name contains
    // ".pdf" is exactly the confusion the check exists to prevent.
    for (const name of [
      'plans.pdf.txt',
      'plans.pdf.bak',
      'plans.pdf.gz',
      '/home/me/my.pdf.notes/readme',
    ]) {
      assert.equal(isDocumentPath(name), false, name)
    }
  })

  check('a folder that happens to be called pdf is not a document', () => {
    // A directory-looking path: nothing after the final separator, or a `pdf`
    // component in the middle. Neither is a file the viewer can open.
    for (const name of ['/home/me/pdf/', 'C:\\pdf\\', 'C:\\pdf\\notes.txt', '/srv/pdf/index.html']) {
      assert.equal(isDocumentPath(name), false, name)
    }
  })
}

// ------------------------------------------------------------- document URLs
console.log('Document URLs')
{
  check('the scheme is the one the CSP grants object-src', () => {
    // Named in `index.html` and in `docProtocol.ts`; if this drifts the viewer
    // goes blank with a console error and no other symptom.
    assert.equal(DOCUMENT_SCHEME, 'iaw-doc')
    assert.equal(schemePrefix(DOCUMENT_SCHEME), DOC_PREFIX)
    assert.ok(encodeDocumentPath('/a.pdf').startsWith(DOC_PREFIX))
  })

  check('a Windows path survives the round trip', () => {
    // Drive letter and backslashes both intact — the pair that a `file://`
    // concatenation mangles into a relative path on some other volume.
    const p = 'C:\\Users\\me\\My Documents\\Q3 plans.pdf'
    assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p)
  })

  check('a UNC path survives the round trip', () => {
    // Leading double backslash, which a URL parser reads as an authority.
    const p = '\\\\fileserver\\share\\drawings\\set A.pdf'
    assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p)
  })

  check('the characters that break URL parsing survive', () => {
    for (const p of AWKWARD_PATHS) {
      assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p, p)
    }
  })

  check('every printable ASCII character survives in a filename', () => {
    // A sweep rather than a handful, because the failure mode is one character
    // in the middle of the range being eaten and nobody noticing until a
    // customer names a file with it.
    for (let code = 32; code < 127; code++) {
      const p = `/home/me/docs/x${String.fromCharCode(code)}y.pdf`
      assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p, `U+${code.toString(16)}`)
    }
  })

  check('an astral-plane filename survives, where raw btoa would have thrown', () => {
    // The stated reason the codec goes through UTF-8 first. Asserting that
    // `btoa` really does throw on the same input keeps the comment in
    // `pathUrl.ts` honest: this is not a precaution against a hypothetical.
    const p = '/home/me/docs/📄 drawings 🏗️ 👨‍👩‍👧.pdf'
    assert.throws(() => btoa(p), 'btoa is supposed to refuse this — the workaround is the point')
    assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p)
  })

  check('encoding never throws, whatever the filename holds', () => {
    // Including a lone surrogate, which is a shape a Windows filename can
    // genuinely take. The encoder must come back with a URL rather than
    // exploding in the preload script where nothing catches it.
    for (const p of [...AWKWARD_PATHS, '/home/me/docs/\uD800lone.pdf', '/\u0000null.pdf']) {
      assert.doesNotThrow(() => encodeDocumentPath(p), p)
      assert.ok(encodeDocumentPath(p).startsWith(DOC_PREFIX), p)
    }
  })

  check('a very long path survives, since drawing sets live deep in a tree', () => {
    const p = `/home/me/${'nested/'.repeat(400)}set.pdf`
    assert.equal(decodeDocumentPath(encodeDocumentPath(p)), p)
  })

  check('the same path always encodes to the same URL', () => {
    // The viewer keys off the URL; an encoding that varied would reload the
    // document on every render.
    const p = 'C:\\docs\\plans.pdf'
    assert.equal(encodeDocumentPath(p), encodeDocumentPath(p))
  })
}

// -------------------------------------------------------- one path segment
console.log('One path segment')
{
  check('nothing that reads as a separator survives into the encoded part', () => {
    // base64url, so the body cannot be read as a second path segment, a query
    // or a fragment — which is the entire reason for encoding rather than
    // escaping. `+` and `=` are here too: plain base64 emits both, and both
    // change meaning in a URL.
    for (const p of AWKWARD_PATHS) {
      const body = bodyOf(encodeDocumentPath(p), DOC_PREFIX)
      assert.equal(/[/+=?#%\\]/.test(body), false, `${p} -> ${body}`)
    }
  })

  check('the URL has exactly one segment after the host', () => {
    // Stated as the shape a handler will actually see: `iaw-doc`, host `f`,
    // and one thing after it. Any extra `/` and the path has been split.
    for (const p of AWKWARD_PATHS) {
      const url = encodeDocumentPath(p)
      const [scheme, rest] = url.split('://')
      assert.equal(scheme, DOCUMENT_SCHEME, p)
      const segments = rest.split('/')
      assert.equal(segments.length, 2, `${p} -> ${url}`)
      assert.equal(segments[0], 'f', p)
    }
  })

  check('the body is base64url and nothing else', () => {
    for (const p of AWKWARD_PATHS) {
      const body = bodyOf(encodeDocumentPath(p), DOC_PREFIX)
      assert.equal(/^[A-Za-z0-9_-]*$/.test(body), true, `${p} -> ${body}`)
    }
  })
}

// -------------------------------------------------------- URLs that are not ours
console.log('URLs that are not ours')
{
  check('a file URL decodes to null', () => {
    // The one that matters: `file://` is precisely what the scheme exists to
    // avoid handing to the renderer, so the decoder must not launder it back.
    assert.equal(decodeDocumentPath('file:///C:/Users/me/plans.pdf'), null)
    assert.equal(decodeDocumentPath('file:///home/me/docs/plans.pdf'), null)
  })

  check('a remote URL decodes to null', () => {
    assert.equal(decodeDocumentPath('https://example.com/plans.pdf'), null)
    assert.equal(decodeDocumentPath('http://localhost:8080/plans.pdf'), null)
    assert.equal(decodeDocumentPath('data:application/pdf;base64,AAAA'), null)
  })

  check('garbage decodes to null', () => {
    for (const url of ['not a url at all', '://', 'iaw-doc', 'iaw-doc:', 'iaw-doc:/f/AAAA', '/f/AAAA']) {
      assert.equal(decodeDocumentPath(url), null, url)
    }
  })

  check('the empty string decodes to null', () => {
    // A handler reached with nothing at all — cheaper to pin here than to
    // discover as a thrown error inside `protocol.handle`.
    assert.equal(decodeDocumentPath(''), null)
  })

  check('the prefix on its own decodes to null', () => {
    // There is no such thing as a document at the empty path.
    assert.equal(decodeDocumentPath(DOC_PREFIX), null)
  })

  check('a URL under our scheme never throws, however malformed its body', () => {
    // The handler calls this on whatever Chromium hands it, so the contract is
    // "returns something" rather than "raises". Note that it is deliberately
    // not asserted that these all come back null — see the note on the decoder
    // being lenient about bodies that are valid base64 but not valid UTF-8.
    for (const body of ['!!!!', 'zzzz', 'z', '====', ' ', '..', '%2Fetc%2Fpasswd', 'AAAA'.repeat(500)]) {
      assert.doesNotThrow(() => decodeDocumentPath(DOC_PREFIX + body), body)
    }
  })

  check('a query stuck on the end is not quietly accepted', () => {
    // A query puts characters in the body that are not in the base64url
    // alphabet, and the decoder must not shrug and decode the prefix. There is
    // no legitimate way for one to arrive: nothing in the app mints them.
    const url = encodeDocumentPath('/home/me/docs/plans.pdf')
    assert.equal(decodeDocumentPath(`${url}?page=3`), null)
  })

  check('a fragment is ignored rather than fatal', () => {
    // The one deliberate exception, and it earns its place. A fragment is not
    // part of what was encoded — the engine strips it before a request is even
    // made — and the reader pane hangs a counter off a PDF's URL to force a
    // reload past the cache. A decoder that rejected that would turn Reload
    // into a 400 on any host that did pass the `#` through.
    const path = '/home/me/docs/plans.pdf'
    const url = encodeDocumentPath(path)
    assert.equal(decodeDocumentPath(`${url}#page=3`), path)
    assert.equal(decodeDocumentPath(`${url}#iaw-load=7`), path)
    // Still the same file, and still only that file: what precedes the `#`
    // must be a body we could have minted.
    assert.equal(decodeDocumentPath(`${url}!!#iaw-load=7`), null)
  })
}

// ------------------------------------------------- keeping the two schemes apart
console.log('Keeping the two schemes apart')
{
  const docPath = 'C:\\Users\\me\\Documents\\plans.pdf'
  const imgPath = 'C:\\Users\\me\\Pictures\\cat.png'

  check('an image URL does not decode as a document', () => {
    // The boundary. `iaw-img:` is named in `img-src` and `iaw-doc:` in
    // `object-src`; if the document handler accepted image URLs then anything
    // reachable as a picture would also be reachable as a plugin document, and
    // the two CSP grants would have collapsed into one.
    assert.equal(decodeDocumentPath(encodeImagePath(imgPath)), null)
    assert.equal(decodeDocumentPath(encodeImagePath(docPath)), null)
  })

  check('a document URL does not decode as an image', () => {
    // And the other direction, which is the one that would let an injected
    // `<img>` pull a PDF through the image handler.
    assert.equal(decodeImagePath(encodeDocumentPath(docPath)), null)
    assert.equal(decodeImagePath(encodeDocumentPath(imgPath)), null)
  })

  check('the two schemes mint different URLs for the same path', () => {
    assert.notEqual(encodeDocumentPath(docPath), encodeImagePath(docPath))
    assert.notEqual(DOCUMENT_SCHEME, IMAGE_SCHEME)
  })

  check('only the scheme keeps them apart, so the scheme is load bearing', () => {
    // The encoded bodies are identical — the codec knows nothing about what
    // kind of file it is holding. Everything separating a document URL from an
    // image URL is the prefix, which is why the prefix is checked first and
    // exactly.
    assert.equal(
      bodyOf(encodeDocumentPath(docPath), DOC_PREFIX),
      bodyOf(encodeImagePath(docPath), IMG_PREFIX)
    )
  })

  check('each decoder still accepts its own URLs', () => {
    // The isolation checks above would also pass if both decoders returned
    // null for everything.
    assert.equal(decodeDocumentPath(encodeDocumentPath(docPath)), docPath)
    assert.equal(decodeImagePath(encodeImagePath(imgPath)), imgPath)
  })

  check('a scheme that merely prefixes ours is not ours', () => {
    // `iaw` is a prefix of `iaw-doc` as a string. The `://f/` in the prefix is
    // what stops a `startsWith` from being fooled by that.
    assert.equal(decodePathUrl('iaw', encodeDocumentPath('/a.pdf')), null)
    assert.equal(decodePathUrl('iaw-doc', encodePathUrl('iaw-doc-x', '/a.pdf')), null)
  })
}

// ------------------------------------------- the image codec after the move
//
// `images.ts` used to own this codec and now borrows it from `pathUrl.ts`. The
// refactor is only worth having if the image side came through it unchanged, so
// the cases that mattered there are re-run against the shared implementation.
console.log('The image codec after the move')
{
  check('the image scheme is unchanged', () => {
    assert.equal(IMAGE_SCHEME, 'iaw-img')
    assert.ok(encodeImagePath('/a.png').startsWith(IMG_PREFIX))
  })

  check('a Windows image path still survives the round trip', () => {
    const p = 'C:\\Users\\me\\My Photos\\cat.png'
    assert.equal(decodeImagePath(encodeImagePath(p)), p)
  })

  check('the awkward characters still survive on the image side', () => {
    for (const p of [
      'C:\\photos\\100% done.png',
      'C:\\photos\\a#b?c.png',
      'C:\\photos\\ünïcode ✨.jpg',
      'C:\\photos\\📷 holiday.jpeg',
      '/home/me/pictures/what is this.png',
      'C:\\photos\\back\\\\slash.png',
    ]) {
      assert.equal(decodeImagePath(encodeImagePath(p)), p, p)
    }
  })

  check('the image URL is still a single segment', () => {
    const body = bodyOf(encodeImagePath('C:\\photos\\a/b+c=d.png'), IMG_PREFIX)
    assert.equal(/[/+=?#%\\]/.test(body), false, body)
  })

  check('foreign URLs still decode to null on the image side', () => {
    assert.equal(decodeImagePath('file:///C:/photos/cat.png'), null)
    assert.equal(decodeImagePath('https://example.com/cat.png'), null)
    assert.equal(decodeImagePath(''), null)
  })

  check('recognising images is untouched by the move', () => {
    // The refactor was to the codec only; this is here so a stray edit to the
    // regex in the same file does not go out unnoticed.
    assert.equal(isImagePath('a.png'), true)
    assert.equal(isImagePath('b.JPG'), true)
    assert.equal(isImagePath('c.png.txt'), false)
    assert.equal(isImagePath('plans.pdf'), false)
  })

  check('a document is not an image and an image is not a document', () => {
    // The two predicates decide which pane opens a file, so an overlap would
    // be a file that renders as both or as neither.
    assert.equal(isImagePath('plans.pdf'), false)
    assert.equal(isDocumentPath('cat.png'), false)
    assert.equal(isDocumentPath('drawing.svg'), false)
  })
}

// ---------------------------------------------------------------- the codec
//
// `pathUrl.ts` is generic over the scheme, and the point of extracting it was
// that a third scheme should be free. These check it against a scheme neither
// module uses, so nothing here can pass by accident of the two callers.
console.log('The codec itself')
{
  check('a prefix is the scheme, a host of f, and a slash', () => {
    assert.equal(schemePrefix('iaw-doc'), 'iaw-doc://f/')
    assert.equal(schemePrefix('iaw-img'), 'iaw-img://f/')
    assert.equal(schemePrefix('iaw-thing'), 'iaw-thing://f/')
  })

  check('any scheme round trips', () => {
    for (const scheme of ['iaw-thing', 'x', 'iaw-doc']) {
      for (const p of AWKWARD_PATHS) {
        assert.equal(decodePathUrl(scheme, encodePathUrl(scheme, p)), p, `${scheme} ${p}`)
      }
    }
  })

  check('a URL is only ever decoded by the scheme that minted it', () => {
    // The general form of the isolation the two real schemes rely on: this
    // holds for any pair, so a third scheme arrives with the boundary already
    // in place rather than needing one written for it.
    const schemes = ['iaw-doc', 'iaw-img', 'iaw-thing']
    for (const minted of schemes) {
      const url = encodePathUrl(minted, '/home/me/file.pdf')
      for (const reader of schemes) {
        const decoded = decodePathUrl(reader, url)
        if (reader === minted) assert.equal(decoded, '/home/me/file.pdf', reader)
        else assert.equal(decoded, null, `${reader} should not read ${minted}`)
      }
    }
  })
}

console.log(`\n${passed} checks passed`)
