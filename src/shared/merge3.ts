/**
 * Three-way merge of two edited copies of one JSON document.
 *
 * With one window there was one writer: the renderer sent the whole workspace
 * document, main kept it, and the newest save was simply the truth. A second
 * window is a second writer of the same document, and "newest wins" then means
 * a rename made in one window is silently undone by a tab switch in the other,
 * because the second save was built before the first one arrived.
 *
 * So a save is not taken as the whole truth any more. It is taken as *what
 * changed* since the version its sender last saw — `base` — and those changes
 * are laid over the current document — `ours` — leaving whatever another
 * window changed in the meantime alone.
 *
 * The rules, smallest first:
 *
 * - **A value one side left alone** takes the other side's value. This is the
 *   whole of it for nearly every field: two windows rarely touch the same one.
 * - **Objects** merge key by key, so two windows editing different fields of the
 *   same workspace both keep their edit.
 * - **Arrays of records with an `id`** — workspaces, tabs, panes — merge by id.
 *   Something added on either side is kept, something removed on either side is
 *   gone, and a record both sides kept is merged recursively. Order follows the
 *   side that reordered; additions from the other side are placed after their
 *   neighbour.
 * - **Anything else edited on both sides** — two different names for one tab —
 *   is a conflict, and `prefer` decides it. There is no right answer to two
 *   people renaming the same thing at the same moment; there is only an answer
 *   that is predictable.
 *
 * Pure and dependency-free, because both processes run it: main when a save
 * arrives, and a window whose own edit was still on its way out when someone
 * else's arrived.
 */

type Json = unknown

/** Which side wins when both changed the same thing differently. */
export type Prefer = 'ours' | 'theirs'

/** Structural equality for JSON values. Key order does not matter. */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as Json[]
    if (a.length !== bb.length) return false
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], bb[i])) return false
    return true
  }
  const ao = a as Record<string, Json>
  const bo = b as Record<string, Json>
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined)
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (!jsonEqual(ao[k], bo[k])) return false
  return true
}

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** An array whose every element is a record with a string `id`, unique within it. */
function isIdList(v: Json): v is Array<Record<string, Json> & { id: string }> {
  if (!Array.isArray(v)) return false
  const seen = new Set<string>()
  for (const item of v) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) return false
    seen.add(item.id)
  }
  return true
}

export function merge3(base: Json, ours: Json, theirs: Json, prefer: Prefer = 'theirs'): Json {
  if (jsonEqual(ours, theirs)) return ours
  if (jsonEqual(base, ours)) return theirs
  if (jsonEqual(base, theirs)) return ours

  // Both sides changed it. Look inside where there is an inside.
  if (isRecord(ours) && isRecord(theirs)) {
    return mergeRecords(isRecord(base) ? base : {}, ours, theirs, prefer)
  }
  // An empty list counts as a list of records: a workspace whose last tab was
  // closed on one side must still merge with a tab opened on the other.
  const idLike = (v: Json) => isIdList(v) || (Array.isArray(v) && v.length === 0)
  if (idLike(ours) && idLike(theirs) && (isIdList(ours) || isIdList(theirs))) {
    return mergeIdLists(isIdList(base) ? base : [], ours as IdList, theirs as IdList, prefer)
  }
  return prefer === 'ours' ? ours : theirs
}

function mergeRecords(
  base: Record<string, Json>,
  ours: Record<string, Json>,
  theirs: Record<string, Json>,
  prefer: Prefer
): Record<string, Json> {
  const out: Record<string, Json> = {}
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)])
  for (const key of keys) {
    const merged = merge3(base[key], ours[key], theirs[key], prefer)
    if (merged !== undefined) out[key] = merged
  }
  return out
}

type IdList = Array<Record<string, Json> & { id: string }>

function mergeIdLists(base: IdList, ours: IdList, theirs: IdList, prefer: Prefer): IdList {
  const inBase = new Map(base.map((x) => [x.id, x]))
  const inOurs = new Map(ours.map((x) => [x.id, x]))
  const inTheirs = new Map(theirs.map((x) => [x.id, x]))

  // Which records survive. Present on both sides: kept. On one side only:
  // kept if that side added it, gone if the other side removed it.
  const keep = (id: string): boolean => {
    const o = inOurs.has(id)
    const t = inTheirs.has(id)
    if (o && t) return true
    if (inBase.has(id)) return false
    return o || t
  }

  // The order to follow: whichever side moved the records it shares with the
  // base. If both did, the preferred one.
  const orderOf = (list: IdList) => list.filter((x) => inBase.has(x.id)).map((x) => x.id)
  const baseOrder = base.map((x) => x.id)
  const oursMoved = !sameOrder(orderOf(ours), baseOrder, inOurs)
  const theirsMoved = !sameOrder(orderOf(theirs), baseOrder, inTheirs)
  const leadIsOurs = oursMoved && (!theirsMoved || prefer === 'ours')
  const lead = leadIsOurs ? ours : theirs
  const other = leadIsOurs ? theirs : ours

  const ids: string[] = lead.map((x) => x.id).filter(keep)
  // What only the other side has: placed after the record it followed there,
  // or at the front if it led.
  other.forEach((item, index) => {
    if (ids.includes(item.id) || !keep(item.id)) return
    let at = 0
    for (let i = index - 1; i >= 0; i--) {
      const anchor = ids.indexOf(other[i].id)
      if (anchor >= 0) {
        at = anchor + 1
        break
      }
    }
    ids.splice(at, 0, item.id)
  })

  return ids.map((id) => {
    const o = inOurs.get(id)
    const t = inTheirs.get(id)
    if (o && t) return merge3(inBase.get(id), o, t, prefer) as IdList[number]
    return (o ?? t)!
  })
}

/** Whether `order` keeps the base's relative order, ignoring records since removed. */
function sameOrder(order: string[], baseOrder: string[], present: Map<string, unknown>): boolean {
  const expected = baseOrder.filter((id) => present.has(id))
  return order.length === expected.length && order.every((id, i) => id === expected[i])
}
