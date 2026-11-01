/**
 * The workspace document, held once for every window.
 *
 * Every window keeps a full copy and saves the whole thing, which is how the
 * single window always worked and why the renderer's store needed no rewrite
 * to have several. What changes is how a save is taken: as the edits its
 * window made since the revision it was built on, laid over whatever main has
 * now — see `merge3`. A rename in one window and a tab switch in another then
 * both survive, whichever save arrives second.
 *
 * Each accepted save is a new revision and goes back out to every window,
 * the one that sent it included: that is how the sender learns its save
 * landed, and what else came with it.
 *
 * Main's own edits — a window closing, tabs being sent to another window,
 * another copy of the app rewriting the file — are revisions too, made with
 * `replace`.
 */
import { merge3 } from '../shared/merge3'
import type { StateRevision } from '../shared/types'

/**
 * How many past revisions are kept to merge against.
 *
 * A window's save names the revision it started from, and is merged against
 * that one. A window more than this many revisions behind — asleep through a
 * burst of saves from the others — is treated the way every save used to be:
 * what it sent is taken whole.
 */
const HISTORY = 64

type Doc = Record<string, unknown>

export class StateHub {
  private current: Doc
  private revision = 1
  private readonly history = new Map<number, Doc>()

  constructor(
    initial: unknown,
    /** Fields only main writes. A window's copy of them is ignored. */
    private readonly mainOwned: readonly string[]
  ) {
    this.current = asDoc(initial)
    this.history.set(this.revision, this.current)
  }

  get doc(): Doc {
    return this.current
  }

  get rev(): number {
    return this.revision
  }

  snapshot(from = ''): StateRevision {
    return { rev: this.revision, doc: this.current, from }
  }

  /**
   * A window's save. Returns the new revision, or null for something that is
   * not a document at all.
   *
   * `fromMain` says whether the window is the main one. Only that window's
   * selection lives at the top of the document; another window's save leaves
   * it as it was, whatever its copy says.
   */
  save(next: unknown, baseRev: number | undefined, fromMain: boolean): StateRevision | null {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return null
    const incoming = { ...(next as Doc) }
    for (const field of this.mainOwned) {
      if (this.current[field] !== undefined) incoming[field] = this.current[field]
      else delete incoming[field]
    }

    const base = baseRev === undefined ? undefined : this.history.get(baseRev)
    let merged = (base ? merge3(base, this.current, incoming, 'theirs') : incoming) as Doc
    if (!fromMain) merged = keepMainSelection(merged, this.current)
    return this.commit(merged)
  }

  /**
   * Changes fields only main writes, without a new revision.
   *
   * For a window's position, which changes on every drag and which no window
   * reads: a revision would send the whole document to every window for
   * nothing. Saves cannot disturb these fields — see `mainOwned` — so a window
   * merging against an older revision loses nothing by not having been told.
   */
  patchMainOwned(fields: Record<string, unknown>): void {
    this.current = { ...this.current, ...fields }
    this.history.set(this.revision, this.current)
  }

  /** Main's own edit, or a document from somewhere else entirely. */
  replace(next: unknown): StateRevision {
    return this.commit(asDoc(next))
  }

  private commit(next: Doc): StateRevision {
    this.current = next
    this.revision++
    this.history.set(this.revision, next)
    this.history.delete(this.revision - HISTORY)
    return { rev: this.revision, doc: next, from: '' }
  }
}

function asDoc(value: unknown): Doc {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Doc) : {}
}

/**
 * The main window's selection, put back over a save from another window.
 *
 * The top-level `activeWorkspaceId` and each workspace's `activeTabId` are the
 * main window's — see `WindowView`. The windows already leave them alone when
 * they save, so this is the rule written down where it cannot be forgotten
 * rather than the thing that makes it work. A workspace or tab that has gone
 * since is not put back.
 */
function keepMainSelection(merged: Doc, current: Doc): Doc {
  const out: Doc = { ...merged }
  const workspaces = Array.isArray(merged.workspaces) ? (merged.workspaces as Doc[]) : []
  if (
    typeof current.activeWorkspaceId === 'string' &&
    workspaces.some((w) => w.id === current.activeWorkspaceId)
  ) {
    out.activeWorkspaceId = current.activeWorkspaceId
  }
  const held = new Map(
    (Array.isArray(current.workspaces) ? (current.workspaces as Doc[]) : []).map((w) => [w.id, w.activeTabId])
  )
  out.workspaces = workspaces.map((w) => {
    if (!held.has(w.id)) return w
    const tab = held.get(w.id)
    const tabs = Array.isArray(w.tabs) ? (w.tabs as Doc[]) : []
    if (tab === null || tabs.some((t) => t.id === tab)) return { ...w, activeTabId: tab }
    return w
  })
  return out
}
