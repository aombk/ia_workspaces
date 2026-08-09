/**
 * Which files are images, how a set of them is ordered, and where each one goes.
 *
 * All of it pure, and all of it here rather than in the pane, because this is
 * the part with arithmetic in it: a row that overflows its container by a
 * fraction of a pixel is a bug you cannot see in a screenshot but can see in a
 * test. The pane does DOM and nothing else.
 *
 * Layout works in aspect ratios rather than pixels. The renderer does not know
 * how big an image is until the decoder has read its header, so every function
 * here takes `aspect` (width ÷ height) and returns geometry — which means the
 * same maths runs before any image has loaded, using a placeholder ratio, and
 * again as the real ones arrive.
 */

/**
 * Extensions shown as images.
 *
 * Decided by what Chromium can decode, since that is what actually renders
 * them: no decoder means a broken-image glyph, which is worse than the file not
 * appearing at all. Notably absent are TIFF, PSD and RAW — real image formats
 * that a browser engine will not open.
 *
 * SVG is included and is the one that needs a word. It reaches the page through
 * an `<img>`, which is the safe way: scripts, foreign objects and external
 * references are all inert in that context. It would not be safe as inline
 * markup, and nothing here ever does that.
 */
import { extensionOf } from './editorModes'

export const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'jfif',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'svg',
] as const

const IMAGE_RE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i')

export function isImagePath(path: string): boolean {
  return IMAGE_RE.test(path)
}

/**
 * The scheme images are served over.
 *
 * Here rather than beside the handler in `main/imageProtocol.ts` because three
 * processes need it and only one of them may import Electron's `protocol`: main
 * registers it, preload builds URLs with it, and the renderer's CSP names it.
 */
export const IMAGE_SCHEME = 'iaw-img'

const URL_PREFIX = `${IMAGE_SCHEME}://f/`

/**
 * Encodes a path into an image URL.
 *
 * base64url, and a single path segment, because the alternative is a decade of
 * escaping bugs: Windows paths carry backslashes, drive letters look like URL
 * schemes, and real filenames contain `#`, `?`, `%` and every kind of unicode.
 * Encoding the whole path once means the URL parser never sees any of it.
 *
 * `btoa` is not used — it throws on any code point above U+00FF, which is most
 * of the filenames this has to survive.
 */
export function encodeImagePath(target: string): string {
  const bytes = new TextEncoder().encode(target)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return URL_PREFIX + b64
}

/** The inverse, for the handler. Null for anything that is not one of ours. */
export function decodeImagePath(url: string): string | null {
  if (!url.startsWith(URL_PREFIX)) return null
  const b64 = url.slice(URL_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/')
  try {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes) || null
  } catch {
    return null
  }
}

/**
 * How a gallery is ordered, how it is arranged, and how the tree is ordered.
 *
 * Each union has its values as a runtime array beside it, because a persisted
 * document is not to be trusted: a hand-edited or newer-build workspace file can
 * carry anything, and the loader checks membership rather than casting.
 */
export const IMAGE_SORTS = ['name', 'size', 'modified', 'random'] as const
export type ImageSort = (typeof IMAGE_SORTS)[number]

export const IMAGE_LAYOUTS = ['rows', 'masonry', 'board'] as const
export type ImageLayout = (typeof IMAGE_LAYOUTS)[number]

/**
 * How an image is resampled when it is not shown at its own size.
 *
 * `smooth` is what a browser does by default and what a photograph wants.
 * `pixel` is nearest-neighbour, and it is not a stylistic preference: blowing
 * up a 32×32 sprite with bilinear filtering turns every hard edge into a blur,
 * which is exactly the information someone working on pixel art is zooming in
 * to look at.
 */
export const IMAGE_FILTERS = ['smooth', 'pixel'] as const
export type ImageFilter = (typeof IMAGE_FILTERS)[number]

/**
 * Folders come first whatever this says.
 *
 * `extension` is "group this folder by type": every `.ts` together, every
 * `.png` together, in alphabetical order of the suffix. Files with none lead,
 * since an empty string sorts first, which puts `LICENSE` and `Makefile` at the
 * top of the file block rather than scattered through it.
 */
export const TREE_SORTS = ['name', 'size', 'modified', 'extension'] as const
export type TreeSort = (typeof TREE_SORTS)[number]

/** The little each layout needs to know about a file. */
export interface ImageItem {
  path: string
  name: string
  size: number
  modified: number
  /**
   * Width ÷ height, or 0 while unknown.
   *
   * Zero rather than a guess of 1, so a caller can tell "square" from "not
   * measured yet" — the difference between an image that has loaded and one
   * that has not, which is exactly what decides whether a layout is final.
   */
  aspect: number
}

