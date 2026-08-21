import { backend } from '../backend'
import { quotePath, startDrag } from './ui/fileDrag'
import {
  parentDir,
  parseUserPath,
  pathAncestors,
  pathSeparator,
  samePath,
  trashName,
} from '../shared/platform'
import { showContextMenu, type MenuEntry, type MenuItem } from './ui/contextMenu'
import { confirmDialog } from './ui/confirm'
import { attachInlineEditor } from './ui/editing'
import { copyText } from './ui/clipboard'
import { showToast } from './ui/toast'
import { remoteHostOfPane, store } from './state'
import { sortEntries } from '../shared/images'
import type { FileEntry, GitStatusMap, Settings } from '../shared/types'

/**
 * The file tree pane.
 *
 * Deliberately not a full file manager. It exists to sit beside your shells:
 * see the project, open a terminal anywhere in it, and drag a path into a
 * running command. Anything Explorer already does well stays one "Reveal in
 * Explorer" away.
 */

export interface FilesPaneHooks {
  /** Open a shell rooted at this folder, as a split beside the tree. */
  openTerminalAt(cwd: string): void
  /** Insert text at the active shell's cursor — used by drag-to-pane. */
  sendToActiveTerminal(text: string): void
  /** Persist the folder the tree is showing. */
  onNavigate(paneId: string, cwd: string): void
  /**
   * The folder the tree was standing in was renamed on disk. Distinct from
   * navigating: the same folder is still open, under a new path, so anything
   * else pointing at the old one is now pointing at nothing.
   */
  onRootRenamed?(from: string, to: string): void
  /**
   * The folder the tree was standing in was deleted, and the tree has fallen
   * back to `parent`. Anything still pointing inside `path` is pointing at
   * something that is no longer there.
   */
  onRootDeleted?(path: string, parent: string): void
  /**
   * Make a folder the workspace's root — the other half of "Change folder…",
   * for a folder you are already looking at rather than one you go and find in
   * a picker.
   *
   * Optional, and with it the menu item: only the docked tree belongs to a
   * workspace. A file pane sitting in a split has no root to set.
   */
  setWorkspaceRoot?(folder: string): void
  /** The workspace's root, so the menu can grey out setting it to itself. */
  workspaceRoot?(): string
  /** Show a file read-only in a pane beside the tree. */
  openReader(path: string): void
  /** Open a file in an editor tab, to change it. */
  openEditorTab(path: string): void
  /** Hand a file to the editor named in settings. */
  openInEditor(path: string): void
  /**
   * The highlighted row changed, or was cleared ('').
   *
   * Optional, because most trees have nobody listening. Fires on the highlight
   * rather than on opening anything: selecting a file is a glance, and the pane
   * that reads this shows what you are glancing at.
   */
  onSelect?(paneId: string, path: string, isDir: boolean): void
}

/**
 * What was cut or copied, shared by every tree in the app.
 *
 * Module state rather than per-pane, because the whole point is to copy in one
 * tree and paste in another — a clipboard that only worked within one pane
 * would be a worse version of drag and drop.
 *
 * Not the system clipboard. Reading a file list from it needs a raw `CF_HDROP`
 * on Windows and its own format on every other platform, none of which Electron
 * exposes; writing one is worse. So this moves files between trees, and
 * Explorer stays one "Reveal in Explorer" away for anything crossing the
 * boundary.
 */
let clipboard: { paths: string[]; mode: 'copy' | 'cut' } | null = null

/**
 * Re-reads every open tree.
 *
 * For something outside the tree changing a file on disk — the images pane
 * deleting or renaming one. The trees do poll, so this is only about the delay:
 * a file you just deleted should leave the tree now, not in a couple of seconds.
 *
 * A function rather than the caller reaching for the registry, which is private
 * and stays that way: "refresh yourselves" is the whole of what anyone outside
 * needs, and handing out the set would let them do considerably more.
 */
export function refreshAllTrees(): void {
  FilesPane.refreshAll()
}

/**
 * The drag type a tree row carries.
 *
 * Re-exported rather than defined here now that a drag can also leave as a real
 * operating-system file — the type, the mode and the reading of a drop are one
 * decision and live together in `ui/fileDrag.ts`.
 */
export { FILE_DRAG } from './ui/fileDrag'

interface Row {
  entry: FileEntry
  depth: number
  /** True when this is the last child of its parent — draws the ┗ elbow. */
  last: boolean
  /**
   * For each ancestor level, whether a vertical guide should continue past
   * this row. Without it, guides run through the gap under a finished branch.
   */
  guides: boolean[]
}

export class FilesPane {
  readonly element: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly crumbEl: HTMLDivElement
  private readonly pathInput: HTMLInputElement
  private readonly filterInput: HTMLInputElement
  private readonly filterClear: HTMLButtonElement

  private cwd: string
  private showHidden = true
  private filter = ''
  private expanded = new Set<string>()
  private children = new Map<string, FileEntry[]>()
  private status: GitStatusMap = {}
  /**
   * The lead row — the one a plain click landed on.
   *
   * Kept alongside the set because several things want *one* path rather than
   * all of them: the images pane follows it, rename needs exactly one, and a
   * shift-click measures its range from here.
   */
  private selected: string | null = null
  /** Everything highlighted. Always contains `selected` when that is set. */
  private selection = new Set<string>()
  /** Where a shift-click range starts. Moved by every plain or ctrl click. */
  private anchor: string | null = null
  /** Just-pasted paths to highlight as soon as the listing shows them. */
  private pendingSelect: string[] = []
  private renaming: string | null = null
  private renamingRoot = false
  private creatingIn: string | null = null
  /** Whether the pending create makes a file or a folder. */
  private creatingKind: 'file' | 'dir' = 'dir'
  private disposed = false
  /** Discards results from a refresh the user has already navigated away from. */
  private token = 0
  /** Live rows by path, so selection can move without a re-render. */
  private rowEls = new Map<string, HTMLElement>()
  /** What the folders on screen looked like last time, so a poll can no-op. */
  private signature = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private readonly onWindowFocus = () => void this.refresh()

  /** Every tree on screen, so a column switch reaches all of them at once. */
  private static readonly live = new Set<FilesPane>()

