/**
 * Generates the app icon for every runtime, with no image-library dependency.
 *
 * A black chevron on a white rounded square: two strokes to one point, so it
 * survives being scaled down to a 16px taskbar button, where anything more
 * detailed turns to mush. The mark is drawn from scratch at each size rather
 * than resampled from one big bitmap — a downscaled diagonal goes muddy, a
 * redrawn one stays crisp.
 *
 * PNG and ICO are encoded by hand (zlib + CRC32) so the repo needs no binary
 * asset checked in and no extra npm dependency.
 *
 * Outputs:
 *   src-tauri/icon-source.png         the master `tauri icon` expands into the
 *                                     Tauri/iOS/Android set
 *   src-tauri/icons/icon.ico          the Tauri .exe, and the packaged Electron
 *                                     .exe (package.json `build.win.icon`)
 *
 * After regenerating these, **touch `src-tauri/tauri.conf.json` before building
 * Tauri**. `tauri-build` compiles the icon into a Windows resource from its
 * build script, and cargo does not rerun a build script because a file it never
 * declared changed — so a rebuilt exe keeps the icon it was first built with,
 * silently, however many times you rebuild it.
 *
 * Run `npm run icon`, which sequences this against `tauri icon`: that command
 * derives everything by resampling the 1024px master, so it is run *between*
 * the two passes here and the `--ico` pass puts the redrawn .ico files back
 * over the resampled ones. Those two files are the taskbar icon on Windows, and
 * a downscaled diagonal is visibly softer than one drawn at 16px.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const TILE = hex('#ffffff')
/** Keeps the tile's silhouette from vanishing against a light background. */
const EDGE = hex('#d8d8d8')
const INK = hex('#101010')

// ------------------------------------------------------------------- the mark

/**
 * The mark, in units where 1 is the chevron's own reach.
 *
 * Three blades opened from one pivot: the chevron's two arms, and a third
 * straight up that closes the letter. Written down in its own coordinates
 * rather than in pixels so that every size, and the SVG, are the same drawing
 * scaled — there is one description here and nothing to keep in step with it.
 */
const STROKE = 0.852
/** Blades narrow towards the tip, the way an opened blade does. */
const TIP = 0.55
const BLADES = [
  [2.1, -1.75], // arm, up and right
  [2.1, 1.75], // arm, down and right
  [0, -1.96], // the third blade, straight up
]
/** The rivet the blades turn on, and the hole through it. */
const RIVET = 0.72
const BORE = 0.3
/** Wider at small sizes, or the hole closes before the icon is even small. */
const BORE_SMALL = 0.42

/**
 * How much of the icon the mark's bounding box fills.
 *
 * Small sizes get proportionally more, which is the same trade the tile makes
 * with its own margin: at 16px a mark drawn to the large-icon proportions is a
 * few dark pixels adrift in whitespace, and that is the size that has to read
 * the hardest.
 */
const FILL = 0.62
const FILL_SMALL = 0.71

/**
 * The mark's bounding box, in mark units.
 *
 * Computed rather than eyeballed, and it is what gets centred — not the pivot.
 * There is a blade going up and none going down, so the ink is not symmetric
 * about the pivot, and centring the pivot leaves the mark visibly high.
 */
const BOX = (() => {
  const cap = (TIP * STROKE) / 2
  const half = STROKE / 2
  let xmin = -RIVET * STROKE
  let xmax = RIVET * STROKE
  let ymin = -RIVET * STROKE
  let ymax = RIVET * STROKE
  for (const [x, y] of BLADES) {
    xmin = Math.min(xmin, x - cap, -half)
    xmax = Math.max(xmax, x + cap, half)
    ymin = Math.min(ymin, y - cap, -half)
    ymax = Math.max(ymax, y + cap, half)
  }
  return { xmin, xmax, ymin, ymax, w: xmax - xmin, h: ymax - ymin,
           cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2 }
})()

/** Where the pivot lands, and how big a mark unit is, for an icon of `size`. */
function placeMark(size, small) {
  const unit = ((small ? FILL_SMALL : FILL) * size) / Math.max(BOX.w, BOX.h)
  return { unit, x: size / 2 - BOX.cx * unit, y: size / 2 - BOX.cy * unit }
}

