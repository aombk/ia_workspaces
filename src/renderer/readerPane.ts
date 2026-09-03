/**
 * A file, read-only.
 *
 * Markdown gets rendered; anything else is shown as plain text. Read-only is
 * the whole design: editing means save semantics, encodings, external-change
 * conflicts, undo and eventually a language server, which is how a terminal
 * quietly becomes a bad editor. The **Open in editor** button hands the file to
 * the one you already use.
 *
 * A PDF is the one file this pane does not read at all. The engine already owns
 * a viewer for it — pages, toolbar, search, the lot — so the pane's whole job
 * there is to point that viewer at the file and get out of the way. Which means
 * a third branch rather than a second: text we mark up, markdown we mark up
 * more, and a document we simply hand over. `shared/docs.ts` says which files
 * qualify and how they reach the page.
 *
 * Sound and video are a fourth branch on the same principle, and the principle
 * is the one worth holding on to as formats get asked for: **ship what the
 * engine already renders, and stop where a parser would have to be written.**
 * A PDF, an MP3 and an MP4 cost a tag apiece and are maintained by Chromium; a
 * DXF or an FBX would be a format library with our name on it, for good. The
 * line is not about how many things this pane can show — it is about how much
 * of what it shows we would have to keep working ourselves.
 */
import { backend } from '../backend'
import { store } from './state'
import { renderMarkdown, toggleTaskLine, folderOf } from './markdown'
import { encodeDocumentPath, isDocumentPath } from '../shared/docs'
import { encodeMediaPath, isMediaPath, mediaKind } from '../shared/media'
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
  /** The live PDF viewer, when this file is one. See `teardownDocument`. */
  private embed: HTMLEmbedElement | null = null
  /** Bumped per load, to keep every generation's URL its own. See `showDocument`. */
  private documentLoads = 0
  /** The live player, when this file is sound or video. See `teardownMedia`. */
  private media: HTMLMediaElement | null = null

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
    // Before the read rather than after it, and that ordering is the whole
    // point: `readText` decodes what it finds as UTF-8 and gives up past a
    // size, so asking it for a drawing set returns a truncated page of
    // mojibake — no error, no empty string, just a document that looks
    // corrupt. A PDF's bytes have no business in our heap in the first place.
    if (isDocumentPath(this.path)) {
      this.showDocument()
      return
    }

    // Same reasoning one format along: the engine plays these itself, and
    // reading them into a string would be worse here than for a PDF rather than
    // better — a video is the one thing on disk guaranteed not to fit in a
    // renderer's heap.
    if (isMediaPath(this.path)) {
      this.showMedia()
      return
    }

    try {
      const text = await backend().readText(this.path)
      if (this.disposed) return
      this.body.replaceChildren()
      if (MARKDOWN.test(this.path)) {
        this.body.classList.add('markdown')
        this.body.appendChild(
          renderMarkdown(text, folderOf(this.path), {
            onToggle: (line, checked) => void this.tick(line, checked),
          })
        )
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

  /**
   * Ticks a checkbox in the file this pane is showing.
   *
   * The one write this pane does, and it is worth being plain about why it does
   * not make the pane an editor. Read-only here means it does not put you in
   * front of the text with a caret and the whole apparatus that follows — save
   * semantics, encodings, undo. A checklist is different in kind: the tick *is*
   * the reading. A list you can only look at is a list you keep somewhere else.
   *
   * Read again before writing rather than patching the copy on screen. This is
   * a workspace where an agent may be rewriting the very file you are ticking,
   * and the line that was third when the page was drawn may be somebody else's
   * line now. If it no longer looks like the task it was, nothing is written
   * and what is on disk is shown instead.
   */
  private async tick(line: number, checked: boolean): Promise<void> {
    try {
      const current = await backend().readText(this.path)
      const patched = toggleTaskLine(current, line, checked)
      if (!patched) {
        showToast('The file changed', 'This checklist moved under you. Showing what is there now.')
        void this.load()
        return
      }
      await backend().files.writeText(this.path, patched)
      // Redrawn from what was written, not from the click: a box that reports a
      // state the file does not have is the one failure worth avoiding here.
      void this.load()
    } catch (err) {
      showToast('Could not tick that', err instanceof Error ? err.message : String(err))
      void this.load()
    }
  }

  /**
   * A PDF, handed to the engine's viewer.
   *
   * `<embed>` and not `<iframe>`, because the CSP in `index.html` grants the
   * document scheme under `object-src` — the directive that governs embedded
   * plugin documents. An iframe would need `frame-src`, and widening the policy
   * so this pane can show a PDF would widen it for the markdown we render and
   * for every page the browser pane visits as well. One reader is not worth
   * that trade, and `object-src` costs nothing else.
   *
   * Nothing here is awaited and nothing here can fail our way: the fetch, the
   * decode and the "this file is not really a PDF" case all belong to the
   * viewer, which reports them in its own furniture. There are no backlinks to
   * look for either — a PDF has no `[[wikilinks]]` for the folder search to
   * find, and running it anyway would put an empty card under a viewer that
   * fills the pane.
   */
  private showDocument(): void {
    this.teardownDocument()
    this.teardownMedia()
    this.body.replaceChildren()
    // The markdown class is a measured column with generous padding, which is
    // exactly right for a README and exactly wrong for a viewer that wants the
    // pane edge to edge.
    this.body.classList.remove('markdown')
    this.body.classList.remove('document')

    if (!backend().capabilities.documents) {
      this.body.appendChild(this.documentUnavailable())
      return
    }

    this.body.classList.add('document')
    const embed = document.createElement('embed')
    embed.className = 'reader-document'
    // Stated rather than left to the handler's `content-type`, because the
    // viewer only appears for exactly this type and an element that guesses
    // wrong is a grey rectangle with no explanation attached.
    embed.type = 'application/pdf'
    embed.title = this.path

    // Reload is why this element is built from scratch on every load instead of
    // being kept and re-pointed. An `<embed>` already showing a document does
    // not re-fetch when its `src` is assigned the string it already holds:
    // Chromium sees no navigation, the viewer keeps the pages it has, and a PDF
    // you regenerated ten seconds ago still shows this morning's draft. Pulling
    // the old element out of the tree and appending a new one is a genuine new
    // load, and that is the part doing the work.
    //
    // The fragment then makes each generation's URL its own, and it is a
    // fragment rather than the usual `?v=` for a reason worth writing down. The
    // handler treats everything after `iaw-doc://f/` as the encoded path, so a
    // query string puts characters in it that are not in the base64url
    // alphabet; `decodePathUrl` rejects the lot and the pane gets a 400 where a
    // document should be. It is the one cache-buster guaranteed to break this
    // scheme. A fragment normally never leaves the renderer at all — it is
    // stripped before the request is made, and read only by the viewer, which
    // ignores keys it does not know the way it ignores everything that is not
    // `page` or `zoom`. And on a host that did pass the `#` through, the
    // decoder drops it explicitly rather than failing on it, so this is safe by
    // construction rather than by luck.
    embed.src = `${encodeDocumentPath(this.path)}#iaw-load=${++this.documentLoads}`

    this.body.appendChild(embed)
    this.embed = embed
  }

  /**
   * The hosts with no viewer to hand it to.
   *
   * `capabilities.documents` is false on the Tauri build, where there is no
   * plugin PDF viewer behind the webview and no document scheme feeding one.
   * The three builds share one workspace file, so a reader pane on a PDF is
   * something somebody legitimately saved on one host and reopened on another —
   * a state to explain, not a mistake to throw about, which is the same reading
   * `UnavailablePane` takes of a browser pane opened where there is no browser.
   *
   * The header stays, and with it **Open in editor**, because that button is
   * the answer: every host can hand a file to the system, and the system has a
   * PDF reader on it.
   */
  private documentUnavailable(): HTMLElement {
    const card = document.createElement('div')
    card.className = 'reader-notice'

    const title = document.createElement('div')
    title.className = 'reader-notice-title'
    title.textContent = 'No PDF viewer in this build'
    card.appendChild(title)

    const body = document.createElement('div')
    body.className = 'reader-notice-body'
    body.textContent =
      'This host cannot show a PDF inside a pane. Open in editor hands the file ' +
      'to whatever this machine already opens PDFs with.'
    card.appendChild(body)

    return card
  }

  /**
   * Unhook the viewer rather than dropping the element on the floor.
   *
   * An `<embed>` is not a picture. Behind it is a live plugin document with its
   * own frame, its own renderer state and an open handle on a file that may be
   * a hundred megabytes. Chromium tears all of that down when the element
   * leaves the tree, so the removal is the part that matters; clearing the
   * source first is belt and braces for the case where something still holds a
   * reference to the node after we have let go of it, and costs one attribute
   * write. The field is cleared before either, so a teardown that runs twice —
   * a reload racing a pane close — is a no-op the second time.
   */
  private teardownDocument(): void {
    const embed = this.embed
    if (!embed) return
    this.embed = null
    embed.removeAttribute('src')
    embed.remove()
  }

  /**
   * Sound and video, played by the engine.
   *
   * An `<audio>` or a `<video>` rather than anything of ours, for exactly the
   * reason the PDF is an `<embed>`: Chromium already has the decoder, the
   * transport bar, the keyboard shortcuts and the scrubber, and none of that is
   * worth reimplementing badly.
   *
   * `preload="metadata"` is the setting that matters. The default, `auto`, has
   * the element start pulling the whole file the moment it is in the tree — so
   * opening a pane on a 4 GB capture would read 4 GB before anybody pressed
   * play. `metadata` fetches the header, which is what the duration and the
   * scrubber need, and leaves the rest to the range requests `mediaProtocol.ts`
   * answers.
   */
  private showMedia(): void {
    this.teardownMedia()
    this.teardownDocument()
    this.body.replaceChildren()
    this.body.classList.remove('markdown')
    this.body.classList.remove('document')
    this.body.classList.add('media')

    const kind = mediaKind(this.path)
    if (!kind) return

    const el = document.createElement(kind) as HTMLMediaElement
    el.className = `reader-media reader-media--${kind}`
    el.controls = true
    el.preload = 'metadata'
    el.src = encodeMediaPath(this.path)

    // A codec the engine does not have fails silently otherwise: the element
    // sits there with a dead transport bar and says nothing about why. The
    // extension lists in `shared/media.ts` are meant to keep this unreachable,
    // so anything landing here is a format that got past them.
    el.addEventListener('error', () => {
      if (this.disposed) return
      this.body.replaceChildren()
      const problem = document.createElement('div')
      problem.className = 'reader-error'
      problem.textContent =
        `This ${kind} file could not be played — the format is one this engine has no ` +
        'decoder for. “Open in editor” hands it to the system player.'
      this.body.appendChild(problem)
    })

    this.body.appendChild(el)
    this.media = el
  }

  /**
   * Stopping playback, not merely detaching the element.
   *
   * A detached `<video>` keeps playing. You close the tab, the picture goes,
   * and the sound carries on with nothing on screen to pause — so the source is
   * dropped and `load()` called to make the element let go of it.
   */
  private teardownMedia(): void {
    const el = this.media
    if (!el) return
    this.media = null
    el.pause()
    el.removeAttribute('src')
    el.load()
    el.remove()
  }

  dispose(): void {
    this.disposed = true
    // Whoever mounted the pane drops its element, and for ordinary DOM that is
    // the end of it. The viewer is the exception, and the reason it is worth a
    // line here: an element merely detached still owns everything described in
    // `teardownDocument`.
    this.teardownDocument()
    this.teardownMedia()
  }
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN.test(path)
}
