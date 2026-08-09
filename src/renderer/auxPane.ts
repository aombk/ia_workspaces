/**
 * The contract for a pane that is not a shell.
 *
 * There were two pane kinds and the dispatch for them was a ternary; there are
 * about to be several, so it becomes an interface. The point is that
 * `Terminals` never learns what any of them *are* — it mounts an element,
 * disposes it, and tells it when the store changed.
 *
 * Anything a pane kind needs from the app shell arrives through its own hooks
 * object at construction, the way `FilesPane` already takes `FilesPaneHooks`.
 */
export interface AuxPane {
  readonly element: HTMLElement
  dispose(): void
  /**
   * Called on every app render, for panes that draw from store state rather
   * than from their own polling. Must be cheap and idempotent — it fires for
   * unrelated changes too.
   */
  sync?(): void
  /**
   * How this pane zooms, if it needs to do it in its own way.
   *
   * Left unset by almost everything: `Terminals` fits a `DomZoom` to any pane
   * that has not asked for something else, so a new pane kind gets Ctrl+scroll
   * and Ctrl+0 without knowing they exist. The browser is the exception — its
   * page is a `<webview>` with its own zoom, and scaling the element around it
   * would blur a page that can resize itself properly.
   */
  zoom?: PaneZoom
}

/**
 * Zooming one pane, in whatever way suits what it holds.
 *
 * The gesture is the same everywhere — Ctrl+scroll, Ctrl+plus, Ctrl+minus,
 * Ctrl+0 — and what it means is not: a terminal changes font size, a browser
 * changes page zoom, and everything else scales its own layout. The keyboard
 * and wheel handling lives in one place and asks the pane under the pointer.
 */
export interface PaneZoom {
  step(direction: 'in' | 'out'): void
  reset(): void
  /** 1 when untouched, so a caller can hide a badge. */
  factor(): number
}

/**
 * Discrete stops rather than a smooth multiplier.
 *
 * What every browser does, and what the gesture feels wrong without: a
 * continuous zoom never lands back on exactly 100%, and 100% is the one people
 * want back. Shared with the browser pane so one Ctrl+scroll notch means the
 * same amount whichever pane is under the pointer.
 */
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
]
export const ZOOM_DEFAULT = 1

/** The next stop in or out from `factor`, clamped at both ends. */
export function stepZoom(factor: number, direction: 'in' | 'out'): number {
  // Nearest stop first, so a factor that is not exactly one of these still
  // steps sensibly rather than jumping to an end.
  let nearest = 0
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    if (Math.abs(ZOOM_STEPS[i] - factor) < Math.abs(ZOOM_STEPS[nearest] - factor)) nearest = i
  }
  const next = direction === 'in' ? nearest + 1 : nearest - 1
  return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]
}

/**
 * Zoom for a pane that is ordinary DOM — the editor, the tree, the diff, the
 * reader, search, ports, compare, the inbox.
 *
 * The CSS `zoom` property rather than a `transform: scale`, and the difference
 * matters here: `zoom` scales *layout*, so a zoomed pane still wraps its text
 * to its own width and still scrolls the right distance. `scale` would draw the
 * same layout larger and push half of it outside the pane.
 *
 * Session-only, like the browser's. Persisting it would mean a schema field per
 * pane, and a zoom you set to read one stack trace is not a preference.
 */
export class DomZoom implements PaneZoom {
  private current = ZOOM_DEFAULT

  constructor(private readonly element: HTMLElement) {}

  step(direction: 'in' | 'out'): void {
    this.apply(stepZoom(this.current, direction))
  }

  reset(): void {
    this.apply(ZOOM_DEFAULT)
  }

  factor(): number {
    return this.current
  }

  private apply(factor: number): void {
    this.current = factor
    // Cleared rather than set to 1, so an untouched pane carries no inline
    // style at all and inherits whatever the stylesheet says.
    if (factor === ZOOM_DEFAULT) this.element.style.removeProperty('zoom')
    else this.element.style.zoom = String(factor)
  }
}

/**
 * A pane whose kind this build knows about but cannot show.
 *
 * The three builds share one workspace file, so a document written by Electron
 * can be opened by every host — and a browser pane was the first kind that was real
 * everywhere but only *renderable* on one host. The existing fallback for an
 * unrecognised kind is to become a terminal, and that is wrong here twice over:
 * it would spawn a shell nobody asked for, and writing the change back would
 * destroy the pane for the build that can show it.
 *
 * So the pane stays exactly what it is in the document, and says why it is
 * empty. Reopen the workspace in a build that can, and it is still a browser.
 */
export class UnavailablePane implements AuxPane {
  readonly element: HTMLDivElement

  constructor(what: string, why: string) {
    this.element = document.createElement('div')
    this.element.className = 'unavailable-pane'

    const title = document.createElement('div')
    title.className = 'unavailable-title'
    title.textContent = what
    this.element.appendChild(title)

    const body = document.createElement('div')
    body.className = 'unavailable-body'
    body.textContent = why
    this.element.appendChild(body)
  }

  dispose(): void {
    this.element.remove()
  }
}
