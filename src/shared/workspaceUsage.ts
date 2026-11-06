/**
 * The orders the workspace list can be sorted in, and how much each workspace
 * is used, which is the one of them with judgement in it.
 *
 * Pure, so it can be tested without an app: the renderer reads the time log and
 * measures the folders, and asks this what the order should be.
 *
 * ## Every order keeps the nesting
 *
 * By name, by size or by use, a workspace is only ever sorted among its
 * siblings. `manual` is the order you dragged, which is also what is kept
 * underneath the other three for when you go back to it.
 *
 * ## Time spent, fading
 *
 * Not "last opened goes to the top". That reorders the list on every switch,
 * which is exactly the list somebody who switches a lot cannot find anything
 * in. What is counted instead is the time you actually spent in each workspace,
 * as the time log already records it (`main/timeLog.ts`: the window focused and
 * that workspace on screen) — so the order has a year of history behind it the
 * day it is turned on. Older time counts for less, halving every so many days
 * (a setting; `HALF_LIFE_DAYS` by default): a project you lived in last month
 * drifts down over a few weeks rather than staying up for good, and one you
 * dipped into once this morning does not outrank one you have spent the week
 * in. The log knows a project by its folder, so a workspace is matched to it
 * by `cwd`.
 *
 * ## A parent carries its children
 *
 * Nesting is kept. Siblings are sorted among themselves, never pulled out of
 * their parent, and a parent's weight is its own minutes plus everything
 * beneath it — so the project you work in climbs to the top and brings its
 * parent along.
 *
 * ## Places, not scores
 *
 * The order is worked out now and then (see the store) and kept as each
 * workspace's `place`. Between those times nothing moves. When it is worked
 * out again it starts from the places it had, and a workspace only passes the
 * one above it with clearly more use — `OVERTAKE` times as much plus
 * `OVERTAKE_MIN` minutes. Two projects used about equally stay where they are
 * instead of swapping back and forth.
 */

export interface WorkspaceUsage {
  /** Where it sits among its siblings, from the last time the order by use was worked out. Lower is higher up. */
  place?: number
  /**
   * Its folder's size on disk, from the last time it was measured. Measured
   * only when the order is worked out, so sorting by size does not shuffle the
   * list as files come and go.
   */
  bytes?: number
  /**
   * Sent to the top or the bottom of its siblings by hand, and kept there
   * whatever the order says, until it is let go. Several pinned the same way
   * keep the order they were in among themselves.
   */
  pin?: 'top' | 'bottom'
}

export type WorkspaceOrder = 'manual' | 'name' | 'size' | 'use'
export const WORKSPACE_ORDERS: readonly WorkspaceOrder[] = ['manual', 'name', 'size', 'use']

interface Node {
  id: string
  name?: string
  cwd?: string
  parentId?: string | null
  usage?: WorkspaceUsage
}

/** A stretch of time on one folder, as the time log keeps it. */
interface Span {
  cwd: string
  start: number
  end: number
}

export const HALF_LIFE_DAYS = 14
/** Passing the workspace above takes this many times its use… */
export const OVERTAKE = 1.25
/** …plus this many minutes, so a handful of minutes never reorders anything. */
export const OVERTAKE_MIN = 15

const DAY = 86_400_000

/** A folder as the time log compares them: slashes one way, no trailing one, any case. */
export function pathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Minutes spent in each folder, each span counted less the longer ago it
 * ended: halved every `halfLife` days.
 */
export function fadedMinutes(spans: readonly Span[], now: number, halfLife = HALF_LIFE_DAYS): Map<string, number> {
  const out = new Map<string, number>()
  for (const span of spans) {
    const min = Math.max(0, span.end - span.start) / 60_000
    if (!(min > 0) || !span.cwd) continue
    const days = Math.max(0, now - span.end) / DAY
    const key = pathKey(span.cwd)
    out.set(key, (out.get(key) ?? 0) + min * Math.pow(0.5, days / Math.max(halfLife, 0.01)))
  }
  return out
}

