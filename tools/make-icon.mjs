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

  /** Thick anti-aliased line segment, in ink colour. */
  const stroke = (x1, y1, x2, y2, width) => {
    const minX = Math.max(0, Math.floor(Math.min(x1, x2) - width))
    const maxX = Math.min(size - 1, Math.ceil(Math.max(x1, x2) + width))
    const minY = Math.max(0, Math.floor(Math.min(y1, y2) - width))
    const maxY = Math.min(size - 1, Math.ceil(Math.max(y1, y2) + width))
    const vx = x2 - x1
    const vy = y2 - y1
    const lenSq = vx * vx + vy * vy

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const wx = x + 0.5 - x1
        const wy = y + 0.5 - y1
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq))
        const dist = Math.hypot(wx - vx * t, wy - vy * t)
        const coverage = Math.min(1, Math.max(0, width / 2 - dist + 0.5))
        if (coverage > 0) blend((y * size + x) * 4, INK, coverage)
      }
    }
  }

  // The mark itself: a chevron pointing left. Two strokes meeting at a point,
  // which is still one shape — the apex is the only detail in it, and a single
  // corner is what survives 16px when a glyph would not.
  const reach = small ? 0.155 : 0.135
  const apexX = size * (0.5 - reach * 1.05)
  const armX = size * (0.5 + reach * 1.05)
  const midY = size * 0.5
  const armY = size * reach * 1.75
  const width = Math.max(1.5, size * (small ? 0.145 : 0.115))
  stroke(armX, midY - armY, apexX, midY, width)
  stroke(apexX, midY, armX, midY + armY, width)
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
