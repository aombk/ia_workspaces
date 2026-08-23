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
import { joinPath } from '../shared/platform'
import { showToast } from './ui/toast'
import type { AuxPane } from './auxPane'

export interface ReaderPaneHooks {
  /** Hand the file to the editor named in settings, or the shell default. */
  openExternally(path: string): void
  /**
   * Show another document in this same pane.
   *
   * How a `[[wikilink]]` is followed. In the pane rather than in a new tab,
   * because following a link between notes is reading rather than opening —
   * a tab per hop turns a train of thought into twelve tabs.
   */
  openDocument?(path: string): void
}

const MARKDOWN = /\.(md|markdown|mdown|mkd)$/i

/** A file's name without its folder or extension — what `[[links]]` are written as. */
function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).pop() ?? path
  return leaf.replace(/\.[^.]+$/, '')
}

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
      const target = e.target as HTMLElement

      // `[[note]]` — resolved against this document's own folder, which is what
      // makes a set of notes in one project link to each other without anybody
      // writing a path.
      const wiki = target.dataset?.wiki
      if (wiki) {
        e.preventDefault()
        void this.followWiki(wiki)
        return
      }

      const href = target.dataset?.href
      if (!href) return
      e.preventDefault()
      void backend().openExternal(href)
    })

    void this.load()
  }

  /**
   * Opens `[[name]]`, trying the spellings people actually write.
   *
   * `name`, `name.md`, and the same with spaces as hyphens — because a link
   * written mid-sentence reads as prose (`[[the build script]]`) and the file
   * it means is almost always `the-build-script.md`. A name that matches
   * nothing says so rather than opening an empty document, since a wiki whose
   * links quietly create files is a wiki full of files nobody meant to make.
   */
  private async followWiki(name: string): Promise<void> {
    const dir = folderOf(this.path)
    const platform = backend().capabilities.platform
    const bare = name.replace(/\.md$/i, '')
    const candidates = [
      `${bare}.md`,
      bare,
      `${bare.replace(/\s+/g, '-')}.md`,
      `${bare.replace(/\s+/g, '_')}.md`,
    ]

    for (const candidate of candidates) {
      const full = joinPath(platform, dir, candidate)
      try {
        await backend().readText(full)
      } catch {
        continue
      }
      if (this.hooks.openDocument) this.hooks.openDocument(full)
      else this.hooks.openExternally(full)
      return
    }

    showToast('No such note', `Nothing beside this file is called “${bare}”.`, { kind: 'warn' })
  }

  /**
   * The other notes in this folder that link here.
   *
   * The half of a wiki that makes it worth keeping: a link you wrote in March
   * is only useful in June if the thing you linked *to* knows about it. Found
   * with the search the app already has rather than an index of our own —
   * there is no cache to go stale, and a folder of notes is not enough files
   * for the difference to be noticeable.
   */
  private async renderBacklinks(): Promise<void> {
    if (!MARKDOWN.test(this.path)) return
    const dir = folderOf(this.path)
    const me = fileStem(this.path)

    let hits: { path: string }[] = []
    try {
      hits = await backend().search(dir, `[[${me}`, false)
    } catch {
      return
    }
    if (this.disposed) return

    const others = [...new Set(hits.map((h) => h.path))].filter((p) => p !== this.path)
    if (!others.length) return

    const card = document.createElement('div')
    card.className = 'reader-backlinks'

    const title = document.createElement('h3')
    title.textContent = `linked from ${others.length === 1 ? 'one note' : `${others.length} notes`}`
    card.appendChild(title)

    for (const other of others) {
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'md-wikilink'
      link.textContent = fileStem(other)
      link.addEventListener('click', () => {
        if (this.hooks.openDocument) this.hooks.openDocument(other)
        else this.hooks.openExternally(other)
      })
      card.appendChild(link)
    }
    this.body.appendChild(card)
  }

  private async load(): Promise<void> {
    try {
      const text = await backend().readText(this.path)
      if (this.disposed) return
      this.body.replaceChildren()
      if (MARKDOWN.test(this.path)) {
        this.body.classList.add('markdown')
        this.body.appendChild(renderMarkdown(text, folderOf(this.path)))
        // After the document, and not awaited: a search across the folder is
        // slower than reading one file, and the note should be on screen while
        // it runs rather than after it.
        void this.renderBacklinks()
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
