/**
 * Dragging things between windows and monitors.
 *
 * A workspace from the sidebar, a tab from the strip, a pane by its header:
 * each can be dropped
 *
 * - **inside its own window**, which is what it always did — reorder, nest,
 *   split;
 * - **onto another of this app's windows**, which takes it: a pane or tab
 *   dropped on a pane there splits that pane, anything dropped anywhere else
 *   there moves into that window;
 * - **onto no window at all** — the desktop of another monitor — where it goes
 *   to the window already on that monitor, or becomes a new window there if
 *   there is none. Dragging something back to the main window's monitor is how
 *   it goes home.
 *
 * The drag state in `dragState.ts` lives in one page, and the other windows
 * cannot read it. So a drag that may cross says what it is in the drag itself,
 * under a type of its own, and the window it lands in reads that.
 */
import { backend } from '../../backend'
import { store, type DropSide } from '../state'
import { draggingPane, draggingTab, draggingWorkspace } from './dragState'

/** The drag type that crosses windows. */
const CROSS_DRAG = 'application/x-iaw-cross'

export interface CrossDrag {
  kind: 'workspace' | 'tab' | 'pane'
  id: string
  /** The window it was picked up in. */
  windowId: string
}

/** Puts what is being dragged on the drag, for whichever window it lands in. */
export function markCrossDrag(e: DragEvent, kind: CrossDrag['kind'], id: string): void {
  if (!backend().windows || !e.dataTransfer) return
  const payload: CrossDrag = { kind, id, windowId: store.windowId }
  e.dataTransfer.setData(CROSS_DRAG, JSON.stringify(payload))
}

/**
 * A drag from another window, as far as `dragover` can tell — which is that it
 * carries the type and that nothing in this window started it.
 */
export function isForeignDrag(e: DragEvent): boolean {
  if (draggingTab() || draggingPane() || draggingWorkspace()) return false
  return Boolean(e.dataTransfer?.types.includes(CROSS_DRAG))
}

/** What a drop from another window carries, or null if it is not one. */
export function readForeignDrag(e: DragEvent): CrossDrag | null {
  if (draggingTab() || draggingPane() || draggingWorkspace()) return null
  const raw = e.dataTransfer?.getData(CROSS_DRAG)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as CrossDrag
    return parsed.windowId === store.windowId ? null : parsed
  } catch {
    return null
  }
}

/**
 * Whether a drag ended outside this window, on nothing that took it.
 *
 * A drop onto one of this app's other windows is taken by that window and ends
 * with an effect, so it is never mistaken for this.
 */
export function endedOutside(e: DragEvent): boolean {
  if (!backend().windows || e.dataTransfer?.dropEffect !== 'none') return false
  return e.clientX < 0 || e.clientY < 0 || e.clientX > window.innerWidth || e.clientY > window.innerHeight
}

/**
 * The tabs a dragged thing stands for, ready to move.
 *
 * A pane that shares its tab is lifted into a tab of its own first, so that
 * only it moves and its neighbours stay where they were.
 */
function tabsFor(subject: CrossDrag): string[] {
  if (subject.kind === 'workspace') {
    return store.workspaces.find((w) => w.id === subject.id)?.tabs.map((t) => t.id) ?? []
  }
  if (subject.kind === 'tab') return store.tab(subject.id) ? [subject.id] : []
  const tab = store.tabOfPane(subject.id)
  if (!tab) return []
  if (tab.panes.length === 1) return [tab.id]
  const lifted = store.liftPaneToTab(subject.id)
  return lifted ? [lifted] : []
}

/**
 * Something dragged out of this window and dropped on no window: to the window
 * on the monitor it was dropped on, or a new one there. Main decides which —
 * only it knows where the windows are.
 */
export function dropOutside(subject: CrossDrag, e: DragEvent): void {
  // A whole workspace goes as a workspace, so it is listed where it lands —
  // and goes even with no tabs open.
  if (subject.kind === 'workspace') {
    void backend().windows?.dropAt([], { x: e.screenX, y: e.screenY }, subject.id)
    return
  }
  const tabIds = tabsFor(subject)
  if (!tabIds.length) return
  // Saved before main is asked, so the tab a pane was just lifted into exists
  // in main's copy by the time main moves it.
  store.flushNow()
  void backend().windows?.dropAt(tabIds, { x: e.screenX, y: e.screenY })
}

/**
 * Something dropped here from another window.
 *
 * Onto a pane, a pane or tab splits that pane on the side it was dropped on —
 * exactly what the same drop does inside one window. Anywhere else, or a whole
 * workspace, it simply moves into this window.
 *
 * The split is done here, in this window's copy of the document: every window
 * holds all of it, and the window the pane came from lets go of it as soon as
 * it sees that it lives here now.
 */
export function takeForeignDrag(subject: CrossDrag, onto?: { paneId: string; side: DropSide }): boolean {
  if (onto && subject.kind !== 'workspace') {
    const target = store.tabOfPane(onto.paneId)
    const tabIds = tabsFor(subject)
    // True so the caller rebuilds the tab it split: its layout changed under
    // a tree that is already on screen.
    if (target && tabIds.length === 1 && tabIds[0] !== target.id) {
      return store.dropTabIntoPane(tabIds[0], onto.paneId, onto.side)
    }
  }
  if (subject.kind === 'workspace') {
    void backend().windows?.moveWorkspace(subject.id, store.windowId)
    return false
  }
  const tabIds = tabsFor(subject)
  if (!tabIds.length) return false
  store.flushNow()
  void backend().windows?.moveTabs(tabIds, store.windowId)
  return false
}
