/**
 * Putting a web page inside a pane.
 *
 * Electron's `<webview>` is an element in our own document, so the split
 * layout, clipping and stacking all apply to it for free and this file is
 * thin. It was not always: the other implementation here was a native view
 * composited over the window, which knew nothing about the layout and had to be
 * told its rectangle on every render, and told to hide whenever a menu or a
 * toast might cover it. That is the runtime that got dropped.
 *
 * `BrowserPane` owns the address bar and the buttons and talks to the
 * `BrowserView` interface below, so a host that could only offer the harder
 * kind again would slot in here rather than anywhere else.
 */

export interface BrowserViewHooks {
  /** The page went somewhere — a link, a redirect, the address bar. */
  onNavigate(url: string): void
  onLoadingChange(loading: boolean): void
  /** A main-frame load that failed, with something worth putting on screen. */
  onFail(message: string): void
  onTitle(title: string): void
  /** The guest asked to zoom. The host decides what a step means. */
  onZoomGesture(what: 'in' | 'out' | 'reset'): void
}

export interface BrowserView {
  /** Goes in the pane, below the address bar. */
  readonly element: HTMLElement
  navigate(url: string): void
  back(): void
  forward(): void
  reload(): void
  stop(): void
  setZoom(factor: number): void
  /**
   * Called on every app render.
   *
   * A no-op for a `<webview>`, which the layout already moves — kept on the
   * interface because a runtime whose browser page is a native view over the
   * window would need it, and that is the whole point of there being an
   * interface here rather than a class.
   */
  sync(): void
  currentUrl(): string
  dispose(): void
}

/** Whether the page can be navigated back or forward, when that is knowable. */
export interface BrowserHistoryState {
  back: boolean
  forward: boolean
}

// --------------------------------------------------------------------- dom

/**
 * Electron's `<webview>`. Typed here rather than imported, because the renderer
 * is bundled for three runtimes and one type-only Electron import that survived
 * into the output would break the other two.
 */
interface WebviewElement extends HTMLElement {
  src: string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  getURL(): string
  setZoomFactor(factor: number): void
}

export class DomBrowserView implements BrowserView {
  readonly element: HTMLElement
  private readonly view: WebviewElement
  private zoom = 1

  constructor(
    _paneId: string,
    url: string,
    private readonly hooks: BrowserViewHooks
  ) {
    this.view = document.createElement('webview') as WebviewElement
    this.view.className = 'browser-view'
    // Its own partition, so a page here does not inherit or pollute anything,
    // and `persist:` so a login survives the pane being closed and reopened.
    this.view.setAttribute('partition', 'persist:browser')
    this.view.setAttribute('allowpopups', 'false')
    // The guest's one script — see `webviewPreload.ts` for why it has to exist
    // and what it is limited to. Resolved against the renderer's own URL,
    // because both are files we ship side by side.
    this.view.setAttribute('preload', new URL('../preload/webviewPreload.js', location.href).href)
    this.view.src = url
    this.element = this.view

    this.view.addEventListener('did-start-loading', this.onStart)
    this.view.addEventListener('did-stop-loading', this.onStop)
    this.view.addEventListener('did-navigate', this.onNavigate)
    this.view.addEventListener('did-navigate-in-page', this.onNavigate)
    this.view.addEventListener('did-fail-load', this.onFail)
    this.view.addEventListener('page-title-updated', this.onTitle)
    this.view.addEventListener('ipc-message', this.onGuestMessage)
    this.view.addEventListener('dom-ready', this.applyZoom)
  }

  navigate(url: string): void {
    this.view.src = url
  }

  back(): void {
    this.guarded(() => this.view.goBack())
  }

  forward(): void {
    this.guarded(() => this.view.goForward())
  }

  reload(): void {
    this.guarded(() => this.view.reload())
  }

  stop(): void {
    this.guarded(() => this.view.stop())
  }

  setZoom(factor: number): void {
    this.zoom = factor
    this.applyZoom()
  }

  /** Nothing to do: the layout already moved the element. */
  sync(): void {}

  currentUrl(): string {
    try {
      return this.view.getURL()
    } catch {
      return ''
    }
  }

  /** Only a DOM view can answer this; a hosted one has no such API. */
  history(): BrowserHistoryState {
    try {
      return { back: this.view.canGoBack(), forward: this.view.canGoForward() }
    } catch {
      return { back: false, forward: false }
    }
  }

  dispose(): void {
    this.view.removeEventListener('did-start-loading', this.onStart)
    this.view.removeEventListener('did-stop-loading', this.onStop)
    this.view.removeEventListener('did-navigate', this.onNavigate)
    this.view.removeEventListener('did-navigate-in-page', this.onNavigate)
    this.view.removeEventListener('did-fail-load', this.onFail)
    this.view.removeEventListener('page-title-updated', this.onTitle)
    this.view.removeEventListener('ipc-message', this.onGuestMessage)
    this.view.removeEventListener('dom-ready', this.applyZoom)
    this.view.remove()
  }

  private guarded(run: () => void): void {
    try {
      run()
    } catch {
      /* the guest can be gone between the click and the call */
    }
  }

  private readonly applyZoom = (): void => {
    this.guarded(() => this.view.setZoomFactor(this.zoom))
  }

  private readonly onStart = (): void => this.hooks.onLoadingChange(true)
  private readonly onStop = (): void => this.hooks.onLoadingChange(false)

  private readonly onNavigate = (): void => {
    const url = this.currentUrl()
    if (url) this.hooks.onNavigate(url)
  }

  private readonly onFail = (event: Event): void => {
    const detail = event as Event & {
      errorCode?: number
      errorDescription?: string
      isMainFrame?: boolean
    }
    // Sub-resources fail all the time on a live page; not worth a banner.
    if (detail.isMainFrame === false) return
    // Cancelled by a newer navigation, not a failure anyone needs telling about.
    if (detail.errorCode === -3) return
    this.hooks.onFail(detail.errorDescription || 'Could not load that page')
  }

  private readonly onTitle = (event: Event): void => {
    const title = (event as Event & { title?: string }).title
    if (title) this.hooks.onTitle(title)
  }

  private readonly onGuestMessage = (event: Event): void => {
    const message = event as Event & { channel?: string; args?: unknown[] }
    if (message.channel !== 'iaw:zoom') return
    const what = message.args?.[0]
    if (what === 'in' || what === 'out' || what === 'reset') this.hooks.onZoomGesture(what)
  }
}
