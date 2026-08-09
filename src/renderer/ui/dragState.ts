/**
 * What is currently being dragged, shared between the tab strip and the sidebar.
 *
 * They are separate components with separate handlers, but a tab dropped on a
 * workspace row has to be understood by both: the strip knows what left, the
 * sidebar knows where it landed. `dataTransfer` cannot answer that — its
 * payload is unreadable during `dragover`, which is exactly when a drop target
 * has to decide whether to light up.
 */
export type DragSubject =
  | { kind: 'workspace'; id: string }
  | { kind: 'tab'; id: string; from: string }
  /** A pane dragged by its header. `from` is the tab it currently sits in. */
  | { kind: 'pane'; id: string; from: string }

let current: DragSubject | null = null

export function beginDrag(subject: DragSubject): void {
  current = subject
}

export function currentDrag(): DragSubject | null {
  return current
}

/** The tab being dragged, or null when it is anything else. */
export function draggingTab(): { id: string; from: string } | null {
  return current?.kind === 'tab' ? current : null
}

/** The workspace being dragged, or null when it is anything else. */
export function draggingWorkspace(): string | null {
  return current?.kind === 'workspace' ? current.id : null
}

/** The pane being dragged by its header, or null when it is anything else. */
export function draggingPane(): { id: string; from: string } | null {
  return current?.kind === 'pane' ? current : null
}

export function endDrag(): void {
  current = null
}