  constructor(
    private readonly paneId: string,
    cwd: string,
    private readonly hooks: FilesPaneHooks
  ) {
    this.cwd = cwd

    this.element = document.createElement('div')
    this.element.className = 'pane files-pane'
    this.element.dataset.paneId = paneId

    // ---- toolbar
    const head = document.createElement('div')
    head.className = 'files-head'

    head.appendChild(this.iconButton('↑', 'Parent folder', () => this.navigate(parentOf(this.cwd))))

    this.crumbEl = document.createElement('div')
    this.crumbEl.className = 'files-crumbs'
    this.crumbEl.title = 'Click to edit the path'
    // Clicking the blank part of the bar switches to a typable path.
    this.crumbEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.files-crumb')) return
      this.beginPathEdit()
    })
    head.appendChild(this.crumbEl)

    this.pathInput = document.createElement('input')
    this.pathInput.className = 'files-path-input'
    this.pathInput.spellcheck = false
    this.pathInput.hidden = true
    head.appendChild(this.pathInput)

    head.appendChild(this.iconButton('✎', 'Edit path', () => this.beginPathEdit()))
    head.appendChild(this.iconButton('⟳', 'Refresh', () => void this.refresh()))
    this.element.appendChild(head)

    // ---- filter
    const filterRow = document.createElement('div')
    filterRow.className = 'files-filter'
    this.filterInput = document.createElement('input')
    this.filterInput.type = 'text'
    this.filterInput.placeholder = 'Filter…'
    this.filterInput.spellcheck = false
    this.filterInput.addEventListener('input', () => {
      this.filter = this.filterInput.value.trim().toLowerCase()
      this.syncFilterClear()
      this.render()
    })
    this.filterInput.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Escape') this.clearFilter()
    })
    filterRow.appendChild(this.filterInput)

    // Escape already clears it, but only once the field has focus — and a
    // filter you set a while ago is exactly the one you have stopped looking
    // at. The button says a filter is on as much as it offers to remove it,
    // which is why it is absent rather than greyed out when there isn't one.
    this.filterClear = document.createElement('button')
    this.filterClear.className = 'files-filter-clear'
    this.filterClear.textContent = '✕'
    this.filterClear.title = 'Clear filter (Esc)'
    this.filterClear.hidden = true
    this.filterClear.addEventListener('click', () => this.clearFilter())
    filterRow.appendChild(this.filterClear)

    this.element.appendChild(filterRow)

    this.listEl = document.createElement('div')
    this.listEl.className = 'files-list'
    // Focusable so the tree can have shortcuts of its own. -1 keeps it out of
    // the tab order — this is a pane, not a form control — and clicking a row
    // focuses it, which is when Ctrl+C should mean "copy this file" rather than
    // whatever the focused terminal thinks.
    this.listEl.tabIndex = -1
    this.listEl.addEventListener('keydown', (e) => this.onKeyDown(e))
    this.element.appendChild(this.listEl)


    this.element.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.files-row')) return
      e.preventDefault()
      this.openBackgroundMenu(e.clientX, e.clientY)
    })

    // Changes made anywhere else — a build, a git checkout, the shell in the
    // pane next door — should appear without anyone reaching for ⟳.
    this.pollTimer = setInterval(() => void this.poll(), POLL_MS)
    window.addEventListener('focus', this.onWindowFocus)
    FilesPane.live.add(this)

    void this.refresh()
  }

  /** Drops the filter and puts the cursor back where you were typing. */
  private clearFilter(): void {
    if (!this.filterInput.value) return
    this.filterInput.value = ''
    this.filter = ''
    this.syncFilterClear()
    this.render()
    this.filterInput.focus()
  }

  private syncFilterClear(): void {
    this.filterClear.hidden = this.filterInput.value === ''
  }

  get directory(): string {
    return this.cwd
  }

  // ----------------------------------------------------------------- columns

  /** Whether any column beyond the name is on. */
  private get detailed(): boolean {
    return store.settings.treeShowSize || store.settings.treeShowModified
  }

  /**
   * Turns a column on or off everywhere.
   *
   * The switch is in one tree's menu, but the choice belongs to the app: two
   * trees side by side showing different columns reads as one of them being
   * broken. Re-read rather than re-drawn, because a size or a time that was
   * cached before anyone was looking at it is exactly the stale number the
   * column was turned on to see.
   */
  /** Re-reads every open tree. See `refreshAllTrees`. */
  static refreshAll(): void {
    for (const pane of FilesPane.live) void pane.refresh()
  }

  private setColumns(
    patch: Partial<
      Pick<Settings, 'treeShowSize' | 'treeShowModified' | 'treeSort' | 'treeSortDesc'>
    >
  ): void {
    store.updateSettings(patch)
    FilesPane.refreshAll()
  }

  private iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'files-btn'
    b.textContent = glyph
    b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  // ------------------------------------------------------------ navigation

  navigate(dir: string): void {
    if (!dir || dir === this.cwd) return
    this.cwd = dir
    this.expanded.clear()
    this.children.clear()
    // Through `select` rather than assigned, so anything watching hears the
    // selection go. Assigning directly would leave the images pane filled from
    // a folder you have just navigated away from.
    this.select(null)
    this.hooks.onNavigate(this.paneId, dir)
    void this.refresh()
  }

  /** Turns the breadcrumb bar into an editable path field. */
  private beginPathEdit(): void {
    this.crumbEl.hidden = true
    this.pathInput.hidden = false
    this.pathInput.value = this.cwd

    attachInlineEditor(this.pathInput, {
      onCommit: async (value) => {
        this.pathInput.hidden = true
        this.crumbEl.hidden = false
        // Asked for only when there is a `~` to expand: it is one IPC round
        // trip, and every other paste is already a path.
        const home = value.trim().startsWith('~') ? await backend().homeDir() : ''
        const target = parseUserPath(backend().capabilities.platform, value, home)
        if (!target || target === this.cwd) return
        if (await backend().isDirectory(target)) this.navigate(target)
        else showToast('No such folder', target, { kind: 'warn' })
      },
      onCancel: () => {
        this.pathInput.hidden = true
        this.crumbEl.hidden = false
      },
    })
  }

  /**
   * Says whose machine this workspace is on, instead of listing the wrong disk.
   *
   * Names the host rather than saying "unsupported": the tree is working
   * correctly and the files are simply somewhere this process cannot see, and
   * knowing which machine is what sends you to the terminal beside it.
   */
  private showRemoteNotice(host: string): void {
    this.listEl.replaceChildren()
    const note = document.createElement('div')
    note.className = 'files-empty'
    note.textContent = `This workspace's files are on ${host}. The tree reads this machine only — use ls in the terminal beside this pane.`
    this.listEl.appendChild(note)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const token = ++this.token

    // The tree reads this machine's filesystem, and an SSH workspace's folder
    // is on another one. Listing whatever sits at the same path here would be
    // actively misleading — you would be looking at your own disk believing it
    // was the server's.
    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      this.showRemoteNotice(remote)
      return
    }

    try {
      // Every expanded folder is re-read alongside the root rather than in
      // sequence — one slow directory shouldn't hold up all the others.
      const dirs = [this.cwd, ...this.expanded]
      const [listings, status] = await Promise.all([
        Promise.all(
          dirs.map((dir) =>
            backend()
              .readDir(dir, this.showHidden)
              .then((entries) => ({ dir, entries }))
              .catch(() => ({ dir, entries: null }))
          )
        ),
        this.loadStatus(),
      ])
      if (token !== this.token || this.disposed) return

      for (const { dir, entries } of listings) {
        if (entries) this.children.set(dir, entries)
        else if (dir !== this.cwd) this.expanded.delete(dir)
        else throw new Error(`Cannot read ${dir}`)
      }
      this.status = status
      this.signature = signatureOf(listings, this.detailed)

      this.render()
    } catch (err) {
      if (token !== this.token || this.disposed) return
      this.signature = ''
      this.renderError(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Re-reads the folders on screen and refreshes only when one of them has
   * actually changed.
   *
   * Polled rather than watched: a real filesystem watcher would have to be
   * written three times over — Node, Rust and Go — and pushed through each
   * runtime's IPC, and re-listing a handful of already-open directories is
   * cheap by comparison. Git status is deliberately left out of the comparison
   * so a file being saved doesn't spawn `git status` every couple of seconds;
   * bringing the window forward picks that up instead.
   */
  private async poll(): Promise<void> {
    if (!this.canPoll()) return

    const dirs = [this.cwd, ...this.expanded]
    const listings = await Promise.all(
      dirs.map((dir) =>
        backend()
          .readDir(dir, this.showHidden)
          .then((entries) => ({ dir, entries }))
          .catch(() => ({ dir, entries: null as FileEntry[] | null }))
      )
    )

    // The user may have started typing, or navigated, while we were reading.
    if (!this.canPoll() || dirs[0] !== this.cwd) return
    if (signatureOf(listings, this.detailed) === this.signature) return
    await this.refresh()
  }

  /** Polling must never fight the user or run for a pane nobody can see. */
  private canPoll(): boolean {
    if (this.disposed || document.hidden) return false
    if (this.renaming || this.renamingRoot || this.creatingIn !== null) return false
    return this.element.checkVisibility()
  }

  /**
   * Git status costs a process spawn, so a folder that turned out not to be a
   * repository is remembered and not asked about again while we stay there.
   */
  private async loadStatus(): Promise<GitStatusMap> {
    if (FilesPane.nonRepos.has(this.cwd)) return {}
    const status = await backend().gitStatus(this.cwd)
    if (!Object.keys(status).length) FilesPane.nonRepos.add(this.cwd)
    return status
  }

  private static readonly nonRepos = new Set<string>()

  private async toggle(entry: FileEntry): Promise<void> {
    if (this.expanded.has(entry.path)) {
      this.expanded.delete(entry.path)
      this.render()
      return
    }
    try {
      const sub = await backend().readDir(entry.path, this.showHidden)
      this.children.set(entry.path, sub)
      this.expanded.add(entry.path)
      this.render()
    } catch {
      showToast('Cannot open folder', entry.name, { kind: 'warn' })
    }
  }

  // ---------------------------------------------------------------- rendering

  /**
   * One folder's rows, filtered and ordered.
   *
   * The single place either happens, so the root and every expanded folder are
   * necessarily consistent — a tree with one folder sorted by name and the one
   * below it by date would be unreadable. `readDirectory` already returns
   * name-ascending with folders first, which is what the default costs nothing
   * to reproduce.
   */
  private visibleChildren(dir: string): FileEntry[] {
    const all = this.children.get(dir) ?? []
    const matching = this.filter
      ? // A folder stays visible when something inside it matches, so filtering
        // never hides the path to a hit.
        all.filter(
          (e) =>
            e.name.toLowerCase().includes(this.filter) || (e.isDir && this.subtreeMatches(e.path))
        )
      : all
    const { treeSort, treeSortDesc } = store.settings
    if (treeSort === 'name' && !treeSortDesc) return matching
    return sortEntries(matching, treeSort, treeSortDesc)
  }

  private subtreeMatches(dir: string): boolean {
    const kids = this.children.get(dir)
    if (!kids) return false
    return kids.some(
      (e) => e.name.toLowerCase().includes(this.filter) || (e.isDir && this.subtreeMatches(e.path))
    )
  }

  private rows(): Row[] {
    const out: Row[] = []
    const walk = (dir: string, depth: number, guides: boolean[]) => {
      const kids = this.visibleChildren(dir)
      kids.forEach((entry, index) => {
        const last = index === kids.length - 1
        out.push({ entry, depth, last, guides: [...guides] })
        if (entry.isDir && this.expanded.has(entry.path)) {
          walk(entry.path, depth + 1, [...guides, !last])
        }
      })
    }
    // Depth 1, because the current folder is drawn as the tree's root row and
    // everything below it hangs off that.
    walk(this.cwd, 1, [])
    return out
  }

  private render(): void {
    this.renderCrumbs()
    // A background refresh must not throw the reader back to the top.
    const scroll = this.listEl.scrollTop
    this.listEl.replaceChildren()
    this.rowEls.clear()

    this.listEl.appendChild(this.renderRootRow())

    const rows = this.rows()
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'files-empty'
      empty.textContent = this.filter ? 'Nothing matches' : 'Empty folder'
      this.listEl.appendChild(empty)
    } else {
      for (const row of rows) this.listEl.appendChild(this.renderRow(row))
    }

    // The "new folder" editor lives at the end of whichever folder it targets.
    if (this.creatingIn !== null) this.listEl.appendChild(this.renderNewFolderRow())

    this.listEl.scrollTop = scroll

    // A pasted file is selected once it appears. Claimed here rather than in
    // `paste` because the listing it has to be found in is read asynchronously,
    // so at the time of the paste there is no row to select yet — and it may
    // arrive in a tree other than the one that pasted it.
    if (this.pendingSelect.length) {
      const arrived = this.pendingSelect.filter((p) => this.rowEls.has(p))
      if (arrived.length === this.pendingSelect.length) {
        this.pendingSelect = []
        this.anchor = arrived[0] ?? null
        this.setSelection(arrived, arrived.length === 1 ? arrived[0] : null)
        this.rowEls.get(arrived[0])?.scrollIntoView({ block: 'nearest' })
      }
    }
  }

  /** The current folder, drawn as the trunk everything else branches from. */
  private renderRootRow(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'files-row files-root'
    row.title = this.cwd

    if (this.renamingRoot) {
      const input = document.createElement('input')
      input.className = 'files-rename-input'
      input.value = folderLeaf(this.cwd)
      input.spellcheck = false
      row.appendChild(input)

      attachInlineEditor(input, {
        onCommit: async (value) => {
          this.renamingRoot = false
          if (value.trim() && value !== folderLeaf(this.cwd)) await this.renameRoot(value)
          else this.render()
        },
        onCancel: () => {
          this.renamingRoot = false
          this.render()
        },
      })
      return row
    }

    const name = document.createElement('span')
    name.className = 'files-name'
    name.textContent = folderLeaf(this.cwd) + pathSeparator(backend().capabilities.platform)
    row.appendChild(name)

    row.addEventListener('click', (e) => {
      if (e.detail >= 2) this.navigate(parentOf(this.cwd))
    })
    // Without this the pane's own handler sees a .files-row and stands down,
    // and the right-click falls through to the host's browser menu.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.openRootMenu(e.clientX, e.clientY)
    })
    return row
  }

  /**
   * Moves the highlight without rebuilding the list.
   *
   * Selecting used to re-render, which threw away the very row the pointer was
   * interacting with — see the click handler below.
   */
  private select(path: string | null, isDir = false): void {
    this.setSelection(path ? [path] : [], path, isDir)
  }

  /**
   * Replaces the whole selection, without rebuilding the list.
   *
   * Classes are moved rather than re-rendered because clicking a row re-renders
   * away the very element the pointer is interacting with — the same reason the
   * click handler reads its own detail count instead of listening for
   * `dblclick`.
   */
  private setSelection(paths: readonly string[], lead: string | null, isDir = false): void {
    for (const path of this.selection) this.rowEls.get(path)?.classList.remove('selected')
    this.selection = new Set(paths)
    for (const path of this.selection) this.rowEls.get(path)?.classList.add('selected')

    const nextLead = lead ?? null
    const changed = nextLead !== this.selected
    this.selected = nextLead
    if (!changed) return

    // Told outward as well as drawn: the images pane shows whatever is selected
    // here, which is the one thing in the app that reads this. `isDir` travels
    // with it because selecting a folder is a meaningful thing to do there —
    // the gallery fills with that folder — and only the tree knows which rows
    // are folders. Only the lead is reported: a gallery can show one image or
    // one folder, and has nothing to say about five.
    this.hooks.onSelect?.(this.paneId, nextLead ?? '', isDir)
  }

  /**
   * What a click means, given its modifiers.
   *
   * The three gestures every file manager has, and they are worth naming: plain
   * replaces, `Ctrl` toggles one, `Shift` takes everything between the anchor
   * and here. The anchor moves on the first two and deliberately does not on
   * the third, so a run of shift-clicks keeps growing the same range rather
   * than measuring from wherever it last landed.
   */
  private clickSelect(entry: FileEntry, e: MouseEvent): void {
    if (e.shiftKey && this.anchor) {
      this.setSelection(this.rangeTo(entry.path), entry.path, entry.isDir)
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(this.selection)
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      this.anchor = entry.path
      // Removing the lead leaves the set without one rather than picking an
      // arbitrary survivor: nothing downstream wants a lead nobody chose.
      const lead = next.has(entry.path) ? entry.path : null
      this.setSelection([...next], lead, entry.isDir)
      return
    }
    this.anchor = entry.path
    this.setSelection([entry.path], entry.path, entry.isDir)
  }

  /** Every visible row between the anchor and `path`, inclusive. */
  private rangeTo(path: string): string[] {
    const order = this.rows().map((r) => r.entry.path)
    const from = order.indexOf(this.anchor ?? '')
    const to = order.indexOf(path)
    if (from === -1 || to === -1) return [path]
    return order.slice(Math.min(from, to), Math.max(from, to) + 1)
  }

  /** Every selected row's entry, in the order they are drawn. */
  private selectedEntries(): FileEntry[] {
    if (this.selection.size === 0) return []
    return this.rows()
      .map((r) => r.entry)
      .filter((e) => this.selection.has(e.path))
  }

  private renderRow({ entry, depth, last, guides }: Row): HTMLElement {
    const row = document.createElement('div')
    row.className = 'files-row' + (entry.isDir ? ' dir' : '')
    if (this.selection.has(entry.path)) row.classList.add('selected')
    // A cut entry is faded until it is pasted, the way Explorer does it — the
    // file is still there, and this is the only thing on screen saying it is
    // about to move.
    if (clipboard?.mode === 'cut' && clipboard.paths.includes(entry.path)) row.classList.add('cut')
    this.rowEls.set(entry.path, row)
    row.title = entry.path
    row.draggable = this.renaming !== entry.path

    row.appendChild(this.renderGuides(depth, last, guides))

    const twisty = document.createElement('span')
    twisty.className = 'files-twisty'
    if (entry.isDir) twisty.textContent = this.expanded.has(entry.path) ? '▾' : '▸'
    row.appendChild(twisty)

    if (this.renaming === entry.path) {
      const input = document.createElement('input')
      input.className = 'files-rename-input'
      input.value = entry.name
      input.spellcheck = false
      row.appendChild(input)

      attachInlineEditor(input, {
        onCommit: async (value) => {
          this.renaming = null
          if (value.trim() && value !== entry.name) await this.doRename(entry, value)
          else this.render()
        },
        onCancel: () => {
          this.renaming = null
          this.render()
        },
      })
      return row
    }

    const name = document.createElement('span')
    name.className = 'files-name'
    // Trailing separator marks folders without needing an icon column — the
    // platform's own, or a Mac would show `src\` for a directory called `src`.
    name.textContent = entry.isDir
      ? entry.name + pathSeparator(backend().capabilities.platform)
      : entry.name
    row.appendChild(name)

    if (store.settings.treeShowSize) {
      // Folders are left blank. What the OS reports for a directory is the size
      // of the entry itself, not of what is inside it, and walking the subtree
      // to find the real answer is not something a redraw can afford.
      const size = document.createElement('span')
      size.className = 'files-size'
      size.textContent = entry.isDir ? '' : formatSize(entry.size)
      // The rounded figure is the column's whole point; the exact byte count is
      // what you actually need when comparing two builds, so it goes on hover.
      if (!entry.isDir) size.title = `${entry.size.toLocaleString()} bytes`
      row.appendChild(size)
    }

    if (store.settings.treeShowModified) {
      const date = document.createElement('span')
      date.className = 'files-date'
      date.textContent = formatDate(entry.modified)
      // The column is short on purpose; the exact stamp is a hover away.
      if (entry.modified) date.title = new Date(entry.modified).toLocaleString()
      row.appendChild(date)
    }

    const mark = this.status[entry.path]
    if (mark) {
      const badge = document.createElement('span')
      badge.className = 'files-status s-' + (mark === '?' ? 'new' : mark === '·' ? 'inner' : 'mod')
      badge.textContent = mark === '·' ? '•' : mark
      badge.title = statusLabel(mark)
      row.appendChild(badge)
    }

    // Double-click is read off the click count rather than from a `dblclick`
    // listener. Clicking a row re-renders the list, so by the time the second
    // click lands the element that saw the first one is gone and `dblclick`
    // never fires on either — which is what stopped double-clicking a file
    // from opening it.
    row.addEventListener('click', (e) => {
      if (e.detail >= 2) {
        if (entry.isDir) this.navigate(entry.path)
        else void backend().openInExplorer(entry.path)
        return
      }
      this.clickSelect(entry, e)
      // Taking focus is what makes Ctrl+C mean this file rather than whatever
      // the last focused terminal thinks it means.
      this.listEl.focus({ preventScroll: true })
      // Not on a modified click: Ctrl and Shift are how a folder is added to a
      // selection, and folding it open at the same time moves everything under
      // the pointer.
      if (entry.isDir && !e.shiftKey && !e.ctrlKey && !e.metaKey) void this.toggle(entry)
    })
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // Only when the row is outside the selection. Right-clicking one of
      // several highlighted rows must not throw the other four away — that is
      // the click you make precisely because you want to act on all of them.
      if (!this.selection.has(entry.path)) {
        this.anchor = entry.path
        this.setSelection([entry.path], entry.path, entry.isDir)
      }
      this.openRowMenu(e.clientX, e.clientY, entry)
    })

    // Dragging a row onto a terminal drops its quoted path at the cursor.
    //
    // Dragging one of several selected rows takes the whole selection, which is
    // what makes multi-select worth having at a prompt: five paths arrive as
    // five quoted arguments. Dragging an unselected row takes just that row,
    // rather than whatever happened to be highlighted somewhere else.
    row.addEventListener('dragstart', (e) => {
      const dragging = this.selection.has(entry.path)
        ? this.selectedEntries().map((x) => x.path)
        : [entry.path]
      // Decides for itself whether this leaves as a file the rest of the
      // desktop can take or as a path only this app can read — see the
      // `fileDrag` setting. Either way the path is on the drag first, so an
      // internal drop works whichever kind it turned out to be.
      startDrag(e, dragging)
    })

    return row
  }

  /**
   * The indent column.
   *
   * Drawn with real 1px rules spanning the full row height rather than box
   * characters — glyphs leave a gap at every line boundary, so the verticals
   * came out dashed instead of continuous.
   */
  private renderGuides(depth: number, last: boolean, guides: boolean[]): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'files-guides'

    // One column per ancestor *above* the immediate parent: a full-height rule
    // where that branch continues below this row, blank where it has finished.
    for (let level = 0; level < depth - 1; level++) {
      const cell = document.createElement('span')
      cell.className = 'files-guide' + (guides[level] ? ' through' : '')
      wrap.appendChild(cell)
    }

    // The elbow: a tee when more siblings follow, a corner on the last child.
    if (depth > 0) {
      const elbow = document.createElement('span')
      elbow.className = 'files-guide elbow' + (last ? ' last' : '')
      wrap.appendChild(elbow)
    }
    return wrap
  }

  private renderNewFolderRow(): HTMLElement {
    const isFile = this.creatingKind === 'file'
    const row = document.createElement('div')
    row.className = 'files-row' + (isFile ? '' : ' dir')

    const input = document.createElement('input')
    input.className = 'files-rename-input'
    input.placeholder = isFile ? 'New file name' : 'New folder name'
    input.spellcheck = false
    row.appendChild(input)

    const parent = this.creatingIn ?? this.cwd
    attachInlineEditor(input, {
      onCommit: async (value) => {
        this.creatingIn = null
        if (!value.trim()) {
          this.render()
          return
        }
        try {
          if (isFile) await backend().files.createFile(parent, value)
          else await backend().files.createDirectory(parent, value)
          await this.refresh()
        } catch (err) {
          showToast(isFile ? 'Could not create file' : 'Could not create folder', messageOf(err), {
            kind: 'error',
          })
          this.render()
        }
      },
      onCancel: () => {
        this.creatingIn = null
        this.render()
      },
    })

    return row
  }

  private renderCrumbs(): void {
    this.crumbEl.replaceChildren()
    const parts = pathAncestors(backend().capabilities.platform, this.cwd)

    parts.forEach((part, index) => {
      const crumb = document.createElement('button')
      crumb.className = 'files-crumb'
      crumb.textContent = part.name
      crumb.addEventListener('click', () => this.navigate(part.path))
      this.crumbEl.appendChild(crumb)

      if (index < parts.length - 1) {
        const sep = document.createElement('span')
        sep.className = 'files-crumb-sep'
        sep.textContent = '›'
        this.crumbEl.appendChild(sep)
      }
    })
  }

  private renderError(message: string): void {
    this.renderCrumbs()
    this.listEl.replaceChildren()
    const error = document.createElement('p')
    error.className = 'files-empty'
    error.textContent = message
    this.listEl.appendChild(error)
  }

  // -------------------------------------------------------------- operations

  private async doRename(entry: FileEntry, name: string): Promise<void> {
    try {
      await backend().files.rename(entry.path, name)
      await this.refresh()
    } catch (err) {
      showToast('Could not rename', messageOf(err), { kind: 'error' })
      this.render()
    }
  }

  /**
   * Renaming the folder the tree is standing in moves the ground under it, so
   * the tree follows the folder to its new name instead of refreshing a path
   * that no longer exists.
   */
  private async renameRoot(name: string): Promise<void> {
    try {
      const from = this.cwd
      const next = await backend().files.rename(from, name)
      this.cwd = next
      this.expanded.clear()
      this.children.clear()
      this.select(null)
      this.hooks.onRootRenamed?.(from, next)
      this.hooks.onNavigate(this.paneId, next)
      await this.refresh()
    } catch (err) {
      showToast('Could not rename', messageOf(err), { kind: 'error' })
      this.render()
    }
  }

  /** Same again for delete: there is nothing left to show, so go up one. */
  private async deleteRoot(permanent = false): Promise<void> {
    const parent = parentOf(this.cwd)
    if (parent === this.cwd) {
      showToast('Cannot delete', 'This is the top of the drive.', { kind: 'warn' })
      return
    }
    const bin = trashName(backend().capabilities.platform)
    const ok = await confirmDialog({
      title: permanent
        ? `Permanently delete “${folderLeaf(this.cwd)}”?`
        : `Delete “${folderLeaf(this.cwd)}”?`,
      body: permanent
        ? 'This permanently deletes the folder the tree is showing, and everything ' +
          `inside it. It does not go to the ${bin}, and it cannot be undone.`
        : `This moves the folder the tree is showing, and everything inside it, to the ${bin}.`,
      confirmLabel: permanent ? 'Delete permanently' : 'Delete',
      danger: true,
    })
    if (!ok) return

    try {
      const gone = this.cwd
      await backend().files.remove(gone, permanent)
      this.navigate(parent)
      this.hooks.onRootDeleted?.(gone, parent)
    } catch (err) {
      showToast('Could not delete', messageOf(err), { kind: 'error' })
    }
  }

  /**
   * `permanent` is the Shift-held path — an unlink with no way back, so it says
   * so in the title, the body and the button rather than only in the body. The
   * ordinary path moves to the platform's trash and promises much less.
   */
  private async doDelete(entries: readonly FileEntry[], permanent = false): Promise<void> {
    if (!entries.length) return
    const many = entries.length > 1
    const anyDir = entries.some((e) => e.isDir)
    const bin = trashName(backend().capabilities.platform)
    const what = anyDir ? (many ? 'folders' : 'folder') : many ? 'files' : 'file'

    const ok = await confirmDialog({
      title: permanent
        ? many
          ? `Permanently delete ${entries.length} items?`
          : `Permanently delete “${entries[0].name}”?`
        : many
          ? `Delete ${entries.length} items?`
          : `Delete “${entries[0].name}”?`,
      // One dialog for the whole set rather than one per item: a confirmation
      // you answer five times is one you stop reading.
      body:
        (many ? `${entries.map((e) => e.name).join(', ')}\n\n` : '') +
        (permanent
          ? `This permanently deletes the ${what}${
              anyDir ? ' and everything inside' : ''
            }. It does not go to the ${bin}, and it cannot be undone.`
          : `This moves the ${what}${anyDir ? ' and everything inside' : ''} to the ${bin}.`),
      confirmLabel: permanent ? 'Delete permanently' : 'Delete',
      danger: true,
    })
    if (!ok) return

    const failures: string[] = []
    const gone = new Set<string>()
    for (const entry of entries) {
      try {
        await backend().files.remove(entry.path, permanent)
        gone.add(entry.path)
        this.expanded.delete(entry.path)
      } catch (err) {
        failures.push(`${entry.name}: ${messageOf(err)}`)
      }
    }

    // Whatever went is dropped from the selection; whatever survived a failure
    // stays selected, so it is still the thing under your cursor to retry.
    const left = [...this.selection].filter((p) => !gone.has(p))
    // A gallery filled from a folder that has just been deleted should empty,
    // not keep showing what was in it.
    this.setSelection(left, this.selected && gone.has(this.selected) ? null : this.selected)

    if (failures.length) {
      showToast('Could not delete', failures.join('\n'), { kind: 'error' })
    }
    await this.refresh()
  }

  // ------------------------------------------------------------------- menus

  /**
   * The "make this the workspace's folder" item, or nothing at all when this
   * tree does not belong to a workspace. Spread into a menu.
   */
  private rootItem(folder: string): MenuItem[] {
    const set = this.hooks.setWorkspaceRoot
    if (!set) return []
    const current = this.hooks.workspaceRoot?.()
    return [
      {
        label: 'Set as workspace folder',
        disabled:
          current !== undefined && samePath(backend().capabilities.platform, current, folder),
        onClick: () => set(folder),
      },
    ]
  }

  /**
   * "New file…" and "New folder…", for every menu that offers them.
   *
   * One definition rather than three copies: the three menus had drifted apart
   * — the tree's background offered a folder and no file — and a menu entry
   * pasted a third time is a menu entry that will drift again.
   *
   * `expand` is the folder to open first, when the menu was raised on a closed
   * one: creating inside something you cannot see is how a new file goes
   * missing.
   */
  /**
   * The tree's own shortcuts, live only while a row has been clicked.
   *
   * Everything here is stopped as well as prevented: the app's global handler
   * treats Ctrl+C as the terminal's copy-or-interrupt, and Ctrl+V as paste into
   * a shell. Letting either through would send the file you selected to
   * whichever pane happened to be focused before.
   */
  private onKeyDown(e: KeyboardEvent): void {
    const selected = this.selectedEntries()

    // Delete, on whatever is highlighted. Behind the same confirmation as the
    // menu — one keystroke should not be able to remove a folder. Shift is the
    // long-standing Windows convention for "skip the bin", and the dialog it
    // opens says which of the two is about to happen.
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!selected.length) return
      e.preventDefault()
      e.stopPropagation()
      void this.doDelete(selected, e.shiftKey)
      return
    }

    // Escape drops the selection. Only when there is one, so it still reaches
    // the pane's other Escape handlers when the tree has nothing highlighted.
    if (e.key === 'Escape' && this.selection.size) {
      e.preventDefault()
      e.stopPropagation()
      this.anchor = null
      this.setSelection([], null)
      return
    }

    const ctrl = e.ctrlKey || e.metaKey
    if (!ctrl || e.altKey) return
    const key = e.key.toLowerCase()

    if (key === 'a' && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      const all = this.rows().map((r) => r.entry.path)
      this.anchor = all[0] ?? null
      this.setSelection(all, null)
      return
    }

    if (e.shiftKey) return
    if (key !== 'c' && key !== 'x' && key !== 'v') return

    if (key === 'v') {
      e.preventDefault()
      e.stopPropagation()
      // Into the selected folder, or the folder the selected file is in, or
      // the one the tree is showing — the same rule the menu uses. The lead,
      // not the whole selection: five selected files do not name a folder.
      void this.paste(this.pasteTarget(this.leadEntry() ?? undefined))
      return
    }

    // Nothing selected: left alone, so the shortcut still reaches whatever
    // would ordinarily have it rather than being swallowed by an idle tree.
    if (!selected.length) return
    e.preventDefault()
    e.stopPropagation()
    this.clip(
      selected.map((x) => x.path),
      key === 'x' ? 'cut' : 'copy'
    )
  }

  /** The lead row's entry, if it is still in the listing. */
  private leadEntry(): FileEntry | null {
    if (!this.selected) return null
    for (const entries of this.children.values()) {
      const hit = entries.find((e) => e.path === this.selected)
      if (hit) return hit
    }
    return null
  }

  // ------------------------------------------------------------- clipboard

  private clip(paths: readonly string[], mode: 'copy' | 'cut'): void {
    if (!paths.length) return
    clipboard = { paths: [...paths], mode }
    // Every tree redraws: a cut entry is shown faded wherever it appears, and
    // it may well appear in more than one of them.
    FilesPane.refreshAll()
    showToast(mode === 'cut' ? 'Cut' : 'Copied', describe(paths))
  }

  /**
   * Pastes into `folder`.
   *
   * A cut clears the clipboard and a copy does not, which is what every file
   * manager does and the reason both exist: a copy is a thing you may want
   * several of, a cut is a move that has now happened.
   *
   * One at a time rather than in parallel. Each destination name depends on
   * what is already in the folder, and two concurrent pastes of the same name
   * would both look up a free slot, both find the same one, and one would lose.
   */
  private async paste(folder: string): Promise<void> {
    const held = clipboard
    if (!held) return

    const landed: string[] = []
    const failures: string[] = []
    for (const source of held.paths) {
      try {
        landed.push(
          held.mode === 'cut'
            ? await backend().files.move(source, folder)
            : await backend().files.copy(source, folder)
        )
      } catch (err) {
        failures.push(`${folderLeaf(source)}: ${messageOf(err)}`)
      }
    }

    // Cleared even on a partial failure: what did move has moved, and pasting
    // the same list again would duplicate those. What did not is reported.
    if (held.mode === 'cut') clipboard = null
    // Selected on arrival, so a paste into a long folder does not leave you
    // hunting for what you just pasted.
    this.pendingSelect = landed

    if (failures.length) {
      showToast(
        landed.length ? 'Some items could not be pasted' : 'Could not paste',
        failures.join('\n'),
        { kind: 'error' }
      )
    }
    // Both ends may be on screen at once, and after a cut the source folder is
    // as changed as the destination.
    FilesPane.refreshAll()
  }

  /** Where a paste goes for a given row: into a folder, or beside a file. */
  private pasteTarget(entry?: FileEntry): string {
    if (!entry) return this.cwd
    return entry.isDir ? entry.path : parentOf(entry.path)
  }

  /**
   * What the row menu acts on: the selection when the row is part of it, and
   * that row alone when it is not.
   *
   * Right-clicking outside a selection is how every file manager lets you act
   * on one item without first clearing what you had — and acting on a selection
   * the row is not in would be acting on something you cannot see from where
   * you clicked.
   */
  private actOn(entry?: FileEntry): FileEntry[] {
    if (!entry) return []
    return this.selection.has(entry.path) ? this.selectedEntries() : [entry]
  }

  private clipboardItems(entry?: FileEntry): MenuEntry[] {
    const target = this.pasteTarget(entry)
    const items: MenuEntry[] = []
    const subject = this.actOn(entry)

    if (subject.length) {
      const what = describe(subject.map((e) => e.path))
      const paths = subject.map((e) => e.path)
      items.push(
        { label: `Cut ${what}`, shortcut: 'Ctrl+X', onClick: () => this.clip(paths, 'cut') },
        { label: `Copy ${what}`, shortcut: 'Ctrl+C', onClick: () => this.clip(paths, 'copy') }
      )
    }
    items.push({
      label: clipboard
        ? `Paste ${describe(clipboard.paths)} into ${folderLeaf(target)}`
        : 'Paste',
      shortcut: 'Ctrl+V',
      disabled: !clipboard,
      onClick: () => void this.paste(target),
    })
    return items
  }

  private createItems(folder: string, expand?: string): MenuItem[] {
    const begin = (kind: 'file' | 'dir') => () => {
      this.creatingKind = kind
      this.creatingIn = folder
      if (expand) this.expanded.add(expand)
      this.render()
    }
    return [
      { label: 'New file…', onClick: begin('file') },
      { label: 'New folder…', onClick: begin('dir') },
    ]
  }

  private openRowMenu(x: number, y: number, entry: FileEntry): void {
    const folder = entry.isDir ? entry.path : parentOf(entry.path)

    showContextMenu(x, y, [
      ...(entry.isDir
        ? [{ label: 'Open here', onClick: () => this.navigate(entry.path) }]
        : [
            { label: 'Edit', onClick: () => this.hooks.openEditorTab(entry.path) },
            { label: 'Open in reader', onClick: () => this.hooks.openReader(entry.path) },
            { label: 'Open in external editor', onClick: () => this.hooks.openInEditor(entry.path) },
            { label: 'Open with Windows', onClick: () => void backend().openInExplorer(entry.path) },
          ]),
      { label: 'New terminal here', onClick: () => this.hooks.openTerminalAt(folder) },
      {
        label: this.actOn(entry).length > 1 ? 'Send paths to terminal' : 'Send path to terminal',
        onClick: () =>
          this.hooks.sendToActiveTerminal(
            this.actOn(entry)
              .map((e) => quotePath(e.path))
              .join(' ')
          ),
      },
      ...this.rootItem(folder),
      'separator',
      ...this.clipboardItems(entry),
      'separator',
      ...this.createItems(folder, entry.isDir ? entry.path : undefined),
      {
        label: 'Rename…',
        shortcut: 'F2',
        // One at a time: renaming five files means five new names, which is a
        // dialog this tree does not have and Explorer's numbered-batch answer
        // to is rarely what anyone wanted.
        disabled: this.actOn(entry).length > 1,
        onClick: () => {
          this.renaming = entry.path
          this.render()
        },
      },
      {
        label: `Delete ${describe(this.actOn(entry).map((e) => e.path))}…`,
        danger: true,
        onClick: () => void this.doDelete(this.actOn(entry)),
      },
      {
        label: `Delete permanently ${describe(this.actOn(entry).map((e) => e.path))}…`,
        danger: true,
        onClick: () => void this.doDelete(this.actOn(entry), true),
      },
      'separator',
      {
        label: 'Copy path',
        onClick: () => {
          const paths = this.actOn(entry).map((e) => e.path)
          void copyText(paths.join('\n'), describe(paths))
        },
      },
      { label: 'Copy name', onClick: () => void copyText(entry.name) },
      { label: 'Reveal in Explorer', onClick: () => void backend().openInExplorer(folder) },
    ])
  }

  /**
   * The root row's menu, which is the row menu applied to the current folder.
   * "Open here" would be a no-op on the folder we are already in, so it opens
   * the parent instead — the same thing double-clicking the row does.
   */
  private openRootMenu(x: number, y: number): void {
    showContextMenu(x, y, [
      { label: 'Open parent folder', onClick: () => this.navigate(parentOf(this.cwd)) },
      { label: 'New terminal here', onClick: () => this.hooks.openTerminalAt(this.cwd) },
      {
        label: 'Send path to terminal',
        onClick: () => this.hooks.sendToActiveTerminal(quotePath(this.cwd)),
      },
      ...this.rootItem(this.cwd),
      'separator',
      ...this.createItems(this.cwd),
      {
        label: 'Rename…',
        onClick: () => {
          this.renamingRoot = true
          this.render()
        },
      },
      { label: 'Delete…', danger: true, onClick: () => void this.deleteRoot() },
      'separator',
      { label: 'Copy path', onClick: () => void copyText(this.cwd) },
      { label: 'Copy name', onClick: () => void copyText(folderLeaf(this.cwd)) },
      { label: 'Reveal in Explorer', onClick: () => void backend().openInExplorer(this.cwd) },
    ])
  }

  private openBackgroundMenu(x: number, y: number): void {
    showContextMenu(x, y, [
      { label: 'New terminal here', onClick: () => this.hooks.openTerminalAt(this.cwd) },
      ...this.rootItem(this.cwd),
      'separator',
      ...this.clipboardItems(),
      'separator',
      ...this.createItems(this.cwd),
      { label: 'Refresh', onClick: () => void this.refresh() },
      'separator',
      { label: 'Go to folder…', onClick: () => this.beginPathEdit() },
      {
        label: this.showHidden ? 'Hide hidden files' : 'Show hidden files',
        onClick: () => {
          this.showHidden = !this.showHidden
          void this.refresh()
        },
      },
      {
        label: 'Sort by',
        submenu: [
          {
            label: 'Name',
            checked: store.settings.treeSort === 'name',
            onClick: () => this.setColumns({ treeSort: 'name' }),
          },
          {
            label: 'Size',
            checked: store.settings.treeSort === 'size',
            onClick: () => this.setColumns({ treeSort: 'size' }),
          },
          {
            label: 'Date modified',
            checked: store.settings.treeSort === 'modified',
            onClick: () => this.setColumns({ treeSort: 'modified' }),
          },
          {
            label: 'Type (extension)',
            checked: store.settings.treeSort === 'extension',
            onClick: () => this.setColumns({ treeSort: 'extension' }),
          },
          'separator',
          {
            label: 'Reverse',
            checked: store.settings.treeSortDesc,
            onClick: () => this.setColumns({ treeSortDesc: !store.settings.treeSortDesc }),
          },
        ],
      },
      {
        label: 'Columns',
        submenu: [
          // The name is not in here: a tree with no names is not a tree.
          {
            label: 'Size',
            checked: store.settings.treeShowSize,
            onClick: () => this.setColumns({ treeShowSize: !store.settings.treeShowSize }),
          },
          {
            label: 'Date modified',
            checked: store.settings.treeShowModified,
            onClick: () => this.setColumns({ treeShowModified: !store.settings.treeShowModified }),
          },
        ],
      },
      {
        label: 'Collapse all',
        disabled: this.expanded.size === 0,
        onClick: () => {
          this.expanded.clear()
          this.render()
        },
      },
      'separator',
      { label: 'Copy folder path', onClick: () => void copyText(this.cwd) },
      { label: 'Reveal in Explorer', onClick: () => void backend().openInExplorer(this.cwd) },
    ])
  }

  dispose(): void {
    this.disposed = true
    FilesPane.live.delete(this)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.pollTimer = null
    window.removeEventListener('focus', this.onWindowFocus)
    this.element.remove()
  }
}

