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