/**
 * A deterministic RNG, so "random" survives a re-render.
 *
 * The gallery re-lays out on every app render — a theme change, a pane focus,
 * anything. With `Math.random()` the shuffle would be different each time and
 * the images would jump under the pointer. The order is instead a pure function
 * of a seed the pane holds, so it is stable until something deliberately
 * reshuffles it.
 *
 * mulberry32: small, fast, and good enough for arranging pictures.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Orders a gallery.
 *
 * `desc` is ignored for `random`, which has no direction to reverse — reversing
 * a shuffle is just a different shuffle, and offering it as a control that
 * appears to do nothing meaningful is worse than not offering it.
 *
 * Name comparison is locale-aware and numeric, so `img2` sorts before `img10`
 * rather than after it. That ordering is the whole reason people name files
 * that way.
 */
export function sortImages(
  items: readonly ImageItem[],
  sort: ImageSort,
  desc: boolean,
  seed: number
): ImageItem[] {
  const out = [...items]
  if (sort === 'random') {
    // Fisher-Yates, seeded. Sorting by a random key would be biased and, worse,
    // unstable under a comparison sort.
    const rand = seededRandom(seed)
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  const compare =
    sort === 'size'
      ? (a: ImageItem, b: ImageItem) => a.size - b.size
      : sort === 'modified'
        ? (a: ImageItem, b: ImageItem) => a.modified - b.modified
        : (a: ImageItem, b: ImageItem) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

  // Ties broken by name, so two files of identical size keep a stable order
  // rather than depending on what the filesystem happened to return.
  out.sort((a, b) => {
    const primary = compare(a, b)
    if (primary !== 0) return desc ? -primary : primary
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  return out
}

/** Orders a directory listing for the file tree. Folders always lead. */
export function sortEntries<T extends { name: string; isDir: boolean; size: number; modified: number }>(
  entries: readonly T[],
  sort: TreeSort,
  desc: boolean
): T[] {
  const byName = (a: T, b: T) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

  return [...entries].sort((a, b) => {
    // Folders first, always, and unaffected by `desc`. Reversing the sort to
    // put files above folders is not something anyone means by "descending",
    // and it makes ".." and the folder block jump around.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1

    // A folder's size is meaningless here — `readDirectory` reports the
    // directory entry, not what is beneath it — so sorting folders by it would
    // be sorting by noise. They fall back to name.
    if (sort === 'size' && !a.isDir) {
      const d = a.size - b.size
      if (d !== 0) return desc ? -d : d
      return byName(a, b)
    }
    if (sort === 'modified') {
      const d = a.modified - b.modified
      if (d !== 0) return desc ? -d : d
      return byName(a, b)
    }
    // A folder has no type, so folders fall through to name — the same reason
    // size leaves them alone. `extensionOf` is the app's one definition of a
    // file's suffix, shared with the editor's mode-by-extension rule, so "type"
    // means the same thing in the tree as it does on a tab.
    if (sort === 'extension' && !a.isDir) {
      const d = extensionOf(a.name).localeCompare(extensionOf(b.name))
      if (d !== 0) return desc ? -d : d
      return byName(a, b)
    }
    const d = byName(a, b)
    return desc ? -d : d
  })
}

/** A placed image, in pixels, relative to the top-left of the canvas. */
export interface Placed {
  item: ImageItem
  x: number
  y: number
  width: number
  height: number
}

export interface Layout {
  placed: Placed[]
  /** Total height the content occupies, for the scroll container. */
  height: number
}

/**
 * The ratio used for an image whose header has not been read yet.
 *
 * 3:2 rather than 1:1 — most photographs are landscape, so the layout settles
 * with less movement as the real ratios arrive.
 */
const UNKNOWN_ASPECT = 1.5

function aspectOf(item: ImageItem): number {
  return item.aspect > 0 ? item.aspect : UNKNOWN_ASPECT
}

/**
 * Justified rows: every row spans the full width, nothing is cropped.
 *
 * The row is filled greedily at a target height, then the height is solved
 * exactly for the width available — which is what makes the right edge straight
 * without cropping anything. Because the images keep their true ratios, a row
 * of wide panoramas comes out short and a row of portraits comes out tall, and
 * that variation is the point: it is the shape of the pictures, not a grid
 * imposed on them.
 */
export function layoutRows(
  items: readonly ImageItem[],
  width: number,
  targetHeight: number,
  gap: number
): Layout {
  if (items.length === 0 || width <= 0) return { placed: [], height: 0 }

  const placed: Placed[] = []
  let y = 0
  let row: ImageItem[] = []
  let ratioSum = 0

  const flush = (isLast: boolean): void => {
    if (row.length === 0) return
    const available = width - gap * (row.length - 1)
    let height = available / ratioSum

    // The last row is not stretched to fill: with one wide image left over,
    // solving for the full width would blow it up to several times the height
    // of every row above it. It keeps the target height instead — unless that
    // would make it *taller* than solving, which happens when the row is
    // already full.
    if (isLast && height > targetHeight) height = targetHeight

    let x = 0
    for (const item of row) {
      const w = aspectOf(item) * height
      placed.push({ item, x, y, width: w, height })
      x += w + gap
    }
    y += height + gap
    row = []
    ratioSum = 0
  }

  for (const item of items) {
    row.push(item)
    ratioSum += aspectOf(item)
    // Full when the row at target height would overflow. Checked after adding,
    // so the image that causes the overflow is the one that closes the row and
    // the solve shrinks it to fit rather than leaving a gap.
    if (ratioSum * targetHeight + gap * (row.length - 1) >= width) flush(false)
  }
  flush(true)

  return { placed, height: Math.max(0, y - gap) }
}

/**
 * Masonry: fixed-width columns, each image its natural height.
 *
 * Every image goes to whichever column is currently shortest, which is what
 * keeps the bottom edge roughly level. Reading order runs down a column rather
 * than across the page — the trade for never scaling a row up or down.
 */
export function layoutMasonry(
  items: readonly ImageItem[],
  width: number,
  targetColumnWidth: number,
  gap: number
): Layout {
  if (items.length === 0 || width <= 0) return { placed: [], height: 0 }

  const columns = Math.max(1, Math.round((width + gap) / (targetColumnWidth + gap)))
  const columnWidth = (width - gap * (columns - 1)) / columns
  const heights = new Array<number>(columns).fill(0)
  const placed: Placed[] = []

  for (const item of items) {
    let shortest = 0
    for (let i = 1; i < columns; i++) if (heights[i] < heights[shortest]) shortest = i
    const height = columnWidth / aspectOf(item)
    placed.push({
      item,
      x: shortest * (columnWidth + gap),
      y: heights[shortest],
      width: columnWidth,
      height,
    })
    heights[shortest] += height + gap
  }

  return { placed, height: Math.max(0, Math.max(...heights) - gap) }
}

/**
 * The board's automatic arrangement: shelves of randomly varied height.
 *
 * This is the one that is trying to look scattered rather than tidy. It packs
 * in shelves like `layoutRows`, but each shelf gets its own height drawn from a
 * range and each image a small vertical jitter, so the result fills the canvas
 * without reading as a grid. Seeded, so it holds still until you shuffle it.
 *
 * Nothing overlaps. A pile of overlapping images is easy to generate and
 * miserable to use, and the board lets you drag them into a pile yourself if
 * that is what you want.
 */
export function layoutBoard(
  items: readonly ImageItem[],
  width: number,
  targetHeight: number,
  gap: number,
  seed: number
): Layout {
  if (items.length === 0 || width <= 0) return { placed: [], height: 0 }

  const rand = seededRandom(seed)
  const placed: Placed[] = []
  let y = 0
  let index = 0

  while (index < items.length) {
    // Each shelf between 70% and 130% of target, so sizes vary run to run but
    // no image ends up unreadably small or hogging the canvas.
    const shelfHeight = targetHeight * (0.7 + rand() * 0.6)
    const row: ImageItem[] = []
    let ratioSum = 0

    while (index < items.length) {
      const item = items[index]
      const next = ratioSum + aspectOf(item)
      if (row.length > 0 && next * shelfHeight + gap * row.length >= width) break
      row.push(item)
      ratioSum = next
      index++
    }

    const available = width - gap * (row.length - 1)
    const solved = available / ratioSum
    // A shelf that could not be filled keeps its drawn height rather than being
    // stretched across the whole canvas — the last one, usually.
    const height = Math.min(solved, shelfHeight)
    const used = ratioSum * height + gap * (row.length - 1)
    // Left-over width becomes a random indent, which is most of what stops the
    // left edge reading as a column.
    let x = (width - used) * rand()
    let tallest = 0

    for (const item of row) {
      const w = aspectOf(item) * height
      const jitter = (rand() - 0.5) * gap * 2
      placed.push({ item, x, y: y + Math.max(0, jitter), width: w, height })
      x += w + gap
      tallest = Math.max(tallest, height + Math.max(0, jitter))
    }
    y += tallest + gap
  }

  return { placed, height: Math.max(0, y - gap) }
}

/**
 * Scales a layout so all of it fits a given height.
 *
 * The "fit" toggle. Solved by search rather than algebraically: row packing is
 * a step function of the target height — a row breaks or it does not — so there
 * is no closed form, and one extra image slipping onto a shelf changes the
 * total by more than any smooth adjustment would predict.
 *
 * Twenty iterations of bisection lands within a pixel on any real canvas, and
 * each one is arithmetic over an array that is already in memory.
 */
export function fitToHeight(
  build: (targetHeight: number) => Layout,
  maxHeight: number,
  targetHeight: number
): Layout {
  const initial = build(targetHeight)
  if (initial.height <= maxHeight || maxHeight <= 0) return initial

  let low = 8
  let high = targetHeight
  let best = build(low)

  for (let i = 0; i < 20; i++) {
    const mid = (low + high) / 2
    const candidate = build(mid)
    if (candidate.height <= maxHeight) {
      best = candidate
      low = mid
    } else {
      high = mid
    }
  }
  return best
}