/** Signed distance to a rounded rectangle, used for anti-aliased edges. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** Draws the mark at `size`, returning straight RGBA pixels. */
function render(size) {
  const px = new Uint8ClampedArray(size * size * 4)

  const blend = (i, rgb, alpha) => {
    if (alpha <= 0) return
    const a = Math.min(1, alpha)
    px[i] = px[i] * (1 - a) + rgb[0] * a
    px[i + 1] = px[i + 1] * (1 - a) + rgb[1] * a
    px[i + 2] = px[i + 2] * (1 - a) + rgb[2] * a
    px[i + 3] = Math.max(px[i + 3], a * 255)
  }

  // Small sizes get less padding, a tighter corner and a fatter stroke. Keeping
  // the large-icon proportions at 16px leaves a mark barely two pixels wide
  // floating in whitespace, which is the size that has to read the hardest.
  const small = size <= 32
  const margin = size * (small ? 0.03 : 0.07)
  const half = size / 2 - margin
  const radius = size * (small ? 0.18 : 0.22)
  // Never thinner than a pixel, or the rim disappears entirely at 16px.
  const edgeWidth = Math.max(1, size * 0.012)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const d = roundedRectDistance(x + 0.5, y + 0.5, size / 2, size / 2, half, half, radius)
      // 1px feather across the boundary gives a clean edge at every scale.
      const coverage = Math.min(1, Math.max(0, 0.5 - d))
      if (coverage <= 0) continue
      blend(i, TILE, coverage)
      // The rim is the band just inside the outline, drawn over the white.
      const rim = Math.min(1, Math.max(0, 0.5 - Math.abs(d + edgeWidth / 2) + edgeWidth / 2))
      blend(i, EDGE, rim * coverage)
    }
  }

  /**
   * A blade: a thick anti-aliased segment with round ends, narrowing to `w2`.
   *
   * Round because the coverage is distance to the segment, which is a capsule.
   * A tapering one ends in a small dome rather than a point, which is what a
   * rounded blade actually looks like and what stops the tip disappearing when
   * the icon is 16 pixels across.
   */
  const stroke = (x1, y1, x2, y2, w1, w2 = w1, rgb = INK) => {
    const pad = Math.max(w1, w2) + 1
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - pad))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + pad))
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - pad))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + pad))
    const vx = x2 - x1
    const vy = y2 - y1
    const lenSq = vx * vx + vy * vy

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const wx = x + 0.5 - x1
        const wy = y + 0.5 - y1
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq))
        const dist = Math.hypot(wx - vx * t, wy - vy * t)
        const width = w1 + (w2 - w1) * t
        const coverage = Math.min(1, Math.max(0, width / 2 - dist + 0.5))
        if (coverage > 0) blend((y * size + x) * 4, rgb, coverage)
      }
    }
  }

  /** Anti-aliased filled circle. The rivet, and the hole punched through it. */
  const disc = (cx, cy, r, rgb) => {
    for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(size - 1, Math.ceil(cy + r + 1)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(size - 1, Math.ceil(cx + r + 1)); x++) {
        const coverage = Math.min(1, Math.max(0, r - Math.hypot(x + 0.5 - cx, y + 0.5 - cy) + 0.5))
        if (coverage > 0) blend((y * size + x) * 4, rgb, coverage)
      }
    }
  }

  // The mark: three blades opened from a rivet. The two that point right are
  // the chevron this app has always had; the third closes it into a K.
  const { unit, x: pivotX, y: pivotY } = placeMark(size, small)
  const width = Math.max(1.5, STROKE * unit)

  for (const [bx, by] of BLADES) {
    const ex = pivotX + bx * unit
    const ey = pivotY + by * unit
    // The box was measured to the outside of the cap, so the blade is drawn to
    // a point pulled back by the tip radius rather than to the box edge.
    const len = Math.hypot(ex - pivotX, ey - pivotY) || 1
    const pull = (TIP * width) / 2
    stroke(pivotX, pivotY, ex - ((ex - pivotX) / len) * pull, ey - ((ey - pivotY) / len) * pull,
           width, TIP * width)
  }

  disc(pivotX, pivotY, RIVET * width, INK)
  // A hole too small to read as a hole is a smudge, and a solid rivet is the
  // better drawing at that point. Below about a pixel of radius it is dropped.
  const bore = (small ? BORE_SMALL : BORE) * width
  if (bore >= 1) disc(pivotX, pivotY, bore, TILE)
  return px
}

