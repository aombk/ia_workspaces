/**
 * A file, read-only.
 *
 * Markdown gets rendered; anything else is shown as plain text. Read-only is
 * the whole design: editing means save semantics, encodings, external-change
 * conflicts, undo and eventually a language server, which is how a terminal
 * quietly becomes a bad editor. The **Open in editor** button hands the file to
 * the one you already use.
 */
import { backend } from '../backend'
import { store } from './state'
import { renderMarkdown, folderOf } from './markdown'
import type { AuxPane } from './auxPane'

export interface ReaderPaneHooks {
  /** Hand the file to the editor named in settings, or the shell default. */
  openExternally(path: string): void
}

const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i

export class ReaderPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private readonly pathLabel: HTMLSpanElement
  private disposed = false

  constructor(
    readonly paneId: string,
    private readonly path: string,
    private readonly hooks: ReaderPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'reader-pane'

    const head = document.createElement('div')
    head.className = 'reader-head'

    this.pathLabel = document.createElement('span')
    this.pathLabel.className = 'reader-path'
    this.pathLabel.textContent = path
    this.pathLabel.title = path
    head.appendChild(this.pathLabel)

    const reload = document.createElement('button')
    reload.className = 'reader-btn'
    reload.textContent = 'Reload'
    reload.addEventListener('click', () => void this.load())
    head.appendChild(reload)

    const open = document.createElement('button')
    open.className = 'reader-btn'
    open.textContent = 'Open in editor'
    open.title = store.settings.externalEditor || 'Opens with whatever Windows associates'
    open.addEventListener('click', () => this.hooks.openExternally(this.path))
    head.appendChild(open)

    this.element.appendChild(head)

    this.body = document.createElement('div')
    this.body.className = 'reader-body'
    this.element.appendChild(this.body)

    // Links are opened through the shell rather than followed: this is a
    // webview showing the app, and navigating it away has no way back.
    this.body.addEventListener('click', (e) => {
      const href = (e.target as HTMLElement).dataset?.href
      if (!href) return
      e.preventDefault()
      void backend().openExternal(href)
    })

    void this.load()
  }

  private async load(): Promise<void> {
    try {
      const text = await backend().readText(this.path)
      if (this.disposed) return
      this.body.replaceChildren()
      if (MARKDOWN.test(this.path)) {
        this.body.classList.add('markdown')
        this.body.appendChild(renderMarkdown(text, folderOf(this.path)))
      } else {
        this.body.classList.remove('markdown')
        const pre = document.createElement('pre')
        pre.className = 'reader-plain'
        pre.textContent = text
        this.body.appendChild(pre)
      }
    } catch (err) {
      if (this.disposed) return
      this.body.replaceChildren()
      const problem = document.createElement('div')
      problem.className = 'reader-error'
      problem.textContent = err instanceof Error ? err.message : String(err)
      this.body.appendChild(problem)
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN.test(path)
}
