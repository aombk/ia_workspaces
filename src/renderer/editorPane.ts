/**
 * The editor tab: one file, several ways of looking at it.
 *
 * It began as a notes pane — one markdown file per workspace, `NOTES.md`, on a
 * button. That file is still what a new editor tab opens, because a note about
 * the project you are in is the commonest thing to want and it should stay one
 * click away. But the pane is no longer *about* that file: it opens any file
 * you point it at, one per tab, as many tabs as you like.
 *
 * Three things it deliberately does not have:
 *
 * **A Save.** It writes what you typed a moment after you stop, and again on
 * losing focus, closing the tab, or closing the window. A file lost because you
 * did not think to press a key is the app's fault, not yours. Ctrl+S still
 * works and does the same thing sooner, because the reflex is thirty years old.
 *
 * **A mode you must be in to type.** The text views format as you type; there
 * is no edit-versus-preview to switch between. What the tab's menu chooses is
 * *how the file is shown* — markdown, code, plain, rendered, JSON, table, hex —
 * and by default that follows the file's extension.
 *
 * **A second copy of the file.** Every view reads and writes the same string.
 * Switching views flushes first, so no view can be holding text another one is
 * about to overwrite.
 */
import { backend } from '../backend'
import { joinPath } from '../shared/platform'
import { store } from './state'
import { renderMarkdown, folderOf } from './markdown'
import { copyText } from './ui/clipboard'
import { showContextMenu, type MenuEntry } from './ui/contextMenu'
import { showToast } from './ui/toast'
import { confirmDialog } from './ui/confirm'
import { beginEditing, endEditing } from './ui/editing'
import { LiveText, type Highlighter } from './ui/liveText'
import { dominantEol, normalizeNewlines, toCrlf } from '../shared/eol'
import { code, json, markdown, plain } from './ui/highlight'
import { CsvGrid } from './ui/csvGrid'
import { HexView, decode, encode } from './ui/hexView'
import { FindBar } from './ui/findBar'
import {
  changeCase,
  deleteLines,
  duplicateLines,
  findAll,
  findNext,
  joinLines,
  moveLines,
  removeDuplicateLines,
  removeEmptyLines,
  replaceAll,
  replaceSpan,
  reverseLines,
  sortLines,
  toggleComment,
  trimTrailing,
  type CaseKind,
  type Edit,
  type FindOptions,
  type Span,
} from './ui/textOps'
import { FILE_DRAG } from './filesPane'
import { delimiterFor, grammarFor, modeForFile } from '../shared/editorModes'
import { READ_ONLY_MODES, type EditorMode } from '../shared/types'
import type { AuxPane } from './auxPane'

export interface EditorPaneHooks {
  /** Hand the file to the editor named in settings. */
  openInEditor(path: string): void
}

/**
 * How long typing pauses before the file is written out.
 *
 * Short enough that "did that save?" never becomes a question, long enough that
 * a sentence is one write rather than forty.
 */
const AUTOSAVE_MS = 400

/**
 * The column the guide is drawn at.
 *
 * 80 because that is what the files this editor opens are written to — a README
 * hard-wrapped by hand, a commit message, a source file under a linter. The
 * number is in the menu label rather than only in the line, so a rule appearing
 * down the page is explained by the thing that turned it on.
 */
const COLUMN_GUIDE = 80

/**
 * How often an open editor stats its file to see whether anything else wrote
 * to it. The same cadence the file tree polls at, for the same reason: often
 * enough that you do not catch the app being wrong, cheap enough to ignore.
 */
const WATCH_MS = 2000

/** Two stats describing the same file, as far as anyone can tell. */
function sameStamp(
  a: { mtime: number; size: number },
  b: { mtime: number; size: number }
): boolean {
  return a.mtime === b.mtime && a.size === b.size
}

/** Every text view is this one surface; the rest are their own thing. */
const TEXT_MODES: readonly EditorMode[] = ['markdown', 'code', 'json', 'text']


export class EditorPane implements AuxPane {
  readonly element: HTMLDivElement
  /** Markdown, code, JSON and plain text are all this, with a different grammar. */
  private readonly live: LiveText
  /** Rendered markdown, read-only. */
  private readonly rendered: HTMLDivElement
  private readonly grid: CsvGrid
  private readonly hex: HexView
  private readonly find: FindBar
  private readonly pathLabel: HTMLButtonElement
  private readonly status: HTMLSpanElement
  private readonly saveBtn: HTMLButtonElement
  /** Per tab, because it is a property of the file you have open, not of you. */
  private readonly autoBtn: HTMLButtonElement
  private mode: EditorMode = 'markdown'
  private path = ''
  private disposed = false
  /** Whether `beginEditing` is currently owed an `endEditing`. */
  private holdingFocus = false
  /** The text last read from or written to disk, to tell edits from no-ops. */
  private saved = ''
  /**
   * The line ending this file uses on disk.
   *
   * The editor works in `\n` and puts this back on the way out, so editing a
   * CRLF file changes the lines you changed and not the other nine hundred.
   */
  private eol: '\n' | '\r\n' = '\n'
  /** True while a write is in flight, so the next one queues instead of racing. */
  private saving = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Why this file must not be written; see `load`. */
  private blocked: string | null = null
  /** A write that failed, so the status line does not go on claiming "Saved". */
  private failed = false
  /**
   * What the file looked like on disk when we last read or wrote it.
   *
   * The whole of the external-change check: anything else and somebody else has
   * written to the file since. Null while there is no file, or none yet.
   */
  private stamp: { mtime: number; size: number } | null = null
  /**
   * An external write this pane has not dealt with yet.
   *
   * While it is set, no automatic write happens — that is the point of it. An
   * autosave firing here is precisely the accident this exists to stop: it would
   * take the text loaded before the change and put it back over the change.
   */
  private conflict = false
  private readonly conflictBar: HTMLDivElement
  private watchTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string,
    private readonly hooks: EditorPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'reader-pane notes-pane'

