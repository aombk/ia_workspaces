/**
 * Find a string anywhere in the workspace, and jump to where it is.
 *
 * A tab of its own: results are something you work *from* — read one, go and
 * look, come back to the next — and they need the room. It was briefly a
 * footer on the file tree, which answered "where is it searching" at the cost
 * of making the results a letterbox.
 *
 * The folder is stated in the pane instead, since "search" with nothing
 * attached is a question missing its subject.
 */
import { backend } from '../backend'
import { pathSeparator } from '../shared/platform'
import type { AuxPane } from './auxPane'
import { searchRoot } from './git/common'
import { remoteHostOfPane } from './state'
import type { SearchHit } from '../shared/types'

export interface SearchPaneHooks {
  /** Show a hit's file, read-only, beside this pane. */
  openHit(path: string): void
  /** Hand a hit's file to the configured editor. */
  openInEditor(path: string): void
}

/** How long after the last keystroke the search actually runs. */
const DEBOUNCE_MS = 250

export class SearchPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly input: HTMLInputElement
  private readonly caseButton: HTMLButtonElement
  private readonly status: HTMLSpanElement
  private aboutEl: HTMLElement | null = null
  private readonly list: HTMLDivElement
  private caseSensitive = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Bumped per search so a slow one cannot overwrite a newer one. */
  private token = 0
  private disposed = false

  constructor(
    readonly paneId: string,
    private cwd: string,
    private readonly hooks: SearchPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'search-pane'

    const head = document.createElement('div')
    head.className = 'search-head'

    this.input = document.createElement('input')
    this.input.className = 'search-input'
    this.input.type = 'text'
    this.input.placeholder = 'Find…'
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.schedule())
    this.input.addEventListener('keydown', (e) => {
      // Enter re-runs now rather than waiting out the debounce.
      if (e.key === 'Enter') {
        e.preventDefault()
        this.run()
      }
    })
    head.appendChild(this.input)

    this.caseButton = document.createElement('button')
    this.caseButton.className = 'search-toggle'
    this.caseButton.textContent = 'Aa'
    this.caseButton.title = 'Match case'
    this.caseButton.addEventListener('click', () => {
      this.caseSensitive = !this.caseSensitive
      this.caseButton.classList.toggle('active', this.caseSensitive)
      this.run()
    })
    head.appendChild(this.caseButton)

    this.element.appendChild(head)

    // The root, stated plainly. The placeholder only has room for the folder's
    // last name, and a tooltip is not an answer to "where am I searching".
    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent = `Searching every file under ${cwd}`
    about.title = cwd
    this.aboutEl = about
    this.element.appendChild(about)

    const statusRow = document.createElement('div')
    statusRow.className = 'search-status'
    this.status = document.createElement('span')
    statusRow.appendChild(this.status)
    this.element.appendChild(statusRow)

    this.list = document.createElement('div')
    this.list.className = 'search-results'
    this.element.appendChild(this.list)

    this.setIdleStatus()
    // A search tab you just opened should be ready to type into.
    queueMicrotask(() => this.input.focus())
  }

  /**
   * Follows the workspace's folder when it moves.
   *
   * "Change folder…" can move the root under an open pane, and a pane still
   * searching where it was opened would quietly be answering about somewhere
   * else.
   */
  sync(): void {
    this.setRoot(searchRoot(this.paneId))
  }

  /** Re-roots the search, for a workspace whose folder changed under it. */
  setRoot(cwd: string): void {
    if (cwd === this.cwd) return
    this.cwd = cwd
    if (this.aboutEl) {
      this.aboutEl.textContent = `Searching every file under ${cwd}`
      this.aboutEl.title = cwd
    }
    this.list.replaceChildren()
    this.setIdleStatus()
  }

  /**
   * Says where it is searching, which is the first thing you need to know and
   * the one thing a bare "type to search" box does not tell you.
   */
  private setIdleStatus(): void {
    this.status.textContent =
      'Type to search. Matches are literal text, not patterns; .gitignore is respected.'
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(), DEBOUNCE_MS)
  }

  private async run(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const query = this.input.value
    const token = ++this.token

    // Search reads this machine's filesystem. An SSH workspace's folder is on
    // another one, so there is nothing here to search — and searching a local
    // directory that happens to share the path would be worse than saying so.
    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      this.list.replaceChildren()
      this.status.textContent = `This workspace's files are on ${remote}. Use grep or ripgrep in the terminal beside this pane.`
      return
    }

    if (!query.trim()) {
      this.list.replaceChildren()
      this.setIdleStatus()
      return
    }

    this.status.textContent = 'Searching…'
    let hits: SearchHit[]
    try {
      hits = await backend().search(this.cwd, query, this.caseSensitive)
    } catch (err) {
      if (token !== this.token || this.disposed) return
      this.list.replaceChildren()
      this.status.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    if (token !== this.token || this.disposed) return

    this.status.textContent = hits.length
      ? `${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length >= 500 ? ' (capped)' : ''}`
      : 'No matches.'
    this.render(hits, query)
  }

  private render(hits: SearchHit[], query: string): void {
    this.list.replaceChildren()

    // Grouped by file: twenty hits in one file is one thing you found, not
    // twenty, and a flat list buries the other files it is also in.
    const byFile = new Map<string, SearchHit[]>()
    for (const hit of hits) {
      const bucket = byFile.get(hit.path)
      if (bucket) bucket.push(hit)
      else byFile.set(hit.path, [hit])
    }

    for (const [path, fileHits] of byFile) {
      const group = document.createElement('div')
      group.className = 'search-group'

      const header = document.createElement('button')
      header.className = 'search-file'
      header.title = `${path}\nClick to open, right-click for more`
      const name = document.createElement('span')
      name.className = 'search-file__name'
      name.textContent = relative(this.cwd, path)
      header.appendChild(name)
      const count = document.createElement('span')
      count.className = 'search-file__count'
      count.textContent = String(fileHits.length)
      header.appendChild(count)
      header.addEventListener('click', () => this.hooks.openHit(path))
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        this.hooks.openInEditor(path)
      })
      group.appendChild(header)

      for (const hit of fileHits) {
        const row = document.createElement('button')
        row.className = 'search-hit'
        row.addEventListener('click', () => this.hooks.openHit(hit.path))

        const number = document.createElement('span')
        number.className = 'search-hit__line'
        number.textContent = String(hit.line)
        row.appendChild(number)

        const text = document.createElement('span')
        text.className = 'search-hit__text'
        // Built from text nodes with the match wrapped — the line is file
        // content, so it may contain anything at all.
        appendHighlighted(text, hit.text, query, this.caseSensitive)
        row.appendChild(text)

        group.appendChild(row)
      }
      this.list.appendChild(group)
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

/** Splits `line` around every occurrence of `query`, marking the matches. */
function appendHighlighted(
  host: HTMLElement,
  line: string,
  query: string,
  caseSensitive: boolean
): void {
  const haystack = caseSensitive ? line : line.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  if (!needle) {
    host.textContent = line
    return
  }

  let at = 0
  for (;;) {
    const found = haystack.indexOf(needle, at)
    if (found === -1) break
    if (found > at) host.appendChild(document.createTextNode(line.slice(at, found)))
    const mark = document.createElement('mark')
    mark.textContent = line.slice(found, found + needle.length)
    host.appendChild(mark)
    at = found + needle.length
  }
  if (at < line.length) host.appendChild(document.createTextNode(line.slice(at)))
}

function relative(root: string, full: string): string {
  const sep = pathSeparator(backend().capabilities.platform)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return full.startsWith(prefix) ? full.slice(prefix.length) : full
}
