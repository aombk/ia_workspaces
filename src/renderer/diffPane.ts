/**
 * What has changed in this workspace since the last commit.
 *
 * The question you have most often once an agent has been editing is "what did
 * it just do to my repo", and answering it currently means typing `git diff`
 * and losing your prompt. This is that, standing still.
 *
 * Read-only. Staging and committing are deliberately absent: they are
 * destructive-ish operations with a lot of edge cases (partial hunks,
 * conflicts, submodules) and you already have a shell right there.
 */
import { backend } from '../backend'
import { fallbackCwd } from '../shared/platform'
import { remoteHostOfPane, store } from './state'
import type { AuxPane } from './auxPane'

/** How often the file list is re-read while the pane is visible. */
const POLL_MS = 2500

interface ChangedFile {
  path: string
  /** Git's short status letter: M, A, D, R, ? for untracked. */
  status: string
}

export class DiffPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly diffEl: HTMLDivElement
  private readonly headEl: HTMLDivElement
  private files: ChangedFile[] = []
  private selected: string | null = null
  private signature = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Bumped per request so a slow diff can't overwrite a newer one. */
  private token = 0
  private aboutEl: HTMLElement | null = null

  constructor(
    readonly paneId: string,
    private cwd: string
  ) {
    this.element = document.createElement('div')
    this.element.className = 'diff-pane'

    this.headEl = document.createElement('div')
    this.headEl.className = 'diff-head'
    this.element.appendChild(this.headEl)

    // What this pane is and what it is pointed at. Without it "Changes" is a
    // word with no subject — the first question is always "changes to what".
    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent = `Uncommitted changes in ${cwd} — everything different from the last commit (git HEAD)`
    about.title = cwd
    this.aboutEl = about
    this.element.appendChild(about)

    const split = document.createElement('div')
    split.className = 'diff-split'

    this.listEl = document.createElement('div')
    this.listEl.className = 'diff-files'
    split.appendChild(this.listEl)

    this.diffEl = document.createElement('div')
    this.diffEl.className = 'diff-body'
    split.appendChild(this.diffEl)

    this.element.appendChild(split)

    void this.refresh()
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS)
    window.addEventListener('focus', this.onFocus)
  }

  private readonly onFocus = () => void this.refresh()

  /**
   * Says whose machine this workspace is on, instead of listing the wrong files.
   *
   * Deliberately names the host rather than saying "not supported": the pane is
   * working correctly and the answer is simply somewhere this process cannot
   * reach, and knowing which machine is what tells you to go and run `git` in
   * the terminal beside it.
   */
  private showRemoteNotice(host: string): void {
    this.listEl.replaceChildren()
    this.diffEl.replaceChildren()
    if (this.aboutEl) {
      this.aboutEl.textContent = `This workspace runs its shells on ${host}`
      this.aboutEl.title = host
    }
    const note = document.createElement('div')
    note.className = 'diff-empty'
    note.textContent = `Changes are read from this machine, and this workspace's folder is on ${host}. Run git in the terminal beside this pane.`
    this.diffEl.appendChild(note)
  }

  /**
   * Follows the workspace's folder when it moves.
   *
   * "Change folder…" can move the root under an open pane, and a pane still
   * diffing the folder it was opened in would be quietly answering a question
   * about somewhere else.
   */
  sync(): void {
    const root = diffRoot(this.paneId)
    if (root === this.cwd || this.disposed) return
    this.cwd = root
    this.selected = null
    this.signature = ''
    if (this.aboutEl) {
      this.aboutEl.textContent = `Uncommitted changes in ${root} — everything different from the last commit (git HEAD)`
      this.aboutEl.title = root
    }
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    if (this.disposed || document.hidden) return

    // An SSH workspace's folder is a path on the far machine, and `git` here
    // would either fail or — worse — answer about a directory of the same name
    // that happens to exist locally. Saying so is the only honest option:
    // running git over the connection would need a second, remote
    // implementation of this whole pane.
    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      this.showRemoteNotice(remote)
      return
    }

    let status: Record<string, string>
    try {
      status = await backend().gitStatus(this.cwd)
    } catch {
      return
    }
    if (this.disposed) return

    // gitStatus marks ancestor folders with "·" so the tree can show a change
    // inside a collapsed branch. Those are not files and have no diff.
    const files: ChangedFile[] = Object.entries(status)
      .filter(([, letter]) => letter !== '·')
      .map(([path, letter]) => ({ path, status: letter }))
      .sort((a, b) => a.path.localeCompare(b.path))

    const signature = files.map((f) => `${f.status}${f.path}`).join('\n')
    if (signature === this.signature) return
    this.signature = signature
    this.files = files

    // A file that stopped being changed should not leave its diff on screen.
    if (this.selected && !files.some((f) => f.path === this.selected)) this.selected = null
    this.render()
    void this.loadDiff()
  }

  private render(): void {
    this.headEl.replaceChildren()
    const title = document.createElement('span')
    title.className = 'diff-title'
    title.textContent = this.files.length
      ? `${this.files.length} changed file${this.files.length === 1 ? '' : 's'}`
      : 'No changes'
    this.headEl.appendChild(title)

    const all = document.createElement('button')
    all.className = 'diff-btn' + (this.selected === null ? ' active' : '')
    all.textContent = 'Everything'
    all.addEventListener('click', () => {
      this.selected = null
      this.render()
      void this.loadDiff()
    })
    this.headEl.appendChild(all)

    this.listEl.replaceChildren()
    for (const file of this.files) {
      const row = document.createElement('button')
      row.className = 'diff-file' + (file.path === this.selected ? ' active' : '')
      row.title = file.path

      const letter = document.createElement('span')
      letter.className = `diff-status diff-status--${file.status === '?' ? 'new' : file.status.toLowerCase()}`
      letter.textContent = file.status
      row.appendChild(letter)

      const name = document.createElement('span')
      name.className = 'diff-file__name'
      name.textContent = relative(this.cwd, file.path)
      row.appendChild(name)

      row.addEventListener('click', () => {
        this.selected = file.path
        this.render()
        void this.loadDiff()
      })
      this.listEl.appendChild(row)
    }
  }

  private async loadDiff(): Promise<void> {
    const token = ++this.token
    const file = this.files.find((f) => f.path === this.selected)
    this.diffEl.replaceChildren()

    if (!this.files.length) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent = `Nothing has changed in ${this.cwd} since the last commit.`
      this.diffEl.appendChild(empty)
      return
    }

    let text: string
    try {
      text = await backend().gitDiff(
        this.cwd,
        file ? relative(this.cwd, file.path).replace(/\\/g, '/') : '',
        file?.status === '?'
      )
    } catch (err) {
      if (token !== this.token || this.disposed) return
      const problem = document.createElement('div')
      problem.className = 'diff-empty'
      problem.textContent = err instanceof Error ? err.message : String(err)
      this.diffEl.replaceChildren(problem)
      return
    }
    if (token !== this.token || this.disposed) return

    this.diffEl.replaceChildren()
    if (!text.trim()) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      // Untracked files show nothing against HEAD, and "Everything" cannot
      // include them — say so rather than looking broken.
      empty.textContent = file
        ? 'Nothing to show for this file.'
        : 'No tracked changes. Untracked files are listed; pick one to see it.'
      this.diffEl.appendChild(empty)
      return
    }

    const pre = document.createElement('pre')
    pre.className = 'diff-text'
    for (const line of text.split('\n')) {
      const span = document.createElement('span')
      span.className = `diff-line diff-line--${classify(line)}`
      // textContent, always: this is the content of files we did not write.
      span.textContent = line || ' '
      pre.appendChild(span)
    }
    this.diffEl.appendChild(pre)
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    window.removeEventListener('focus', this.onFocus)
  }
}

/** Which colour a diff line gets. Order matters: `+++` is a header, not an add. */
export function classify(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function relative(root: string, full: string): string {
  const prefix = root.endsWith('\\') ? root : `${root}\\`
  return full.startsWith(prefix) ? full.slice(prefix.length) : full
}

/** The workspace folder a diff pane should watch. */
export function diffRoot(paneId: string): string {
  return (
    store.workspaceOfPane(paneId)?.cwd ??
    store.pane(paneId)?.cwd ??
    fallbackCwd(backend().capabilities.platform)
  )
}

/** The same root, under the name the search pane reads it by. */
export const searchRoot = diffRoot