/**
 * The places for every workspace, by id: each sibling group in order of use,
 * starting from the places they had and moving only for a clear difference.
 *
 * `minutes` is `fadedMinutes`, by folder. `workspaces` is in the list's own
 * order, which decides between workspaces that have no place yet and no use to
 * tell them apart.
 */
export function usagePlaces(workspaces: readonly Node[], minutes: ReadonlyMap<string, number>): Map<string, number> {
  const ids = new Set(workspaces.map((w) => w.id))
  const children = new Map<string | null, Node[]>()
  for (const w of workspaces) {
    const key = w.parentId && ids.has(w.parentId) ? w.parentId : null
    const bucket = children.get(key)
    if (bucket) bucket.push(w)
    else children.set(key, [w])
  }

  // A parent weighs what it and everything under it has been used.
  const weight = new Map<string, number>()
  const weigh = (w: Node, depth: number): number => {
    let total = w.cwd ? (minutes.get(pathKey(w.cwd)) ?? 0) : 0
    if (depth < 64) for (const child of children.get(w.id) ?? []) total += weigh(child, depth + 1)
    weight.set(w.id, total)
    return total
  }
  for (const w of children.get(null) ?? []) weigh(w, 0)

  const places = new Map<string, number>()
  for (const group of children.values()) {
    // The order they had. New ones go below the ones with a place.
    const order = group
      .map((w, i) => ({ w, i }))
      .sort((a, b) => (a.w.usage?.place ?? Infinity) - (b.w.usage?.place ?? Infinity) || a.i - b.i)
      .map(({ w }) => w)
    // Pinned ones stay out of it: at the top or the bottom, in the order they had.
    const top = order.filter((w) => w.usage?.pin === 'top')
    const bottom = order.filter((w) => w.usage?.pin === 'bottom')
    order.splice(0, order.length, ...order.filter((w) => !w.usage?.pin))
    // Each one moves up past every workspace above it that it clearly outweighs.
    for (let i = 1; i < order.length; i++) {
      let j = i
      const self = weight.get(order[j].id) ?? 0
      while (j > 0 && self > (weight.get(order[j - 1].id) ?? 0) * OVERTAKE + OVERTAKE_MIN) {
        ;[order[j - 1], order[j]] = [order[j], order[j - 1]]
        j--
      }
    }
    ;[...top, ...order, ...bottom].forEach((w, i) => places.set(w.id, i))
  }
  return places
}

/** Siblings by place; a workspace without one keeps its spot below the rest. Stable. */
export function byPlace<T extends Node>(group: readonly T[]): T[] {
  return stable(group, (a, b) => (a.usage?.place ?? Infinity) - (b.usage?.place ?? Infinity))
}

/**
 * One group of siblings in the order asked for. Ties keep the order they came
 * in. In a sorted order, ones sent to the top or bottom by hand stay there.
 */
export function sortSiblings<T extends Node>(group: readonly T[], order: WorkspaceOrder): T[] {
  if (order === 'manual') return [...group]
  const sorted = sortedSiblings(group, order)
  return [
    ...sorted.filter((w) => w.usage?.pin === 'top'),
    ...sorted.filter((w) => !w.usage?.pin),
    ...sorted.filter((w) => w.usage?.pin === 'bottom'),
  ]
}

function sortedSiblings<T extends Node>(group: readonly T[], order: WorkspaceOrder): T[] {
  switch (order) {
    case 'name':
      return stable(group, (a, b) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true, sensitivity: 'base' }))
    case 'size':
      // Biggest first; one never measured — new, or on another machine — below the rest.
      return stable(group, (a, b) => (b.usage?.bytes ?? -1) - (a.usage?.bytes ?? -1))
    case 'use':
      return byPlace(group)
    default:
      return [...group]
  }
}

function stable<T>(group: readonly T[], compare: (a: T, b: T) => number): T[] {
  return group
    .map((w, i) => ({ w, i }))
    .sort((a, b) => compare(a.w, b.w) || a.i - b.i)
    .map(({ w }) => w)
}