    const head = document.createElement('div')
    head.className = 'reader-head'

    // The path is the control that changes it: the thing you click when you
    // want a different file is the name of the one you have.
    this.pathLabel = document.createElement('button')
    this.pathLabel.className = 'reader-path editor-path'
    this.pathLabel.addEventListener('click', () => void this.chooseFile())
    head.appendChild(this.pathLabel)

    this.status = document.createElement('span')
    this.status.className = 'notes-status'
    head.appendChild(this.status)

    this.saveBtn = this.headButton('Save', 'Write the file now (Ctrl+S)', () => void this.saveAs())
    this.saveBtn.classList.add('primary')
    head.appendChild(this.saveBtn)

    this.autoBtn = this.headButton('Autosave', '', () => this.toggleAutosave())
    head.appendChild(this.autoBtn)

    head.appendChild(this.headButton('Open…', 'Open another file in this tab', () => void this.chooseFile()))
    head.appendChild(
      this.headButton('Find', 'Find and replace (Ctrl+F)', () => this.openFind(false))
    )
    head.appendChild(
      this.headButton('Reload', 'Read the file again, discarding anything not written yet', () =>
        void this.load(true)
      )
    )
    // Still here, for the things a small editor is the wrong tool for.
    head.appendChild(
      this.headButton('Open in editor', 'Hand the file to your external editor', () => {
        if (this.path) this.hooks.openInEditor(this.path)
      })
    )
    this.element.appendChild(head)

    this.find = new FindBar({
      find: (query, opts, backwards) => this.runFind(query, opts, backwards),
      replace: (query, replacement, opts) => this.runReplace(query, replacement, opts),
      replaceAll: (query, replacement, opts) => this.runReplaceAll(query, replacement, opts),
      close: () => {
        this.find.hide()
        this.live.focus()
      },
    })
    this.element.appendChild(this.find.element)

    // Above the text and below the toolbar, so it is impossible to keep typing
    // without having seen it.
    this.conflictBar = document.createElement('div')
    this.conflictBar.className = 'editor-conflict'
    this.conflictBar.hidden = true
    this.element.appendChild(this.conflictBar)

    // No placeholder text. An empty file is obviously empty, and a caret on a
    // blank page is the invitation — a line of grey prose there is one more
    // thing to read before you can start typing over it.
    this.live = new LiveText(markdown, () => this.onEdit())
    this.element.appendChild(this.live.element)

    this.rendered = document.createElement('div')
    this.rendered.className = 'reader-body markdown'
    this.element.appendChild(this.rendered)

    this.grid = new CsvGrid(() => this.onEdit())
    this.element.appendChild(this.grid.element)

    this.hex = new HexView(() => this.onEdit())
    this.element.appendChild(this.hex.element)

