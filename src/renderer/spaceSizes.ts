/**
 * The last known size of each project folder, for whoever wants to show one.
 *
 * Filled from the host's cache once at startup and then by every measurement,
 * so the sidebar has a size beside each workspace without measuring anything
 * itself — measuring is seconds of disk reads, and happens only when the space
 * pane is asked to.
 */
import { backend } from '../backend'
import type { SpaceReport } from '../shared/types'

const sizes = new Map<string, SpaceReport>()
const listeners = new Set<() => void>()
let loading: Promise<void> | null = null

/** Trailing separators off, so `~/dev/x/` and `~/dev/x` are one folder. */
export function spaceKey(dir: string): string {
  return dir.length > 1 ? dir.replace(/[\\/]+$/, '') : dir
}

function changed(): void {
  for (const cb of listeners) cb()
}

/** Reads what the host already knows. Safe to call more than once. */
export function loadSpaceSizes(): Promise<void> {
  return (loading ??= backend()
    .space.cached()
    .then((all) => {
      for (const report of Object.values(all ?? {})) sizes.set(spaceKey(report.dir), report)
      changed()
    })
    .catch(() => {}))
}

export function spaceSizeOf(dir: string): SpaceReport | undefined {
  return sizes.get(spaceKey(dir))
}

export async function measureSpace(dir: string): Promise<SpaceReport> {
  const report = await backend().space.measure(dir)
  if (report.error) sizes.delete(spaceKey(dir))
  else sizes.set(spaceKey(dir), report)
  changed()
  return report
}

export function watchSpaceSizes(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/**
 * Folder totals for the file tree, asked of the host a few at a time.
 *
 * A tree with the size column on asks for every folder it draws, and each
 * answer is a walk of that folder. In parallel they only take turns at the
 * disk, so three run and the rest wait — nearest the top first, since rows are
 * drawn in order.
 */
const DIR_LANES = 3
/** Matches the host's own cache, so a redraw inside it asks nothing at all. */
const DIR_FRESH_MS = 60_000
const dirBytes = new Map<string, { bytes: number; at: number }>()
const pending = new Map<string, Promise<number>>()
const waiting: (() => void)[] = []
let lanes = 0

/** The last known total, for drawing a row before the fresh one arrives. */
export function knownDirSize(dir: string): number | undefined {
  return dirBytes.get(spaceKey(dir))?.bytes
}

/** The total, from the cache while it is fresh. */
export function dirSize(dir: string): Promise<number> {
  const key = spaceKey(dir)
  const known = dirBytes.get(key)
  if (known && Date.now() - known.at < DIR_FRESH_MS) return Promise.resolve(known.bytes)
  const inFlight = pending.get(key)
  if (inFlight) return inFlight
  const job = new Promise<void>((go) => {
    if (lanes < DIR_LANES) {
      lanes++
      go()
    } else waiting.push(go)
  })
    .then(() => backend().space.dirSize(key))
    .then((bytes) => {
      dirBytes.set(key, { bytes, at: Date.now() })
      return bytes
    })
    .finally(() => {
      pending.delete(key)
      const next = waiting.shift()
      if (next) next()
      else lanes--
    })
  pending.set(key, job)
  return job
}