/** How often the tree re-reads the folders it is showing, in milliseconds. */
const POLL_MS = 2000

/**
 * A cheap fingerprint of the listings on screen.
 *
 * Names and kinds only, unless a size or date column is on: those are what the
 * tree draws, and leaving mtime out means a file being written to in a loop
 * doesn't rebuild the DOM every poll. Once the numbers are on screen they are
 * part of the drawing, and a stale one is worse than the redraw.
 */
function signatureOf(
  listings: { dir: string; entries: FileEntry[] | null }[],
  detailed: boolean
): string {
  return JSON.stringify(
    listings.map(({ dir, entries }) => [
      dir,
      entries?.map((e) => {
        const base = (e.isDir ? 'd' : 'f') + e.name
        return detailed ? `${base}|${e.size}|${e.modified}` : base
      }),
    ])
  )
}

/**
 * A file size in the narrowest form that is still honest: bytes below a
 * kilobyte, and one decimal only while the number is small enough for it to
 * mean something.
 *
 * Right-aligned in a fixed-width column by `.files-size`, which is what makes
 * the figures form a line you can run your eye down. Splitting the number into
 * separately aligned pieces — digits, point, fraction, unit — was tried and
 * looked worse: every part sizes to the widest row that has one, so a column of
 * mostly-round numbers ends up spread across gaps that exist for other rows.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${SIZE_UNITS[unit]}`
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB']

/**
 * A timestamp at the width a tree column can spare: the clock for today, the
 * day and month for this year, and the year as well once it is older.
 *
 * Each form drops what the one before it made obvious, which is what keeps the
 * column scannable — a full stamp on every row is sixteen characters of mostly
 * the same digits. The exact time is on the cell's tooltip.
 */
function formatDate(ms: number): string {
  if (!ms) return ''
  const date = new Date(ms)
  const now = new Date()
  if (date.toDateString() === now.toDateString()) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`
  return date.getFullYear() === now.getFullYear()
    ? day
    : `${day} ${String(date.getFullYear()).slice(2)}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function folderLeaf(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() || dir
}

/** `parentDir` against the host we are actually running on. */
function parentOf(dir: string): string {
  return parentDir(backend().capabilities.platform, dir)
}

/** Only quote when needed, so pasted paths stay readable. */
function statusLabel(mark: string): string {
  if (mark === '?') return 'Untracked'
  if (mark === '·') return 'Contains changes'
  if (mark === 'A') return 'Added'
  if (mark === 'D') return 'Deleted'
  return 'Modified'
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * How a set of paths is named in a menu label or a toast.
 *
 * One is named; several are counted. Listing five filenames in a menu item
 * makes the menu unreadable, and the selection is already on screen saying
 * which five they are.
 */
function describe(paths: readonly string[]): string {
  if (paths.length === 1) return folderLeaf(paths[0])
  return `${paths.length} items`
}

export { parentOf }
