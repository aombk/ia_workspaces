/**
 * How big things are, said the same way everywhere.
 *
 * A size is the one fact about a change that git itself never volunteers until
 * it is too late to act on: GitHub warns about a file over 50 MB only once the
 * push is underway, and refuses one over 100 MB only after the whole upload has
 * been sent. By then the file is inside a save, and getting it out means
 * rewriting that save. Shown while picking, the same fact costs a single untick.
 */
import type { ChangedFile } from './types'

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB']

/**
 * Bytes as a person reads them: `812 B`, `4.2 KB`, `37 MB`.
 *
 * One decimal below ten and none above, so a column of these stays narrow and
 * the digits that change are the ones that matter. Powers of 1024 with the
 * short names, which is what Finder, Explorer and git's own progress all do.
 */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`
}

/** Where GitHub starts warning about a single file. */
export const LARGE_FILE_BYTES = 50 * 1024 * 1024

/** Where GitHub refuses a single file outright, and the push with it. */
export const REFUSED_FILE_BYTES = 100 * 1024 * 1024

/**
 * How big a file is on the side of the list it is being shown on.
 *
 * The two sides can disagree, and that is the point of having both: pick a
 * file, then keep editing it, and the save will hold the version you picked —
 * so the "staged" row shows what is in the index, and the "not staged" row the
 * file as it is on disk now.
 */
export function sizeOn(file: ChangedFile, side: 'picked' | 'changed'): number | undefined {
  if (side === 'picked') return file.pickedSize ?? file.size
  return file.size
}

/**
 * A group's files in the chosen order.
 *
 * By name is git's own order, which is already by path, so it is left exactly
 * as git gave it. By size is biggest first, using the size for this side of the
 * list — a picked file is ranked by what the save will hold. Files with no known
 * size go last rather than first, since "unknown" is not "large", and ties fall
 * back to the path so the order does not shuffle between refreshes.
 */
export function orderFiles(
  files: ChangedFile[],
  side: 'picked' | 'changed',
  order: 'name' | 'size'
): ChangedFile[] {
  if (order !== 'size') return files
  return [...files].sort((a, b) => {
    const left = sizeOn(a, side)
    const right = sizeOn(b, side)
    if (left === undefined && right !== undefined) return 1
    if (right === undefined && left !== undefined) return -1
    if (left !== undefined && right !== undefined && left !== right) return right - left
    return a.repoPath < b.repoPath ? -1 : a.repoPath > b.repoPath ? 1 : 0
  })
}

/** A group's total, and whether any of it is only a lower bound. */
export function totalOf(
  files: readonly ChangedFile[],
  side: 'picked' | 'changed'
): { bytes: number; known: number; atLeast: boolean } {
  let bytes = 0
  let known = 0
  let atLeast = false
  for (const file of files) {
    const size = sizeOn(file, side)
    if (size === undefined) continue
    bytes += size
    known++
    if (file.sizeAtLeast) atLeast = true
  }
  return { bytes, known, atLeast }
}

/**
 * Git's progress quantity — `1.20 MiB`, `512 bytes`, `3.4 KiB` — in bytes.
 *
 * Git prints binary units with binary names; the screen uses the short ones.
 * Same numbers, so this only has to read them. Anything it does not recognise
 * is undefined rather than zero, so a missing figure is never shown as nothing
 * having been sent.
 */
export function parseGitQuantity(amount: string, unit: string): number | undefined {
  const value = Number(amount)
  if (!Number.isFinite(value)) return undefined
  const scale: Record<string, number> = {
    bytes: 1,
    byte: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  }
  const factor = scale[unit.toLowerCase()]
  return factor === undefined ? undefined : value * factor
}
