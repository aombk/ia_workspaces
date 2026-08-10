/**
 * A web page, in a pane.
 *
 * The thing you want next to a terminal is the dev server the terminal is
 * building — watch it reload without alt-tabbing to a window that then covers
 * the output you were reading. Docs and a dashboard are the other two.
 *
 * This file is the chrome: the address bar, the navigation buttons, the zoom
 * badge. How the page is actually shown differs so much between hosts that it
 * lives behind `BrowserView` in `browserView.ts` — an element in our own
 * document, so the split layout handles it like any other pane.
 * Nothing here knows which it got.
 */
import { backend } from '../backend'
import { DomBrowserView, type BrowserView } from './browserView'
import { stepZoom, ZOOM_DEFAULT, type AuxPane, type PaneZoom } from './auxPane'

/** Where a new browser pane starts. */
export const DEFAULT_URL = 'https://github.com/aombk/ia_workspaces'

export interface BrowserPaneHooks {
  /** Records the page a pane is on, so reopening comes back to it. */
  onUrlChange(paneId: string, url: string): void
}

export class BrowserPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly view: BrowserView
  private readonly address: HTMLInputElement
  private readonly back: HTMLButtonElement
  private readonly forward: HTMLButtonElement
  private readonly reload: HTMLButtonElement
  private readonly status: HTMLSpanElement
  private readonly zoomBadge: HTMLButtonElement
  /** Page zoom, as a factor. Per pane, and kept across navigation. */
  private zoomFactor = ZOOM_DEFAULT
  /** True while the page is loading, so the button can offer Stop. */
  private loading = false
  /** Set while we are writing the address bar, so we do not fight typing. */
  private editing = false

  constructor(
    readonly paneId: string,
    url: string,
    private readonly hooks: BrowserPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'browser-pane'

    const bar = document.createElement('div')
    bar.className = 'browser-bar'

    this.back = navButton('‹', 'Back', () => this.view.back())
    this.forward = navButton('›', 'Forward', () => this.view.forward())
    this.reload = navButton('⟳', 'Reload', () => {
      if (this.loading) this.view.stop()
      else this.view.reload()
    })
    bar.append(this.back, this.forward, this.reload)

    this.address = document.createElement('input')
    this.address.className = 'browser-address'
    this.address.spellcheck = false
    this.address.value = url
    this.address.placeholder = 'Address'
    this.address.addEventListener('focus', () => {
      this.editing = true
      this.address.select()
    })
    this.address.addEventListener('blur', () => {
      this.editing = false
      this.address.value = this.view.currentUrl() || this.address.value
    })
    this.address.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.navigate(this.address.value)
        this.address.blur()
      } else if (e.key === 'Escape') {
        this.address.value = this.view.currentUrl()
        this.address.blur()
      }
      // A pane's shortcuts are the app's, and this is a text field — Ctrl+W
      // here should not close the tab out from under what you are typing.
      e.stopPropagation()
    })
    bar.appendChild(this.address)

    // Only there when the page is not at 100%, like a browser's own indicator,
    // and clicking it puts things back — which is what you want after zooming
    // past what you meant to.
    this.zoomBadge = document.createElement('button')
    this.zoomBadge.className = 'browser-zoom'
    this.zoomBadge.hidden = true
    this.zoomBadge.title = 'Reset zoom (Ctrl+0)'
    this.zoomBadge.addEventListener('click', () => this.setZoom(ZOOM_DEFAULT))
    bar.appendChild(this.zoomBadge)

    const external = document.createElement('button')
    external.className = 'browser-btn'
    external.textContent = '↗'
    external.title = 'Open in your real browser'
    external.addEventListener('click', () => {
      const current = this.view.currentUrl()
      if (current) void backend().openExternal(current)
    })
    bar.appendChild(external)

    this.element.appendChild(bar)

    const hooksForView = {
      onNavigate: (next: string) => {
        if (!this.editing) this.address.value = next
        this.refreshNav()
        this.hooks.onUrlChange(this.paneId, next)
      },
      onLoadingChange: (loading: boolean) => {
        this.loading = loading
        this.reload.textContent = loading ? '×' : '⟳'
        this.reload.title = loading ? 'Stop' : 'Reload'
        if (loading) this.setStatus('')
        else this.refreshNav()
      },
      onFail: (message: string) => this.setStatus(message),
      onTitle: (title: string) => {
        this.element.title = title
      },
      onZoomGesture: (what: 'in' | 'out' | 'reset') => {
        this.setZoom(what === 'reset' ? ZOOM_DEFAULT : stepZoom(this.zoomFactor, what))
      },
    }

    const start = normalise(url) || DEFAULT_URL
    this.view = new DomBrowserView(paneId, start, hooksForView)
    this.element.appendChild(this.view.element)

    this.status = document.createElement('span')
    this.status.className = 'browser-status'
    this.element.appendChild(this.status)

    this.refreshNav()
  }

  /**
   * The page zooms itself rather than being scaled from outside.
   *
   * A `<webview>` reflows at a new zoom the way a browser window does — text
   * rewraps, media queries re-evaluate, images resample. Scaling the element
   * around it would enlarge a bitmap of a page that could have redrawn itself
   * properly, which is why this is the one pane that does not take `DomZoom`.
   */
  readonly zoom: PaneZoom = {
    step: (direction) => this.setZoom(stepZoom(this.zoom.factor(), direction)),
    reset: () => this.setZoom(ZOOM_DEFAULT),
    factor: () => this.zoomFactor,
  }

  /** No-op for a `<webview>`, which the layout has already moved. */
  sync(): void {
    this.view.sync()
  }

  dispose(): void {
    this.view.dispose()
    this.element.remove()
  }

  /** Sends the pane somewhere, from the address bar or from a caller. */
  navigate(raw: string): void {
    const url = normalise(raw)
    if (!url) return
    this.view.navigate(url)
    this.address.value = url
  }

  private setZoom(factor: number): void {
    this.zoomFactor = factor
    this.view.setZoom(factor)
    this.zoomBadge.hidden = factor === ZOOM_DEFAULT
    this.zoomBadge.textContent = `${Math.round(factor * 100)}%`
  }

  private setStatus(text: string): void {
    this.status.textContent = text
    this.status.classList.toggle('visible', Boolean(text))
  }

  private refreshNav(): void {
    const history = this.view instanceof DomBrowserView ? this.view.history() : null
    this.back.disabled = history ? !history.back : false
    this.forward.disabled = history ? !history.forward : false
  }
}

function navButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'browser-btn'
  button.textContent = glyph
  button.title = title
  button.addEventListener('click', onClick)
  return button
}

/**
 * Turns what someone typed into something to navigate to.
 *
 * A bare `localhost:5173` is the overwhelmingly common input here and is not a
 * URL — it parses as the `localhost:` scheme with `5173` as its path. Anything
 * with a dot or a colon is treated as an address and given `http://`; the rest
 * is not guessed at, because silently turning a typo into a web search is how a
 * browser leaks what you typed to a search engine.
 *
 * `file:` and `data:` are refused. A pane that can be pointed at the local disk
 * or at arbitrary inline markup is a different security proposition from one
 * that shows web pages, and nothing here needs it.
 */
export function normalise(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  if (scheme) {
    const name = scheme[1].toLowerCase()
    if (name === 'http' || name === 'https') return text
    if (name === 'about') return text
    // A bare host:port, which is the common case and only looks like a scheme.
    if (/^[a-z0-9.-]+:\d+(\/|$)/i.test(text)) return `http://${text}`
    return ''
  }

  if (/^[^\s/]+\.[^\s/]+/.test(text) || text.startsWith('localhost')) return `http://${text}`
  return ''
}
