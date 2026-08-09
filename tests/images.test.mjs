// The images pane's arithmetic: which files count, what order they go in, and
// where each one lands. Bundled with esbuild so the real TypeScript runs.
//
// Layout is the part worth testing hardest. A row that overflows its container
// by a fraction of a pixel is invisible in a screenshot and obvious in a
// horizontal scrollbar, and the whole point of keeping the maths pure was to be
// able to assert on it without a DOM.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-images-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { images: 'src/shared/images.ts', files: 'src/main/files.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})

const {
  isImagePath,
  encodeImagePath,
  decodeImagePath,
  sortImages,
  sortEntries,
  seededRandom,
  layoutRows,
  layoutMasonry,
  layoutBoard,
  fitToHeight,
} = await import(`file://${out}/images.js`)
const { copyEntry, moveEntry } = await import(`file://${out}/files.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

/** An item with a known aspect ratio, for the layout checks. */
const item = (name, aspect, extra = {}) => ({
  path: `C:\\photos\\${name}`,
  name,
  size: extra.size ?? 1000,
  modified: extra.modified ?? 0,
  aspect,
})

const GAP = 8

// ------------------------------------------------------------ what is an image
console.log('Recognising images')
{
  check('common formats are images', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.svg']) {
      assert.equal(isImagePath(name), true, name)
    }
  })

  check('everything else is not', () => {
    for (const name of ['a.ts', 'b.md', 'c.png.txt', 'd.psd', 'e.tiff', 'notanimage']) {
      assert.equal(isImagePath(name), false, name)
    }
  })

  check('the extension must end the name', () => {
    // Guards the regex anchor: without `$` a directory called `png` or a file
    // named `image.png.bak` would be treated as a picture.
    assert.equal(isImagePath('C:\\png\\notes.txt'), false)
    assert.equal(isImagePath('cat.png.bak'), false)
  })
}

// ---------------------------------------------------------------------- URLs
console.log('Image URLs')
{
  check('a windows path survives the round trip', () => {
    const p = 'C:\\Users\\me\\My Photos\\cat.png'
    assert.equal(decodeImagePath(encodeImagePath(p)), p)
  })

  check('the characters that break URL parsing survive', () => {
    // Every one of these is a real filename and a different way to break a
    // naive `file://` concatenation.
    for (const p of [
      'C:\\photos\\100% done.png',
      'C:\\photos\\a#b?c.png',
      'C:\\photos\\ünïcode ✨.jpg',
      '/home/me/pictures/what is this.png',
      'C:\\photos\\back\\\\slash.png',
    ]) {
      assert.equal(decodeImagePath(encodeImagePath(p)), p, p)
    }
  })

  check('the encoded form has no separators left in it', () => {
    // base64url, so nothing after the prefix can be read as a path segment or a
    // query — which is the entire reason for encoding rather than escaping.
    const url = encodeImagePath('C:\\photos\\a/b+c=d.png')
    const body = url.slice('iaw-img://f/'.length)
    assert.equal(/[/+=?#]/.test(body), false, body)
  })

  check('a foreign url decodes to null', () => {
    assert.equal(decodeImagePath('file:///C:/photos/cat.png'), null)
    assert.equal(decodeImagePath('https://example.com/cat.png'), null)
  })
}

// ------------------------------------------------------------------- ordering
console.log('Ordering a gallery')
{
  const items = [
    item('img10.png', 1, { size: 300, modified: 1000 }),
    item('img2.png', 1, { size: 100, modified: 3000 }),
    item('img1.png', 1, { size: 200, modified: 2000 }),
  ]

  check('name sorts numerically, not lexically', () => {
    // The reason people number files at all: img2 before img10.
    const names = sortImages(items, 'name', false, 1).map((i) => i.name)
    assert.deepEqual(names, ['img1.png', 'img2.png', 'img10.png'])
  })

  check('name reversed', () => {
    const names = sortImages(items, 'name', true, 1).map((i) => i.name)
    assert.deepEqual(names, ['img10.png', 'img2.png', 'img1.png'])
  })

  check('size ascending', () => {
    const sizes = sortImages(items, 'size', false, 1).map((i) => i.size)
    assert.deepEqual(sizes, [100, 200, 300])
  })

  check('date ascending', () => {
    const dates = sortImages(items, 'modified', false, 1).map((i) => i.modified)
    assert.deepEqual(dates, [1000, 2000, 3000])
  })

  check('ties break by name, so the order is never arbitrary', () => {
    const tied = [item('b.png', 1, { size: 50 }), item('a.png', 1, { size: 50 })]
    assert.deepEqual(
      sortImages(tied, 'size', false, 1).map((i) => i.name),
      ['a.png', 'b.png']
    )
  })

  check('random is stable for a seed', () => {
    // The property the whole feature rests on: the gallery re-lays out on every
    // app render, and an unstable order would make the images jump.
    const a = sortImages(items, 'random', false, 42).map((i) => i.name)
    const b = sortImages(items, 'random', false, 42).map((i) => i.name)
    assert.deepEqual(a, b)
  })

  check('a different seed is a different order', () => {
    const many = Array.from({ length: 25 }, (_, i) => item(`i${i}.png`, 1))
    const a = sortImages(many, 'random', false, 1).map((i) => i.name)
    const b = sortImages(many, 'random', false, 2).map((i) => i.name)
    assert.notDeepEqual(a, b)
  })

  check('random keeps every item exactly once', () => {
    const many = Array.from({ length: 50 }, (_, i) => item(`i${i}.png`, 1))
    const shuffled = sortImages(many, 'random', false, 7)
    assert.equal(shuffled.length, 50)
    assert.equal(new Set(shuffled.map((i) => i.name)).size, 50)
  })

  check('sorting does not mutate the input', () => {
    const original = items.map((i) => i.name)
    sortImages(items, 'size', true, 1)
    assert.deepEqual(
      items.map((i) => i.name),
      original
    )
  })

  check('the seeded rng stays in range', () => {
    const rand = seededRandom(12345)
    for (let i = 0; i < 500; i++) {
      const v = rand()
      assert.ok(v >= 0 && v < 1, `out of range: ${v}`)
    }
  })
}

// -------------------------------------------------------------- tree ordering
console.log('Ordering the file tree')
{
  const entries = [
    { name: 'b.txt', isDir: false, size: 300, modified: 100 },
    { name: 'zed', isDir: true, size: 0, modified: 900 },
    { name: 'a.txt', isDir: false, size: 100, modified: 500 },
    { name: 'alpha', isDir: true, size: 0, modified: 1 },
  ]

  check('folders lead, whatever the sort', () => {
    for (const sort of ['name', 'size', 'modified', 'extension']) {
      for (const desc of [false, true]) {
        const kinds = sortEntries(entries, sort, desc).map((e) => e.isDir)
        assert.deepEqual(kinds, [true, true, false, false], `${sort} desc=${desc}`)
      }
    }
  })

  check('reversing does not float files above folders', () => {
    // "Descending" means within each group. Letting it flip the groups makes
    // the folder block jump around every time direction is toggled.
    const names = sortEntries(entries, 'name', true).map((e) => e.name)
    assert.deepEqual(names, ['zed', 'alpha', 'b.txt', 'a.txt'])
  })

  check('sorting by size leaves folders on name', () => {
    // A directory entry's own size says nothing about what is inside it, so
    // ordering folders by it would be ordering them by noise.
    const names = sortEntries(entries, 'size', false).map((e) => e.name)
    assert.deepEqual(names, ['alpha', 'zed', 'a.txt', 'b.txt'])
  })

  check('sorting by type groups extensions, then names within one', () => {
    // What "sort by type" is for: every .ts together, every .png together.
    // Extensionless files lead, since an empty suffix sorts first.
    const files = [
      { name: 'b.ts', isDir: false, size: 1, modified: 1 },
      { name: 'z.png', isDir: false, size: 1, modified: 1 },
      { name: 'LICENSE', isDir: false, size: 1, modified: 1 },
      { name: 'a.ts', isDir: false, size: 1, modified: 1 },
      { name: 'a.png', isDir: false, size: 1, modified: 1 },
    ]
    const names = sortEntries(files, 'extension', false).map((e) => e.name)
    assert.deepEqual(names, ['LICENSE', 'a.png', 'z.png', 'a.ts', 'b.ts'])
  })

  check('type sorting leaves folders on name, and folders still lead', () => {
    // A folder has no type, so ordering them by one would be ordering them by
    // nothing — the same reason size leaves them alone.
    const names = sortEntries(entries, 'extension', false).map((e) => e.name)
    assert.deepEqual(names, ['alpha', 'zed', 'a.txt', 'b.txt'])
  })

  check('reversing type sorting reverses the types, not the names inside one', () => {
    // Folders have no type, so they order by name and reverse with it — the
    // same fall-through `size` uses. The two files share an extension, so they
    // tie on type and settle on the name tiebreak, which stays ascending
    // whatever the direction: that is what makes it a stable secondary order,
    // and it is how sorting by size and by date already behave on a tie.
    const names = sortEntries(entries, 'extension', true).map((e) => e.name)
    assert.deepEqual(names, ['zed', 'alpha', 'a.txt', 'b.txt'])
  })

  check('sorting by date does apply to folders', () => {
    // alpha(1) before zed(900); b.txt(100) before a.txt(500) — oldest first,
    // and the two groups ordered independently.
    const names = sortEntries(entries, 'modified', false).map((e) => e.name)
    assert.deepEqual(names, ['alpha', 'zed', 'b.txt', 'a.txt'])
  })
}

// ------------------------------------------------------------- justified rows
console.log('Justified rows')
{
  const wide = Array.from({ length: 12 }, (_, i) => item(`w${i}.png`, 1.5))

  check('every full row spans the width exactly', () => {
    const { placed } = layoutRows(wide, 1000, 200, GAP)
    const rows = new Map()
    for (const p of placed) {
      if (!rows.has(p.y)) rows.set(p.y, [])
      rows.get(p.y).push(p)
    }
    const ys = [...rows.keys()].sort((a, b) => a - b)
    // The last row is deliberately not stretched, so it is excluded.
    for (const y of ys.slice(0, -1)) {
      const row = rows.get(y)
      const right = Math.max(...row.map((p) => p.x + p.width))
      assert.ok(Math.abs(right - 1000) < 0.5, `row at ${y} ended at ${right}`)
    }
  })

  check('nothing overflows the container', () => {
    const { placed } = layoutRows(wide, 640, 200, GAP)
    for (const p of placed) {
      assert.ok(p.x >= -0.5, `negative x: ${p.x}`)
      assert.ok(p.x + p.width <= 640.5, `overflow: ${p.x + p.width}`)
    }
  })

  check('aspect ratios are preserved, so nothing is cropped', () => {
    const mixed = [item('tall.png', 0.5), item('wide.png', 3), item('square.png', 1)]
    for (const p of layoutRows(mixed, 900, 200, GAP).placed) {
      assert.ok(
        Math.abs(p.width / p.height - p.item.aspect) < 0.001,
        `${p.item.name} came out at ${p.width / p.height}`
      )
    }
  })

  check('images in a row share one height', () => {
    const mixed = [item('a.png', 0.5), item('b.png', 3), item('c.png', 1), item('d.png', 2)]
    const rows = new Map()
    for (const p of layoutRows(mixed, 800, 200, GAP).placed) {
      if (!rows.has(p.y)) rows.set(p.y, [])
      rows.get(p.y).push(p)
    }
    for (const row of rows.values()) {
      const first = row[0].height
      for (const p of row) assert.ok(Math.abs(p.height - first) < 0.001, p.item.name)
    }
  })

  check('the last row is not blown up to fill the width', () => {
    // One leftover wide image solved to the full width would tower over every
    // row above it.
    const { placed } = layoutRows([item('only.png', 1.5)], 1200, 200, GAP)
    assert.equal(placed.length, 1)
    assert.ok(placed[0].height <= 200.5, `last row grew to ${placed[0].height}`)
  })

  check('an unmeasured image still gets a sane box', () => {
    // aspect 0 means "the header has not been read yet", which is the state
    // every image is in for the first frame.
    const { placed } = layoutRows([item('pending.png', 0)], 1000, 200, GAP)
    assert.ok(placed[0].width > 0 && placed[0].height > 0)
  })

  check('empty input is empty output', () => {
    assert.deepEqual(layoutRows([], 1000, 200, GAP), { placed: [], height: 0 })
  })

  check('a zero-width container does not divide by zero', () => {
    // Real: the pane is measured before it has been laid out.
    const { placed, height } = layoutRows(wide, 0, 200, GAP)
    assert.deepEqual(placed, [])
    assert.equal(height, 0)
  })

  check('reported height covers everything placed', () => {
    const { placed, height } = layoutRows(wide, 700, 200, GAP)
    const bottom = Math.max(...placed.map((p) => p.y + p.height))
    assert.ok(Math.abs(bottom - height) < 0.5, `height ${height} vs bottom ${bottom}`)
  })
}

// -------------------------------------------------------------------- masonry
console.log('Masonry columns')
{
  const items = Array.from({ length: 20 }, (_, i) => item(`m${i}.png`, 0.6 + (i % 5) * 0.4))

  check('columns are uniform and fill the width', () => {
    const { placed } = layoutMasonry(items, 1000, 250, GAP)
    const widths = new Set(placed.map((p) => Math.round(p.width * 100)))
    assert.equal(widths.size, 1, 'every column should be the same width')
    const right = Math.max(...placed.map((p) => p.x + p.width))
    assert.ok(Math.abs(right - 1000) < 0.5, `columns ended at ${right}`)
  })

  check('aspect ratios are preserved', () => {
    for (const p of layoutMasonry(items, 1000, 250, GAP).placed) {
      assert.ok(Math.abs(p.width / p.height - p.item.aspect) < 0.001, p.item.name)
    }
  })

  check('nothing overlaps within a column', () => {
    const byColumn = new Map()
    for (const p of layoutMasonry(items, 1000, 250, GAP).placed) {
      const key = Math.round(p.x)
      if (!byColumn.has(key)) byColumn.set(key, [])
      byColumn.get(key).push(p)
    }
    for (const column of byColumn.values()) {
      column.sort((a, b) => a.y - b.y)
      for (let i = 1; i < column.length; i++) {
        const prev = column[i - 1]
        assert.ok(column[i].y >= prev.y + prev.height - 0.001, 'overlap in column')
      }
    }
  })

  check('a container narrower than one column still gives one column', () => {
    const { placed } = layoutMasonry(items, 100, 250, GAP)
    assert.equal(new Set(placed.map((p) => Math.round(p.x))).size, 1)
  })
}

// ---------------------------------------------------------------------- board
console.log('Board')
{
  const items = Array.from({ length: 15 }, (_, i) => item(`b${i}.png`, 1 + (i % 4) * 0.5))

  check('is stable for a seed', () => {
    const a = layoutBoard(items, 900, 200, GAP, 5)
    const b = layoutBoard(items, 900, 200, GAP, 5)
    assert.deepEqual(a, b)
  })

  check('a different seed scatters differently', () => {
    const a = layoutBoard(items, 900, 200, GAP, 1)
    const b = layoutBoard(items, 900, 200, GAP, 2)
    assert.notDeepEqual(a, b)
  })

  check('every image is placed exactly once', () => {
    const { placed } = layoutBoard(items, 900, 200, GAP, 3)
    assert.equal(placed.length, items.length)
    assert.equal(new Set(placed.map((p) => p.item.name)).size, items.length)
  })

  check('nothing escapes the canvas or goes negative', () => {
    for (const seed of [1, 2, 3, 99]) {
      for (const p of layoutBoard(items, 900, 200, GAP, seed).placed) {
        assert.ok(p.x >= -0.5, `negative x at seed ${seed}: ${p.x}`)
        assert.ok(p.y >= -0.5, `negative y at seed ${seed}: ${p.y}`)
        assert.ok(p.x + p.width <= 900.5, `overflow at seed ${seed}: ${p.x + p.width}`)
      }
    }
  })

  check('aspect ratios are preserved', () => {
    for (const p of layoutBoard(items, 900, 200, GAP, 4).placed) {
      assert.ok(Math.abs(p.width / p.height - p.item.aspect) < 0.001, p.item.name)
    }
  })

  check('a single image does not stretch across the canvas', () => {
    const { placed } = layoutBoard([item('one.png', 1.5)], 1200, 200, GAP, 1)
    assert.ok(placed[0].height <= 200 * 1.3 + 0.5, `grew to ${placed[0].height}`)
  })
}

// ------------------------------------------------------------------------ fit
console.log('Fitting to the canvas')
{
  const many = Array.from({ length: 40 }, (_, i) => item(`f${i}.png`, 1.5))

  check('shrinks until everything fits', () => {
    const fitted = fitToHeight((h) => layoutRows(many, 1000, h, GAP), 600, 220)
    assert.ok(fitted.height <= 600, `still ${fitted.height} tall`)
    assert.equal(fitted.placed.length, many.length)
  })

  check('a layout that already fits is left alone', () => {
    const few = [item('a.png', 1.5), item('b.png', 1.5)]
    const target = layoutRows(few, 1000, 220, GAP)
    const fitted = fitToHeight((h) => layoutRows(few, 1000, h, GAP), 5000, 220)
    assert.deepEqual(fitted, target)
  })

  check('fits masonry too', () => {
    const fitted = fitToHeight(
      (h) => layoutMasonry(many, 1000, (h / 220) * 260, GAP),
      500,
      220
    )
    assert.ok(fitted.height <= 500, `still ${fitted.height} tall`)
  })

  check('an impossible target still returns every image', () => {
    // 40 images will not fit in 10 pixels at any legible size. The floor holds
    // and nothing is dropped — a gallery that silently loses images would be
    // far worse than one that scrolls.
    const fitted = fitToHeight((h) => layoutRows(many, 1000, h, GAP), 10, 220)
    assert.equal(fitted.placed.length, many.length)
  })
}

// ------------------------------------------------------- copy, cut and paste
//
// The file tree's clipboard, against a real temp directory. These are the
// operations that can lose someone's work, so the cases worth pinning down are
// the destructive ones: a name already in use, and a folder pasted into itself.
console.log('Copying and moving')
{
  const sandbox = path.join(out, 'fs')
  const reset = () => {
    fs.rmSync(sandbox, { recursive: true, force: true })
    fs.mkdirSync(path.join(sandbox, 'src'), { recursive: true })
    fs.mkdirSync(path.join(sandbox, 'dest'), { recursive: true })
    fs.writeFileSync(path.join(sandbox, 'src', 'a.txt'), 'hello')
  }
  const at = (...p) => path.join(sandbox, ...p)
  const acheck = async (name, fn) => {
    reset()
    await fn()
    passed++
    console.log('  ok', name)
  }

  await acheck('a copy lands in the destination and leaves the original', async () => {
    const landed = await copyEntry(at('src', 'a.txt'), at('dest'))
    assert.equal(landed, at('dest', 'a.txt'))
    assert.equal(fs.readFileSync(landed, 'utf8'), 'hello')
    assert.ok(fs.existsSync(at('src', 'a.txt')), 'the original should still be there')
  })

  await acheck('a move takes the original with it', async () => {
    const landed = await moveEntry(at('src', 'a.txt'), at('dest'))
    assert.equal(landed, at('dest', 'a.txt'))
    assert.equal(fs.readFileSync(landed, 'utf8'), 'hello')
    assert.equal(fs.existsSync(at('src', 'a.txt')), false)
  })

  await acheck('a name already in use is suffixed, never overwritten', async () => {
    fs.writeFileSync(at('dest', 'a.txt'), 'do not lose me')
    const landed = await copyEntry(at('src', 'a.txt'), at('dest'))
    assert.equal(landed, at('dest', 'a (2).txt'))
    assert.equal(fs.readFileSync(at('dest', 'a.txt'), 'utf8'), 'do not lose me')
  })

  await acheck('suffixes keep counting up', async () => {
    fs.writeFileSync(at('dest', 'a.txt'), 'x')
    fs.writeFileSync(at('dest', 'a (2).txt'), 'x')
    const landed = await copyEntry(at('src', 'a.txt'), at('dest'))
    assert.equal(landed, at('dest', 'a (3).txt'))
  })

  await acheck('copying into the same folder duplicates rather than failing', async () => {
    // This is how you duplicate a file, and the reason a collision suffixes
    // instead of raising.
    const landed = await copyEntry(at('src', 'a.txt'), at('src'))
    assert.equal(landed, at('src', 'a (2).txt'))
    assert.equal(fs.readFileSync(landed, 'utf8'), 'hello')
  })

  await acheck('a dotfile keeps its whole name', async () => {
    fs.writeFileSync(at('src', '.gitignore'), 'node_modules')
    fs.writeFileSync(at('dest', '.gitignore'), 'other')
    const landed = await copyEntry(at('src', '.gitignore'), at('dest'))
    // Not `. (2)gitignore`: there is no extension here, the dot starts the name.
    assert.equal(landed, at('dest', '.gitignore (2)'))
  })

  await acheck('moving into the folder it is already in changes nothing', async () => {
    const landed = await moveEntry(at('src', 'a.txt'), at('src'))
    assert.equal(landed, at('src', 'a.txt'))
    assert.equal(fs.readdirSync(at('src')).length, 1, 'no phantom copy')
  })

  await acheck('a folder is copied with everything in it', async () => {
    fs.mkdirSync(at('src', 'nested'))
    fs.writeFileSync(at('src', 'nested', 'deep.txt'), 'deep')
    const landed = await copyEntry(at('src'), at('dest'))
    assert.equal(fs.readFileSync(path.join(landed, 'nested', 'deep.txt'), 'utf8'), 'deep')
  })

  await acheck('a folder cannot be copied into itself', async () => {
    // Left unguarded this recurses until the disk fills.
    await assert.rejects(() => copyEntry(at('src'), at('src', 'nested')), /itself/)
  })

  await acheck('a folder cannot be moved into its own subtree', async () => {
    fs.mkdirSync(at('src', 'nested', 'deeper'), { recursive: true })
    await assert.rejects(() => moveEntry(at('src'), at('src', 'nested', 'deeper')), /itself/)
    assert.ok(fs.existsSync(at('src', 'a.txt')), 'the source must be untouched')
  })
}

console.log(`\n${passed} checks passed`)