// ------------------------------------------------------------------ PNG encode

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA

  // Each scanline is prefixed with filter type 0 (none).
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const offset = y * (size * 4 + 1)
    rows[offset] = 0
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(rows, offset + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------------ ICO encode

/**
 * Encodes one size as a 32-bit BMP entry: the DIB header, the pixels bottom-up
 * as BGRA, then the 1bpp AND mask.
 *
 * The mask is redundant next to an alpha channel and every modern consumer
 * ignores it, but parts of the shell still read it, and an entry without one is
 * malformed. Rows in it are padded to four bytes, as in any DIB.
 */
function encodeBmp(px, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // header size
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR and AND stacked
  header.writeUInt16LE(1, 12) // planes
  header.writeUInt16LE(32, 14) // bits per pixel
  header.writeUInt32LE(0, 16) // BI_RGB

  const xor = Buffer.alloc(size * size * 4)
  const maskStride = Math.ceil(size / 8 / 4) * 4
  const and = Buffer.alloc(maskStride * size)

  for (let y = 0; y < size; y++) {
    // Bottom-up: the last row of the image is the first row of the file.
    const row = size - 1 - y
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = (row * size + x) * 4
      xor[to] = px[from + 2] // B
      xor[to + 1] = px[from + 1] // G
      xor[to + 2] = px[from] // R
      xor[to + 3] = px[from + 3] // A
      // A set bit means "leave the screen alone", i.e. transparent.
      if (px[from + 3] < 128) and[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }

  header.writeUInt32LE(xor.length + and.length, 20)
  return Buffer.concat([header, xor, and])
}

/**
 * Packs one image per size into an .ico.
 *
 * Only the 256px entry is PNG-compressed. Windows has read PNG entries since
 * Vista, but only reliably at 256 — that is the size the format was introduced
 * for, and it is what every other icon compiler emits. Smaller entries stored
 * as PNG are what several shell code paths quietly refuse to load, and a shell
 * that cannot load an icon falls back to the generic executable one.
 */
function encodeIco(sizes) {
  const images = sizes.map((size) =>
    size >= 256 ? encodePng(render(size), size) : encodeBmp(render(size), size)
  )

  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(sizes.length, 4)

  const directory = Buffer.alloc(16 * sizes.length)
  let offset = header.length + directory.length

  sizes.forEach((size, index) => {
    const at = index * 16
    // 256 is stored as 0 — the field is a single byte.
    directory[at] = size >= 256 ? 0 : size
    directory[at + 1] = size >= 256 ? 0 : size
    directory[at + 2] = 0 // palette size, 0 for truecolour
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(images[index].length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += images[index].length
  })

  return Buffer.concat([header, directory, ...images])
}

// ----------------------------------------------------------------------- ICNS

/**
 * Packs one PNG per size into an .icns, for the macOS bundle.
 *
 * The container is as simple as it looks: a magic word, the total length, and
 * then a run of typed chunks whose own length includes their eight-byte
 * header. Every type here is a PNG one — macOS has read those since 10.7, and
 * the raw ARGB types that came before need their own greyscale mask chunk
 * alongside them, which is a second encoder for machines nobody is running.
 *
 * The 16px slot has no PNG type of its own. `ic11` is the 16@2x one, which is
 * what a Retina Finder actually asks for; a non-Retina Mac downscales from 32
 * and looks no worse than it would have.
 */
const ICNS_TYPES = [
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
]

function encodeIcns() {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = encodePng(render(size), size)
    const header = Buffer.alloc(8)
    header.write(type, 0, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([header, png])
  })

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([header, body])
}

// ------------------------------------------------------------------------ SVG

/**
 * One blade as a filled outline.
 *
 * A stroke cannot be used: SVG strokes are one width end to end and these
 * narrow towards the tip. So the shape is traced instead — the convex hull of
 * the two end circles, which is two straight tangents and two arcs, and is
 * exact rather than an approximation of the raster.
 */
function bladePath(px, py, ex, ey, r1, r2) {
  const dx = ex - px
  const dy = ey - py
  const d = Math.hypot(dx, dy)
  const n = (v) => Number(v.toFixed(3))

  // One circle inside the other: the hull is just the larger circle.
  if (d <= Math.abs(r1 - r2)) {
    const r = Math.max(r1, r2)
    const [cx, cy] = r1 >= r2 ? [px, py] : [ex, ey]
    return `M ${n(cx - r)} ${n(cy)} a ${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0 a ${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0 Z`
  }

  const a = Math.atan2(dy, dx)
  const b = Math.acos((r1 - r2) / d)
  const at = (cx, cy, r, angle) => [n(cx + r * Math.cos(angle)), n(cy + r * Math.sin(angle))]
  const p1 = at(px, py, r1, a + b)
  const p2 = at(ex, ey, r2, a + b)
  const p3 = at(ex, ey, r2, a - b)
  const p4 = at(px, py, r1, a - b)

  // Both arcs turn the same way round the outline. The tip is the short way
  // round the small circle; the back of the rivet is the long way round the
  // large one, which is the only place the large-arc flag is set.
  return (
    `M ${p1[0]} ${p1[1]} L ${p2[0]} ${p2[1]}` +
    ` A ${n(r2)} ${n(r2)} 0 0 0 ${p3[0]} ${p3[1]}` +
    ` L ${p4[0]} ${p4[1]}` +
    ` A ${n(r1)} ${n(r1)} 0 1 0 ${p1[0]} ${p1[1]} Z`
  )
}

/**
 * The icon as an editable SVG.
 *
 * Deliberately separate shapes rather than one merged path: this file is the
 * one an editor opens, and a mark you can take a blade off is worth more there
 * than a single outline you would have to cut apart first. The raster above is
 * the same drawing, from the same numbers.
 *
 * The bore is a white disc over the rivet rather than a hole cut through it,
 * for the same reason — two circles are editable where an even-odd compound
 * path is a thing you have to understand first. On the white tile the two are
 * identical; over anything else, union the blades and set `fill-rule` to
 * `evenodd` to make it a real hole.
 */
function markSvg(size) {
  const margin = size * 0.07
  const half = size / 2 - margin
  const radius = size * 0.22
  const edgeWidth = size * 0.012
  const { unit, x: pivotX, y: pivotY } = placeMark(size, false)
  const width = STROKE * unit
  const n = (v) => Number(v.toFixed(3))

  const blades = BLADES.map(([bx, by]) => {
    const ex = pivotX + bx * unit
    const ey = pivotY + by * unit
    const len = Math.hypot(ex - pivotX, ey - pivotY) || 1
    const pull = (TIP * width) / 2
    return bladePath(pivotX, pivotY, ex - ((ex - pivotX) / len) * pull,
                     ey - ((ey - pivotY) / len) * pull, width / 2, (TIP * width) / 2)
  })

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by tools/make-icon.mjs. The raster icons come from the same
     numbers; edit here and they will not follow, so change the constants in
     that file if a change is meant to reach the app. -->
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g id="tile">
    <rect x="${n(size / 2 - half)}" y="${n(size / 2 - half)}" width="${n(half * 2)}" height="${n(half * 2)}"
          rx="${n(radius)}" ry="${n(radius)}" fill="#ffffff" stroke="#d8d8d8" stroke-width="${n(edgeWidth)}"/>
  </g>
  <g id="mark" fill="#101010">
${blades.map((d, i) => `    <path id="blade-${i + 1}" d="${d}"/>`).join('\n')}
    <circle id="rivet" cx="${n(pivotX)}" cy="${n(pivotY)}" r="${n(RIVET * width)}"/>
  </g>
  <circle id="bore" cx="${n(pivotX)}" cy="${n(pivotY)}" r="${n(BORE * width)}" fill="#ffffff"/>
</svg>
`
}

// ----------------------------------------------------------------------- write

function write(relative, data) {
  const out = path.join(root, relative)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, data)
  console.log(`[icon] wrote ${relative} (${(data.length / 1024).toFixed(1)} kB)`)
}

// Sizes Windows picks between for the taskbar, Alt+Tab, Explorer and the
// window corner, at 100% through 250% scaling.
//
// Largest first. Windows itself looks up the best match for the size it wants
// and ignores the order, but Tauri does not: tauri-codegen decodes
// `entries()[0]` and hands that one bitmap to the window as its only icon, so a
// 16px-first directory left the running app with a 16px icon stretched across
// the taskbar. Everything else is unaffected by the order.
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16]

if (!process.argv.includes('--ico')) {
  const master = encodePng(render(1024), 1024)
  write(path.join('src-tauri', 'icon-source.png'), master)
}

const ico = encodeIco(ICO_SIZES)
write(path.join('packaging', 'icons', 'icon.ico'), ico)

// The Tauri host is parked, but its icon is not regenerated by anything else,
// and a parked host that comes back wearing last year's mark is a bug nobody
// would think to look for.
write(path.join('src-tauri', 'icons', 'icon.ico'), ico)

// macOS, and the loose PNGs electron-builder picks up for Linux. These are the
// bundle's own icons: without them the Mac app and the AppImage keep whatever
// was generated last time, which is how a rebranded app ships half rebranded.
write(path.join('packaging', 'icons', 'icon.icns'), encodeIcns())
for (const [name, size] of [
  ['icon.png', 512],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['32x32.png', 32],
]) {
  write(path.join('packaging', 'icons', name), encodePng(render(size), size))
}

// The editable copy. Written on every run, including `--ico`, because it costs
// nothing and a stale one is worse than none.
write(path.join('packaging', 'icons', 'icon.svg'), Buffer.from(markSvg(512), 'utf8'))
