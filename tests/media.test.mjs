// Which files play, and the byte-range arithmetic behind seeking.
//
// The range parser gets the most attention here because its failures are the
// quiet kind: an off-by-one does not throw, it produces a video that stalls one
// frame from the end or a seek that lands in the wrong second. Pure function,
// so it is cheap to pin down exactly.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-media-'))
const outfile = path.join(sandbox, 'media.mjs')
await build({
  entryPoints: ['src/shared/media.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

const {
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_SCHEME,
  isAudioPath,
  isVideoPath,
  isMediaPath,
  mediaKind,
  encodeMediaPath,
  decodeMediaPath,
  mediaContentType,
  parseRange,
} = await import(`file://${outfile}`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

console.log('What plays')
{
  check('audio and video are told apart', () => {
    assert.equal(mediaKind('/a/track.mp3'), 'audio')
    assert.equal(mediaKind('/a/clip.mp4'), 'video')
    assert.equal(mediaKind('/a/notes.txt'), null)
    assert.ok(isAudioPath('x.WAV'), 'the test is case-insensitive')
    assert.ok(isVideoPath('x.MOV'))
  })

  check('a format the engine cannot decode is not offered', () => {
    // The lists exist to keep these out. A pane with a dead transport bar in it
    // is worse than the file staying a row in the tree.
    for (const name of ['a.avi', 'a.mkv', 'a.wmv', 'a.flv', 'a.wma', 'a.aiff', 'a.m2ts', 'a.ogv']) {
      assert.equal(isMediaPath(name), false, name)
    }
  })

  check('a folder that merely looks like a media file is refused', () => {
    for (const name of ['/home/me/mp4/', '/srv/mp3/index.html', 'C:\\wav\\notes.txt']) {
      assert.equal(isMediaPath(name), false, name)
    }
  })

  check('no extension is claimed by both lists', () => {
    const overlap = AUDIO_EXTENSIONS.filter((e) => VIDEO_EXTENSIONS.includes(e))
    assert.deepEqual(overlap, [], `ambiguous: ${overlap}`)
  })

  check('every extension has a content type that is not the fallback', () => {
    // A media element handed a type it does not know gives up before reading a
    // frame, and that failure looks exactly like a corrupt file.
    for (const ext of [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]) {
      const type = mediaContentType(`x.${ext}`)
      assert.notEqual(type, 'application/octet-stream', ext)
      assert.ok(/^(audio|video)\//.test(type), `${ext} -> ${type}`)
    }
  })
}

console.log('\nMedia URLs')
{
  check('the scheme is the one the CSP grants media-src', () => {
    assert.equal(MEDIA_SCHEME, 'iaw-media')
  })

  check('a path round-trips, Windows and unicode alike', () => {
    for (const p of [
      '/Users/me/Music/track 01.mp3',
      'C:\\Users\\me\\My Videos\\holiday #2.mp4',
      '/home/me/musique/été.flac',
    ]) {
      assert.equal(decodeMediaPath(encodeMediaPath(p)), p)
    }
  })

  check('a URL from another scheme is not ours', () => {
    // The boundary between the three schemes: each handler must refuse the
    // others, or one injected tag reaches all of them.
    assert.equal(decodeMediaPath('iaw-img://f/L2EucG5n'), null)
    assert.equal(decodeMediaPath('iaw-doc://f/L2EucGRm'), null)
  })
}

console.log('\nByte ranges')
{
  const SIZE = 1000

  check('no header means no range — the whole file', () => {
    assert.equal(parseRange(null, SIZE), null)
    assert.equal(parseRange('', SIZE), null)
  })

  check('an open-ended range runs to the last byte', () => {
    // `bytes=0-` is what a media element opens with, and the end is
    // size - 1, not size. That single byte is the whole bug class here.
    assert.deepEqual(parseRange('bytes=0-', SIZE), { start: 0, end: 999 })
    assert.deepEqual(parseRange('bytes=500-', SIZE), { start: 500, end: 999 })
  })

  check('a closed range is inclusive at both ends', () => {
    assert.deepEqual(parseRange('bytes=0-499', SIZE), { start: 0, end: 499 })
    assert.deepEqual(parseRange('bytes=500-999', SIZE), { start: 500, end: 999 })
    // One byte, which is a real request: probing whether ranges work at all.
    assert.deepEqual(parseRange('bytes=0-0', SIZE), { start: 0, end: 0 })
  })

  check('an end past the file is clamped, not refused', () => {
    assert.deepEqual(parseRange('bytes=900-5000', SIZE), { start: 900, end: 999 })
  })

  check('the suffix form means the last N bytes', () => {
    // How a player finds the moov atom in an mp4 that was not written for
    // streaming — it asks for the tail. Getting this wrong means "this video
    // cannot be played" on a large class of ordinary files.
    assert.deepEqual(parseRange('bytes=-500', SIZE), { start: 500, end: 999 })
    // More than the file is the whole file, not an error.
    assert.deepEqual(parseRange('bytes=-5000', SIZE), { start: 0, end: 999 })
  })

  check('a start past the end is refused', () => {
    assert.equal(parseRange('bytes=1000-', SIZE), null)
    assert.equal(parseRange('bytes=5000-6000', SIZE), null)
  })

  check('a backwards or malformed range is refused', () => {
    for (const h of ['bytes=500-100', 'bytes=abc-def', 'items=0-10', 'bytes=', 'bytes=-', '0-100']) {
      assert.equal(parseRange(h, SIZE), null, h)
    }
  })

  check('multi-range is refused rather than half-answered', () => {
    // Answering the first of several with a plain 206 would be a lie about
    // which bytes those are. No player sends this; refusing is correct anyway.
    assert.equal(parseRange('bytes=0-100,200-300', SIZE), null)
  })

  check('an empty file has no satisfiable range', () => {
    assert.equal(parseRange('bytes=0-', 0), null)
  })

  check('every returned range is inside the file and non-empty', () => {
    // The property that matters to the handler: content-length is computed as
    // end - start + 1, so a range outside the file is a stream that never ends.
    for (const h of ['bytes=0-', 'bytes=1-2', 'bytes=-1', 'bytes=999-', 'bytes=0-99999']) {
      const r = parseRange(h, SIZE)
      if (!r) continue
      assert.ok(r.start >= 0 && r.start < SIZE, h)
      assert.ok(r.end >= r.start && r.end < SIZE, h)
    }
  })
}

console.log(`\n${passed} checks passed`)