    for (const view of this.views()) {
      view.addEventListener('keydown', (e) => this.onKey(e as KeyboardEvent))
      // Focus is the app's signal that a rename input owns the keyboard; an
      // editor wants exactly the same protection from the terminal focus grab.
      view.addEventListener('focusin', () => this.holdFocus(true))
      view.addEventListener('focusout', () => {
        this.holdFocus(false)
        void this.flush()
      })
      // A link in an editor cannot open on a plain click — that click is how
      // you put the caret in the middle of it — so it takes the modifier every
      // editor uses for the same reason. In the rendered view, where there is
      // no caret to place, a plain click is enough.
      view.addEventListener('click', (e) => {
        const href = LiveText.linkAt((e as MouseEvent).target)
        if (!href) return
        if (view !== this.rendered && !(e as MouseEvent).ctrlKey && !(e as MouseEvent).metaKey) return
        e.preventDefault()
        void backend().openExternal(href)
      })
      view.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.openMenu(e as MouseEvent)
      })
    }

    // A file dragged out of the tree and dropped here is an instruction: open
    // that. The tree marks its drags with a type of ours, so an ordinary text
    // drag — a word from another pane — still lands as text rather than being
    // mistaken for a path.
    this.element.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types.includes(FILE_DRAG)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      this.element.classList.add('editor-drop')
    })
    this.element.addEventListener('dragleave', (e) => {
      if (!this.element.contains(e.relatedTarget as Node)) this.element.classList.remove('editor-drop')
    })
    this.element.addEventListener('drop', (e) => {
      this.element.classList.remove('editor-drop')
      const dropped = e.dataTransfer?.getData(FILE_DRAG)
      if (!dropped) return
      e.preventDefault()
      e.stopPropagation()
      void this.openFile(dropped)
    })

    // Coming back to the window is exactly when the file has just been changed
    // somewhere else.
    window.addEventListener('focus', this.onFocus)
    // Leaving is exactly when it should be on disk: alt-tabbing to something
    // that reads this file, or closing the window, must not cost the last
    // sentence.
    window.addEventListener('blur', this.onLeave)
    window.addEventListener('beforeunload', this.onLeave)
    // Another pane writing this same file announces itself the same way we do.
    window.addEventListener('notes-changed', this.onFocus)
    // The mode is chosen from the tab's menu, which cannot reach in here.
    window.addEventListener('editor-mode', this.onModeEvent as EventListener)
    window.addEventListener('editor-open', this.onOpenEvent as EventListener)

    this.path = this.resolvePath()
    this.mode = store.pane(paneId)?.editorMode ?? modeForFile(this.path)
    this.applyMode()
    this.syncChrome()
    void this.load()

    this.watchTimer = setInterval(() => void this.checkExternal(), WATCH_MS)
  }

  /**
   * Coming back to the window, and another pane writing this same file, are
   * both "something may have changed under me" — the same question the poll
   * asks, only sooner.
   */
  private readonly onFocus = () => void this.checkExternal()
  private readonly onLeave = () => void this.flush()
  private readonly onModeEvent = (e: CustomEvent<{ paneId: string; mode: EditorMode }>) => {
    if (e.detail?.paneId === this.paneId) void this.setMode(e.detail.mode)
  }
  /** A file dropped on this pane's *tab*, which cannot reach in here itself. */
  private readonly onOpenEvent = (e: CustomEvent<{ paneId: string; file: string }>) => {
    if (e.detail?.paneId === this.paneId) void this.openFile(e.detail.file)
  }

  private headButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.className = 'reader-btn'
    button.textContent = label
    button.title = title
    button.addEventListener('click', onClick)
    return button
  }

  private views(): HTMLElement[] {
    return [this.live.element, this.rendered, this.grid.element, this.hex.element]
  }

  // ----------------------------------------------------------------- the file

  /**
   * The file this pane has open, or none.
   *
   * Three cases, and the difference between the last two matters. A path is a
   * path. An **empty string** is a decision — a new editor tab, untitled, with
   * nowhere to write until you say where. **Absent** is a pane from before this
   * one could open anything but the project note, so it still gets the note:
   * a tab somebody has been keeping notes in for months must not come back
   * blank because the pane learned to do more.
   */
  private resolvePath(): string {
    const recorded = store.pane(this.paneId)?.file
    if (recorded) return recorded
    if (recorded === '') return ''
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    if (!workspace) return ''
    if (workspace.notesFile) return workspace.notesFile
    // `joinPath` rather than a literal separator: this used to append a
    // backslash unconditionally, which on macOS and Linux built the single
    // file `/home/you/project\NOTES.md` — one name with a backslash in it,
    // beside the project rather than inside it.
    return joinPath(backend().capabilities.platform, workspace.cwd, 'NOTES.md')
  }

  /**
   * Where an untitled tab's text should go.
   *
   * The one place this editor asks a question before writing. Everywhere else
   * it knows the answer already, which is why there is no Save button.
   */
  private async chooseDestination(): Promise<boolean> {
    const chosen = await backend().pickSaveFile({
      title: 'Save as',
      defaultName: 'untitled.md',
    })
    if (!chosen) return false
    this.path = chosen
    store.setPaneFile(this.paneId, chosen)
    this.mode = modeForFile(chosen)
    store.setEditorMode(this.paneId, this.mode)
    this.applyMode()
    this.pathLabel.textContent = chosen
    return true
  }

  /** Native Open, then this tab is that file's tab. */
  private async chooseFile(): Promise<void> {
    const chosen = await backend().pickOpenFile({ title: 'Open in this tab', anyFile: true })
    if (chosen) await this.openFile(chosen)
  }

  /** Points this pane at a file, remembering it and re-reading from scratch. */
  async openFile(file: string): Promise<void> {
    if (!file || file === this.path) return
    await this.flush()
    this.path = file
    store.setPaneFile(this.paneId, file)
    this.blocked = null
    this.saved = ''
    // The pane's own choice of view is dropped with the file it was made for: a
    // JSON view chosen for a `.json` is not a choice about the `.png` that
    // replaced it.
    this.mode = modeForFile(file)
    store.setEditorMode(this.paneId, this.mode)
    this.applyMode()
    await this.load(true)
  }

  // ---------------------------------------------------------------- the modes

  /**
   * Switches how the file is shown.
   *
   * The text is written out first: the views hold their own copy of it, and
   * moving between them must not be a way to lose the last sentence.
   */
  async setMode(mode: EditorMode): Promise<void> {
    if (mode === this.mode) return
    await this.flush()
    this.mode = mode
    store.setEditorMode(this.paneId, mode)
    this.applyMode()
    // Hex reads bytes rather than text, so it needs its own trip to disk.
    if (mode === 'hex') void this.load(true)
    else this.showText(this.saved)
    this.syncChrome()
    if (!this.readOnly) queueMicrotask(() => this.focusEditor())
  }

  /** Modes that cannot write the file back through `writeText`. */
  /**
   * Whether this tab writes as you type.
   *
   * Off for hex whatever the setting says: a byte written into a binary can
   * break it for whatever reads it, with nothing on screen to say so.
   */
  private get autosaves(): boolean {
    if (this.mode === 'hex') return false
    return store.pane(this.paneId)?.autosave ?? true
  }

  private toggleAutosave(): void {
    const next = !this.autosaves
    store.setEditorView(this.paneId, { autosave: next })
    // Turning it on is also a promise about the text already typed.
    if (next) void this.flush()
    this.syncChrome()
  }

  private get readOnly(): boolean {
    return READ_ONLY_MODES.includes(this.mode) && this.mode !== 'hex'
  }

  private get isText(): boolean {
    return TEXT_MODES.includes(this.mode)
  }

  /** Shows the one view the mode calls for, and gives it the right grammar. */
  private applyMode(): void {
    this.element.dataset.mode = this.mode
    const blocked = Boolean(this.blocked)
    this.live.element.hidden = blocked || !this.isText
    this.rendered.hidden = blocked || this.mode !== 'preview'
    this.grid.element.hidden = blocked || this.mode !== 'csv'
    this.hex.element.hidden = blocked || this.mode !== 'hex'
    if (!this.isText) this.find.hide()
    if (this.isText) this.live.setHighlighter(this.highlighter())
    this.grid.setDelimiter(delimiterFor(this.path))
    this.applyView()
  }

  /** Word wrap, line numbers and the column guide, all remembered per tab. */
  private applyView(): void {
    const pane = store.pane(this.paneId)
    // Wrap defaults on for prose and off for code: a wrapped line of markdown
    // is a paragraph, a wrapped line of code is a lie about its indentation.
    const wrap = pane?.wordWrap ?? (this.mode === 'markdown' || this.mode === 'text')
    this.live.element.classList.toggle('no-wrap', !wrap)
    this.live.element.classList.toggle('numbered', this.numbersOn)
    this.live.element.classList.toggle('ruled', this.guideOn)
  }

  /**
   * Line numbers are on unless a tab says otherwise; the column rule is not.
   *
   * Numbers are worth having open on any file — they are how a line is referred
   * to. The rule only means anything while you are keeping to a width, which is
   * a way of writing rather than a property of the editor, so it waits to be
   * asked for. A tab that has been toggled either way keeps its answer.
   */
  private get guideOn(): boolean {
    return store.pane(this.paneId)?.columnGuide ?? false
  }

  private get numbersOn(): boolean {
    return store.pane(this.paneId)?.lineNumbers ?? true
  }

  private toggleColumnGuide(): void {
    store.setEditorView(this.paneId, { columnGuide: !this.guideOn })
    this.applyView()
  }

  private highlighter(): Highlighter {
    if (this.mode === 'markdown') return markdown
    if (this.mode === 'text') return plain
    const grammar = grammarFor(this.path)
    if (!grammar) return plain
    return this.mode === 'json' ? json(grammar) : code(grammar)
  }

  private focusEditor(): void {
    if (this.isText) this.live.focus()
    else if (this.mode === 'hex') this.hex.element.focus()
  }

  /** The text as it stands, in whichever view is showing it. */
  private get text(): string {
    if (this.isText) return this.live.value
    if (this.mode === 'csv') return this.grid.value
    // Nothing in the rendered or hex views is text we would write back.
    return this.saved
  }

  private showText(text: string): void {
    if (this.isText) {
      if (this.live.value !== text) this.live.value = text
      return
    }
    if (this.mode === 'csv') {
      if (this.grid.value !== text) this.grid.value = text
      return
    }
    if (this.mode === 'preview') {
      this.rendered.replaceChildren()
      if (!text.trim()) {
        this.rendered.appendChild(emptyNote('Nothing written down yet.'))
        return
      }
      this.rendered.appendChild(renderMarkdown(text, folderOf(this.path)))
    }
  }

  // ------------------------------------------------------------- the commands

  /** Runs a text operation over the selection, as one undoable step. */
  /**
   * Runs a text operation over the selection, as one undoable step.
   *
   * `span` is passed in when the command came from the menu. Clicking a menu
   * button moves the document selection out of the editor, so by the time the
   * handler runs the selection is gone — it has to be the one that was there
   * when the menu opened. The editor is focused *before* the edit, because
   * focusing afterwards would collapse the range the operation just set.
   */
  private run(op: (text: string, span: Span) => Edit, span?: Span): void {
    if (!this.isText) return
    this.live.focus()
    this.live.apply(op(this.live.value, span ?? this.live.selection()))
  }

  /** The line-comment marker for this file, or none for prose. */
  private commentMarker(): string {
    if (this.mode === 'markdown' || this.mode === 'text') return ''
    return grammarFor(this.path)?.line[0] ?? ''
  }

  private openFind(withReplace: boolean): void {
    if (!this.isText) return
    const span = this.live.selection()
    const { from, to } = span.from <= span.to ? span : { from: span.to, to: span.from }
    this.find.show(this.live.value.slice(from, to), withReplace)
  }

  private runFind(query: string, opts: FindOptions, backwards: boolean): void {
    const text = this.live.value
    const all = findAll(text, query, opts)
    const span = this.live.selection()
    const from = backwards ? Math.min(span.from, span.to) : Math.max(span.from, span.to)
    const hit = findNext(text, query, from, opts, backwards)
    if (!hit) {
      this.find.report(0, 0)
      return
    }
    this.live.select(hit)
    this.find.report(
      all.findIndex((match) => match.from === hit.from),
      all.length
    )
  }

  private runReplace(query: string, replacement: string, opts: FindOptions): void {
    const span = this.live.selection()
    const { from, to } = span.from <= span.to ? span : { from: span.to, to: span.from }
    const selected = this.live.value.slice(from, to)
    const matches = findAll(selected, query, opts)
    // Replace what is selected when the selection *is* a match, then move on;
    // otherwise this is just "find next", which is what every editor does.
    if (selected && matches.length === 1 && matches[0].from === 0 && matches[0].to === selected.length) {
      this.live.apply(replaceSpan(this.live.value, { from, to }, replacement))
    }
    this.runFind(query, opts, false)
  }

  private runReplaceAll(query: string, replacement: string, opts: FindOptions): void {
    const { edit, count } = replaceAll(this.live.value, query, replacement, opts)
    if (!count) {
      this.find.report(0, 0)
      return
    }
    this.live.apply({ ...edit, from: 0, to: 0 })
    this.find.report(0, 0)
    showToast('Replaced', `${count} ${count === 1 ? 'match' : 'matches'}`)
  }

  private toggleWrap(): void {
    const pane = store.pane(this.paneId)
    const current = pane?.wordWrap ?? (this.mode === 'markdown' || this.mode === 'text')
    store.setEditorView(this.paneId, { wordWrap: !current })
    this.applyView()
  }

  private toggleNumbers(): void {
    store.setEditorView(this.paneId, { lineNumbers: !this.numbersOn })
    this.applyView()
  }

  // ---------------------------------------------------------------- the disk

  /** Text typed but not yet on disk. */
  private get dirty(): boolean {
    if (this.mode === 'hex') return this.hex.modified
    if (this.readOnly) return false
    return this.text !== this.saved
  }

  // ------------------------------------------------------- external changes

  /**
   * Notices that something else wrote to the file this pane has open.
   *
   * Polled, because there is no watch API on the host and adding one would mean
   * a watcher per open editor on three platforms. A stat every couple of seconds
   * costs nothing next to that, and the window-focus check below catches the
   * common case — you left, something ran, you came back — before the poll does.
   *
   * The dangerous case is not the one you can see. A tab holding text loaded
   * before the change will, on the next keystroke, autosave that text over the
   * new version: the other program's work is gone and nothing said so. That is
   * why an unresolved change blocks writing rather than only offering a reload.
   */
  private async checkExternal(): Promise<void> {
    if (this.disposed || this.conflict || this.saving || !this.path) return
    // Not hex. It never autosaves — bytes are only ever written when asked for
    // — so the silent overwrite this guards against cannot happen there, and
    // Reload is already the button for "show me what is on disk now".
    if (this.mode === 'hex') return
    const now = await backend().fileStamp(this.path)
    if (this.disposed || this.conflict || this.saving) return
    // No stamp yet — a file that did not exist when it was opened — so adopt
    // whatever is there now rather than calling its arrival a conflict.
    if (!this.stamp) {
      this.stamp = now
      return
    }
    if (!now || sameStamp(this.stamp, now)) return

    // Clean tab, and the setting says just show me: re-read and move on. The
    // stamp is taken by `load`, so the next poll compares against what we read.
    if (!this.dirty && store.settings.refreshChangedFiles === 'auto') {
      await this.load(true)
      return
    }
    this.conflict = true
    this.showConflict()
  }

  /**
   * The bar: what happened, and the two answers to it.
   *
   * Deliberately not a modal. A dialog in front of a file you were reading is a
   * demand for a decision before you are allowed to look at the thing the
   * decision is about — and with several tabs open, a stack of them.
   */
  private showConflict(): void {
    this.conflictBar.replaceChildren()

    const text = document.createElement('span')
    text.className = 'editor-conflict__text'
    text.textContent = this.dirty
      ? 'This file changed on disk, and you have unsaved edits. Nothing is being written until you choose.'
      : 'This file changed on disk.'
    this.conflictBar.appendChild(text)

    const reload = document.createElement('button')
    reload.className = 'btn primary'
    reload.textContent = this.dirty ? 'Discard mine, reload' : 'Reload'
    reload.addEventListener('click', () => void this.resolveConflict('reload'))
    this.conflictBar.appendChild(reload)

    const keep = document.createElement('button')
    keep.className = 'btn'
    keep.textContent = this.dirty ? 'Keep mine' : 'Keep what is open'
    keep.title = this.dirty
      ? 'Your version stays, and saving overwrites what is on disk now.'
      : 'The tab stays as it is. Saving overwrites what is on disk now.'
    keep.addEventListener('click', () => void this.resolveConflict('keep'))
    this.conflictBar.appendChild(keep)

    this.conflictBar.hidden = false
    this.syncChrome()
  }

  /**
   * `keep` takes the current stamp without reading: the pane is deliberately
   * out of date now, and saying so once is enough — the same change must not
   * come back a second time asking the same question.
   */
  private async resolveConflict(choice: 'reload' | 'keep'): Promise<void> {
    this.conflict = false
    this.conflictBar.hidden = true
    if (choice === 'reload') {
      await this.load(true)
    } else {
      this.stamp = await backend().fileStamp(this.path)
    }
    if (this.disposed) return
    this.syncChrome()
    if (choice === 'keep') this.focusEditor()
  }

  /**
   * Reads the file in.
   *
   * Unsaved text always wins over a background re-read: the write for it is
   * already scheduled, so the newer version is the one in front of you. Only
   * **Reload** overrules that, which is the whole reason the button exists.
   */
  private async load(force = false): Promise<void> {
    if (this.disposed) return
    if (this.dirty && !force) return
    this.path = this.resolvePath()
    this.pathLabel.textContent = this.path || 'Untitled'
    this.pathLabel.title = this.path
      ? `${this.path} — click to open another file`
      : 'Untitled — click to open a file, or just type and Ctrl+S'
    if (!this.path) {
      // Untitled: an empty editor, ready to type into. Nothing to read.
      this.clearBlock()
      this.stamp = null
      this.syncChrome()
      return
    }

    // A read is now the truth, whatever a bar was asking about a moment ago.
    this.conflict = false
    this.conflictBar.hidden = true

    if (this.mode === 'hex') return this.loadBytes()

    let text: string
    try {
      // Stamped *before* the read, not after: a write landing between the two
      // would otherwise be stamped as though we had read it, and the change
      // would go unnoticed for good. This way the stamp can only be too old,
      // which costs one question and never a silent overwrite.
      this.stamp = await backend().fileStamp(this.path)
      text = await backend().readText(this.path)
    } catch (err) {
      if (this.disposed) return
      if (isMissing(err)) {
        // Nothing there yet. The editor stays open and empty; the first thing
        // typed is what creates the file.
        this.clearBlock()
        this.adopt('')
      } else {
        this.blocked = messageOf(err)
        this.showBlocked()
      }
      return
    }
    if (this.disposed) return
    this.clearBlock()
    this.adopt(text)
  }

  /** The hex view's own read: the bytes, not the text. */
  private async loadBytes(): Promise<void> {
    try {
      const { base64, size, truncated } = await backend().readBytes(this.path)
      if (this.disposed) return
      this.clearBlock()
      this.hex.show(decode(base64), size, truncated)
    } catch (err) {
      if (this.disposed) return
      this.blocked = messageOf(err)
      this.showBlocked()
    }
    this.syncChrome()
  }

  private clearBlock(): void {
    this.blocked = null
    this.element.querySelector('.notes-blocked')?.remove()
    this.applyMode()
  }

  /**
   * Takes disk content as the truth, without disturbing an edit in progress.
   *
   * Line endings are normalised here and restored in `save`. The editor works
   * in `\n` throughout — a `\r` reaching it draws a line that is not in the
   * document, see `normalizeNewlines` — but a CRLF file must go back to disk as
   * one, or opening a Windows-authored file and touching a word in it would
   * rewrite every line and show up as a whole-file diff.
   *
   * `saved` is normalised along with it, deliberately: `dirty` compares the two,
   * and normalising only one would leave every CRLF file permanently dirty and
   * autosave rewriting it seconds after it opened.
   */
  private adopt(text: string): void {
    this.eol = dominantEol(text)
    const normalized = normalizeNewlines(text)
    this.saved = normalized
    this.showText(normalized)
    this.syncChrome()
  }

  private onEdit(): void {
    this.failed = false
    this.syncChrome()
    if (!this.autosaves) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save()
    }, AUTOSAVE_MS)
  }

  /**
   * Ctrl+S and the Save button: write, having asked where when there is no file.
   *
   * The only path that writes bytes. `flush` is the automatic one, and it is
   * deliberately not allowed to.
   */
  private async saveAs(): Promise<boolean> {
    if (!this.path && this.dirty && !(await this.chooseDestination())) return false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.save(true)
  }

  /** Writes now rather than in a moment — the automatic save. */
  private async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.save()
  }

  /**
   * Writes the file out.
   *
   * A write already in flight is not interrupted — what arrived while it ran is
   * written by the save the edit handler has already queued.
   */
  private async save(explicit = false): Promise<boolean> {
    if (this.blocked || this.saving || !this.dirty) return !this.dirty
    // An untitled tab has nowhere to write yet. Autosave leaves it alone and
    // says so; asking mid-sentence would be worse than not saving.
    if (!this.path) return false
    // With autosave off, nothing but the button and Ctrl+S writes: losing
    // focus, switching tabs and closing the window all leave the file as it was.
    if (!this.autosaves && !explicit) return false
    // Somebody else's write is sitting unanswered. An automatic save here is
    // the accident this whole mechanism exists to prevent, so it does not
    // happen; Ctrl+S still can, because that is a person deciding, but it says
    // what it is about to destroy first.
    if (this.conflict) {
      if (!explicit) return false
      const ok = await confirmDialog({
        title: 'Overwrite the newer file?',
        body: `${this.path} changed on disk after this tab read it. Saving replaces that version with the one here, and what the other program wrote is gone.`,
        confirmLabel: 'Overwrite',
        danger: true,
      })
      if (!ok) return false
      this.conflict = false
      this.conflictBar.hidden = true
    }
    this.saving = true
    this.syncChrome()
    try {
      if (this.mode === 'hex') {
        // Only the bytes that changed, at the offsets they changed: the view
        // may be holding one megabyte of a file that is four hundred.
        for (const patch of this.hex.patches()) {
          await backend().patchBytes(this.path, patch.offset, encode(patch.bytes))
        }
        this.hex.accept()
      } else {
        // Back out to whatever the file already used. `saved` keeps the
        // normalised form, because that is what `dirty` compares against.
        const text = this.text
        await backend().files.writeText(this.path, this.eol === '\r\n' ? toCrlf(text) : text)
        this.saved = text
      }
    } catch (err) {
      this.saving = false
      this.failed = true
      this.syncChrome()
      showToast('Could not save', messageOf(err), { kind: 'error' })
      return false
    }
    this.saving = false
    this.failed = false
    // Our own write is not an external change. Stamped before the event below,
    // or this pane would hear its own save and ask about it.
    this.stamp = await backend().fileStamp(this.path)
    if (this.disposed) return true
    this.syncChrome()
    // Any other pane showing this file — a reader, another editor tab — hears
    // this and re-reads.
    window.dispatchEvent(new CustomEvent('notes-changed'))
    return true
  }

  // --------------------------------------------------------------- the chrome

  /** Everything the pane owns; each view handles its own keys underneath. */
  private onKey(e: KeyboardEvent): void {
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const take = () => {
      e.preventDefault()
      e.stopPropagation()
    }

    if (ctrl && key === 's') {
      take()
      void this.saveAs()
      return
    }
    if (ctrl && key === 'f') {
      take()
      this.openFind(false)
      return
    }
    // Unshifted, and it matters. The app's global handler runs in the capture
    // phase at the window, so a shortcut it claims has already fired by the
    // time this sees the key — and this pane is a contenteditable div rather
    // than a textarea, which is what `isTypingInField` looks for, so nothing
    // upstream holds the key back on our behalf. Ctrl+Shift+H is the project's
    // history there; leaving Shift unchecked here would open both.
    if (ctrl && !e.shiftKey && key === 'h') {
      take()
      this.openFind(true)
      return
    }
    if (e.key === 'F3') {
      take()
      this.find.open ? this.element.querySelector<HTMLInputElement>('.find-input')?.focus() : this.openFind(false)
      return
    }
    if (e.key === 'Escape') {
      take()
      if (this.find.open) {
        this.find.hide()
        this.focusEditor()
        return
      }
      // Nothing to escape *from* otherwise, so it means "I am done typing":
      // write the file out and give the keyboard back to the terminal.
      ;(document.activeElement as HTMLElement | null)?.blur()
      return
    }

    if (!this.isText) return

    if (ctrl && key === 'd') {
      take()
      this.run(duplicateLines)
      return
    }
    if (ctrl && e.shiftKey && key === 'k') {
      take()
      this.run(deleteLines)
      return
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      take()
      this.run((text, span) => moveLines(text, span, e.key === 'ArrowUp' ? -1 : 1))
      return
    }
    // Ctrl+/ on every keyboard layout that has one, and Ctrl+7 on the German
    // ones where slash *is* shift-7.
    if (ctrl && (key === '/' || key === '7')) {
      take()
      const marker = this.commentMarker()
      if (marker) this.run((text, span) => toggleComment(text, span, marker))
      return
    }
    if (ctrl && e.shiftKey && key === 'u') {
      take()
      this.run((text, span) => changeCase(text, span, 'upper'))
      return
    }
    if (ctrl && e.shiftKey && key === 'l') {
      take()
      this.run((text, span) => changeCase(text, span, 'lower'))
    }
  }

  /**
   * The pane's own menu.
   *
   * Eight items, with the long lists behind two categories. A flat menu of
   * twenty operations is one nobody reads to the bottom of, and the two that
   * are long — line operations, case — are exactly the two whose members share
   * a verb, so a category names them without listing them.
   *
   * The selection is captured here, once. Clicking a menu button takes the
   * document selection out of the editor, so every command below is handed the
   * selection as it was when the menu opened.
   */
  private openMenu(e: MouseEvent): void {
    const selected = this.selectedText()
    const span = this.isText ? this.live.selection() : { from: 0, to: 0 }
    const href = LiveText.linkAt(e.target)
    const text = this.mode === 'hex' ? '' : this.text
    const marker = this.commentMarker()
    const pane = store.pane(this.paneId)
    const on = (op: (t: string, s: Span) => Edit) => () => this.run(op, span)

    const entries: MenuEntry[] = [
      {
        label: 'Copy',
        shortcut: 'Ctrl+C',
        disabled: !selected,
        onClick: () => void copyText(selected, summarise(selected)),
      },
      {
        label: 'Copy whole file',
        disabled: !text,
        onClick: () => void copyText(text, summarise(text)),
      },
      { label: 'Select all', onClick: () => this.selectAll() },
    ]

    if (this.isText) {
      entries.push(
        'separator',
        { label: 'Find…', shortcut: 'Ctrl+F', onClick: () => this.openFind(false) },
        { label: 'Replace…', shortcut: 'Ctrl+H', onClick: () => this.openFind(true) },
        'separator',
        {
          label: 'Lines',
          submenu: [
            { label: 'Duplicate', shortcut: 'Ctrl+D', onClick: on(duplicateLines) },
            { label: 'Delete', shortcut: 'Ctrl+Shift+K', onClick: on(deleteLines) },
            { label: 'Move up', shortcut: 'Alt+↑', onClick: on((t, s) => moveLines(t, s, -1)) },
            { label: 'Move down', shortcut: 'Alt+↓', onClick: on((t, s) => moveLines(t, s, 1)) },
            'separator',
            { label: 'Sort A→Z', onClick: on((t, s) => sortLines(t, s)) },
            { label: 'Sort Z→A', onClick: on((t, s) => sortLines(t, s, true)) },
            { label: 'Reverse', onClick: on(reverseLines) },
            'separator',
            { label: 'Remove empty lines', onClick: on(removeEmptyLines) },
            { label: 'Remove duplicate lines', onClick: on(removeDuplicateLines) },
            { label: 'Trim trailing spaces', onClick: on(trimTrailing) },
            { label: 'Join into one line', onClick: on(joinLines) },
          ],
        },
        {
          label: 'Change case',
          submenu: (['upper', 'lower', 'title'] as CaseKind[]).map((kind) => ({
            label: { upper: 'UPPER CASE', lower: 'lower case', title: 'Title Case' }[kind],
            onClick: on((t, s) => changeCase(t, s, kind)),
          })),
        },
        {
          label: 'Comment / uncomment',
          shortcut: 'Ctrl+/',
          disabled: !marker,
          onClick: on((t, s) => toggleComment(t, s, marker)),
        }
      )
    }

    entries.push('separator', {
      label: 'View',
      submenu: [
        {
          label: 'Autosave',
          checked: this.autosaves,
          disabled: this.mode === 'hex',
          onClick: () => this.toggleAutosave(),
        },
        {
          label: 'Word wrap',
          checked: pane?.wordWrap ?? (this.mode === 'markdown' || this.mode === 'text'),
          disabled: !this.isText,
          onClick: () => this.toggleWrap(),
        },
        {
          label: 'Line numbers',
          checked: this.numbersOn,
          disabled: !this.isText,
          onClick: () => this.toggleNumbers(),
        },
        {
          label: `Column guide (${COLUMN_GUIDE})`,
          checked: this.guideOn,
          disabled: !this.isText,
          onClick: () => this.toggleColumnGuide(),
        },
      ],
    })

    entries.push(
      { label: 'Open another file…', onClick: () => void this.chooseFile() },
      { label: 'Copy path', disabled: !this.path, onClick: () => void copyText(this.path) }
    )

    if (href) {
      entries.push(
        'separator',
        { label: 'Open link', onClick: () => void backend().openExternal(href) },
        { label: 'Copy link', onClick: () => void copyText(href) }
      )
    }
    showContextMenu(e.clientX, e.clientY, entries)
  }

  /** What is highlighted, wherever it is highlighted. */
  private selectedText(): string {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return ''
    const inside = this.views().some((view) => view.contains(selection.anchorNode))
    return inside ? selection.toString() : ''
  }

  private selectAll(): void {
    if (this.isText) {
      this.live.selectAll()
      return
    }
    const target = this.views().find((view) => !view.hidden)
    const selection = window.getSelection()
    if (!target || !selection) return
    const range = document.createRange()
    range.selectNodeContents(target)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  /** Suppresses the terminal focus grab for as long as a view has focus. */
  private holdFocus(hold: boolean): void {
    if (hold === this.holdingFocus) return
    this.holdingFocus = hold
    if (hold) beginEditing()
    else endEditing()
  }

  private syncChrome(): void {
    const waiting = this.dirty && !this.autosaves && !this.saving
    const state = this.blocked
      ? 'blocked'
      : this.failed
        ? 'failed'
        : this.readOnly && this.mode !== 'hex'
          ? 'readonly'
          : waiting
            ? 'unsaved'
            : this.saving || this.dirty
              ? 'saving'
              : 'saved'

    this.status.dataset.state = state
    const bytes = this.hex.changedCount
    this.status.textContent = {
      blocked: 'Cannot open',
      failed: 'Not saved',
      readonly: 'Read-only',
      // In hex the unit that changed is the interesting number; in text it is
      // just "there is something unwritten".
      unsaved:
        this.mode === 'hex'
          ? `${bytes} byte${bytes === 1 ? '' : 's'} changed — not saved`
          : 'Unsaved changes',
      saving: 'Saving…',
      saved: 'Saved',
    }[state]

    this.saveBtn.disabled = !this.dirty || this.saving || Boolean(this.blocked)

    // Said in words, not in a shade of grey. A switch whose state you have to
    // infer from its colour is a switch you check by trying it, and this one
    // decides whether your typing is being kept.
    const auto = this.autosaves
    this.autoBtn.textContent = auto ? 'Autosave on' : 'Autosave off'
    this.autoBtn.classList.toggle('on', auto)
    this.autoBtn.classList.toggle('off', !auto)
    this.autoBtn.disabled = this.mode === 'hex' || this.readOnly
    this.autoBtn.title =
      this.mode === 'hex'
        ? 'Always off in hex: a byte written by accident can break a file silently'
        : auto
          ? 'On — the file is written a moment after you stop typing. Click to turn off.'
          : 'Off — nothing is written until you press Save. Click to turn on.'
  }

  /** A file we could not read, and therefore will not write over. */
  private showBlocked(): void {
    this.applyMode()
    this.element.querySelector('.notes-blocked')?.remove()
    const box = document.createElement('div')
    box.className = 'notes-empty notes-blocked'
    const line = document.createElement('p')
    line.className = 'reader-error'
    line.textContent = `Cannot open this file: ${this.blocked}`
    box.appendChild(line)
    const hint = document.createElement('p')
    hint.className = 'notes-hint'
    hint.textContent = this.path
    box.appendChild(hint)
    // Being stuck on one unreadable file is not a reason to be stuck.
    const open = document.createElement('button')
    open.className = 'btn primary'
    open.textContent = 'Open another file…'
    open.addEventListener('click', () => void this.chooseFile())
    box.appendChild(open)
    this.element.appendChild(box)
    this.syncChrome()
  }

  dispose(): void {
    // A pane can close with the file a keystroke old — closing a tab, switching
    // layouts — and losing that because the debounce had not fired yet would be
    // the one unforgivable bug in an editor.
    if (this.timer) clearTimeout(this.timer)
    // Unsaved *text* is written out — losing a sentence to a closing tab is the
    // one unforgivable bug in an editor. Unsaved *bytes* are dropped, for the
    // same reason they are not autosaved: a write nobody asked for is worse
    // than an edit nobody kept.
    // …but not over a change this pane was still asking about. A tab closed
    // with the bar up has said nothing about which version wins, and writing on
    // the way out would answer for it — silently, at the one moment nobody is
    // looking at the pane.
    if (this.dirty && this.path && !this.blocked && !this.conflict && this.autosaves) {
      const text = this.text
      void backend()
        .files.writeText(this.path, this.eol === '\r\n' ? toCrlf(text) : text)
        .catch(() => {})
    }
    this.disposed = true
    if (this.watchTimer) clearInterval(this.watchTimer)
    this.holdFocus(false)
    window.removeEventListener('editor-mode', this.onModeEvent as EventListener)
    window.removeEventListener('editor-open', this.onOpenEvent as EventListener)
    window.removeEventListener('focus', this.onFocus)
    window.removeEventListener('blur', this.onLeave)
    window.removeEventListener('beforeunload', this.onLeave)
    window.removeEventListener('notes-changed', this.onFocus)
  }
}

function emptyNote(text: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'notes-empty'
  const line = document.createElement('p')
  line.textContent = text
  box.appendChild(line)
  return box
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Whether a failed read means "not there yet" rather than "do not touch". */
function isMissing(err: unknown): boolean {
  return /ENOENT|no such file|cannot find/i.test(messageOf(err))
}

/** A confirmation toast should say what was copied, not recite it back. */
function summarise(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 1) return `${lines.length} lines`
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
