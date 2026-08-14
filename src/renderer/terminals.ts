import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { backend } from '../backend'
import { store, paneLabel, shellFor } from './state'
import { activeTerminalTheme, isTranslucent, terminalBackdrop, xtermTheme } from './themes'
import { isEditing } from './ui/editing'
import { FilesPane, type FilesPaneHooks } from './filesPane'
import { ReaderPane, type ReaderPaneHooks } from './readerPane'
import { EditorPane, type EditorPaneHooks } from './editorPane'
import { GitPane, viewForKind } from './git/gitPane'
import { gitRoot } from './git/common'
import { ComparePane } from './comparePane'
import { SearchPane, type SearchPaneHooks } from './searchPane'
import { PortsPane, type PortsPaneHooks } from './portsPane'
import { ImagesPane, type ImagesPaneHooks } from './imagesPane'
import { BrowserPane, DEFAULT_URL } from './browserPane'
import { attachInlineEditor } from './ui/editing'
import { showContextMenu } from './ui/contextMenu'
import { beginDrag, draggingTab, endDrag } from './ui/dragState'
import { isMac, isPrimary } from './ui/keys'
import { DomZoom, UnavailablePane, type AuxPane, type PaneZoom } from './auxPane'
import { bufferWhileHidden, clearPending, drainPending } from './paneBuffer'
import { programWheelDriver } from './programWheel'
import { fallbackCwd } from '../shared/platform'
import type { DropSide } from './state'
import { isTerminalPane } from '../shared/types'
import type { PaneNode, PaneState, Settings, TerminalTabState } from '../shared/types'

/**
 * `#rrggbb` in the `rgb:rrrr/gggg/bbbb` form terminals reply with. Each
 * channel is doubled because the format is 16 bits per channel.
 */
function toXColor(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) return 'rgb:0000/0000/0000'
  return `rgb:${m[1]}${m[1]}/${m[2]}${m[2]}/${m[3]}${m[3]}`
}

/** Pane-level commands the app shell owns (they touch state and re-mount). */
export interface PaneHooks {
  closePane(paneId: string): void
  split(direction: 'row' | 'column'): void
  merge(keepId: string): void
  movePane(tabId: string, sourceId: string, targetId: string, side: DropSide): void
  /** A whole tab dropped beside a pane: its panes graft in, its tab goes. */
  dropTabIntoPane(tabId: string, targetPaneId: string, side: DropSide): void
  remount(): void
}

interface Instance {
  paneId: string
  workspaceId: string
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  /** Wrapper reparented between the layout tree and the offscreen pool. */
  element: HTMLDivElement
  /** Kept so it can be dropped when the theme turns translucent. */
  webgl: WebglAddon | null
  /** Overlay shown when the pane's agent says it is waiting on a human. */
  blockedBar: HTMLDivElement
  /** What the overlay currently shows, so renders don't rebuild it needlessly. */
  blockedSignature: string
  spawned: boolean
  disposed: boolean
  /** Last size sent to the PTY, to avoid redundant resize round-trips. */
  lastCols: number
  lastRows: number
  /**
   * True while this pane's tab is not the one on screen.
   *
   * A hidden pane costs exactly as much as a visible one — measured at ~86 ms
   * of main thread per megabyte, with no discount at all for being invisible,
   * because `hidden` stops the painting and nothing stops the parsing. Three
   * hidden panes taking a build's output between them cost 161 ms of the same
   * thread the pane you *are* looking at needs.
   *
   * So while this is set the bytes are buffered instead of parsed. Nothing
   * observable is lost: the pane's title, folder, activity state, alerts and
   * scrollback are all produced in the main process from the byte stream, not
   * read off the screen, so they stay live for a pane that is not rendering.
   */
  deferred: boolean
  /** Bytes that arrived while deferred, replayed on reveal. See `PENDING_CAP`. */
  pending: string[]
  pendingBytes: number
  /** Set when the buffer overflowed and the oldest output had to be dropped. */
  pendingTruncated: boolean
}

export class TerminalManager {
  private readonly instances = new Map<string, Instance>()
  /** Every mounted pane that is not a shell, by pane id. */
  private readonly aux = new Map<string, AuxPane>()
  private filesHooks: FilesPaneHooks | null = null
  private readerHooks: ReaderPaneHooks | null = null
  private editorHooks: EditorPaneHooks | null = null
  private portsHooks: PortsPaneHooks | null = null
  private imagesHooks: ImagesPaneHooks | null = null
  private searchHooks: SearchPaneHooks | null = null
  private paneHooks: PaneHooks | null = null
  /** Pane being dragged by its header, so drop targets know what to expect. */
  private dragging: string | null = null
  private renamingPane: string | null = null
  private readonly host: HTMLElement
  /** Holds a pane between being created and first being laid out. */
  private readonly pool: HTMLElement
  /**
   * Each tab's built pane tree, kept so switching tabs does not rebuild it.
   *
   * Keyed by tab id, and dropped when the tab closes. The signature is what
   * the tree was built from, so a layout change is noticed and a plain switch
   * is not.
   */
  private readonly trees = new Map<string, { element: HTMLElement; signature: string }>()
  private readonly resizeObserver: ResizeObserver
  private mountedTabId: string | null = null
  /** Bumped on every layout render so stale async fits can be discarded. */
  private layoutToken = 0
  /**
   * Panes whose shell has been started at least once this run. An agent session
   * is resumed on the first start only — mounting a tab again, or restarting a
   * shell that exited, must not re-enter the conversation behind your back.
   */
  private readonly startedOnce = new Set<string>()

  constructor(host: HTMLElement) {
    this.host = host

    this.pool = document.createElement('div')
    this.pool.className = 'pane-pool'
    this.pool.hidden = true
    host.parentElement?.appendChild(this.pool)

    this.resizeObserver = new ResizeObserver(() => this.fitAll())
    this.resizeObserver.observe(host)

    // A drag that ends anywhere — dropped on nothing, or cancelled with Escape
    // — leaves whichever pane the cursor was last over still lit up. `drop` and
    // `dragleave` cover the ordinary paths; this covers the rest.
    document.addEventListener('dragend', () => this.clearDropHints())

    backend().on.ptyData(({ paneId, data }) => {
      const inst = this.instances.get(paneId)
      if (!inst || inst.disposed) return
      if (inst.deferred) bufferWhileHidden(inst, data)
      else inst.term.write(data)
    })

    backend().on.ptyExit(({ paneId, exitCode }) => {
      const inst = this.instances.get(paneId)
      if (!inst || inst.disposed) return
      inst.spawned = false
      const note = `\r\n\x1b[38;5;244m[process exited with code ${exitCode}]\x1b[0m\r\n`
      // Through the same gate as ordinary output, so it lands *after* whatever
      // the shell printed on its way out rather than ahead of it.
      if (inst.deferred) bufferWhileHidden(inst, note)
      else inst.term.write(note)
    })

    backend().on.ptyMeta(({ paneId, cwd, title, agentSession, lastCommand }) => {
      store.updatePaneMeta(paneId, { cwd, title, agentSession, lastCommand })
    })
  }

  // ------------------------------------------------------------- instances

  private ensure(paneId: string, workspaceId: string): Instance {
    const existing = this.instances.get(paneId)
    if (existing) {
      existing.workspaceId = workspaceId
      return existing
    }

    const settings = store.settings
    const element = document.createElement('div')
    element.className = 'pane'
    element.dataset.paneId = paneId

    const term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: false,
      theme: xtermTheme(settings),
      // Without this xterm draws its background opaque and the alpha in the
      // theme is ignored entirely.
      allowTransparency: isTranslucent(settings),
      // ConPTY already reflows; letting xterm do it too double-wraps.
      windowsPty: { backend: 'conpty' },
    })

    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(new WebLinksAddon((_e, uri) => void backend().openExternal(uri)))

    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    // Must be in the document before open() or xterm measures a zero cell.
    this.pool.appendChild(element)
    term.open(element)

    // WebGL is a large speedup but renders its background opaque, so it can't
    // be used with a translucent theme. It also fails on some drivers.
    let webgl: WebglAddon | null = null
    if (!isTranslucent(settings)) {
      try {
        webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl?.dispose())
        term.loadAddon(webgl)
      } catch {
        webgl = null // DOM renderer is fine
      }
    }

    // TUIs query the terminal's own colours (OSC 10 foreground, 11 background)
    // to decide whether they are on a light or dark background and tune their
    // palette. Windows Terminal answers; xterm.js does not, so an unanswered
    // query leaves the program guessing — which is why the same tool can look
    // different here than in a native terminal.
    const answerColor = (code: number, pick: () => string) => (data: string) => {
      if (data !== '?') return false
      void backend().pty.write(paneId, `\x1b]${code};${toXColor(pick())}\x07`)
      return true
    }
    term.parser.registerOscHandler(
      10,
      answerColor(10, () => activeTerminalTheme(store.settings).terminal.foreground)
    )
    term.parser.registerOscHandler(
      11,
      answerColor(11, () => activeTerminalTheme(store.settings).terminal.background)
    )

    term.onData((data) => void backend().pty.write(paneId, data))
    term.onBinary((data) => void backend().pty.write(paneId, data))
    term.attachCustomKeyEventHandler((e) => this.handleKey(e, term, paneId))

    // Clicking anywhere in a pane makes it the active one.
    element.addEventListener('mousedown', () => {
      const tab = store.tabOfPane(paneId)
      if (tab && tab.activePaneId !== paneId) {
        store.setActivePane(tab.id, paneId)
      }
    })

    // Dropping a row from the file tree inserts its path at the cursor.
    element.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('application/x-iaw-path')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    })
    element.addEventListener('drop', (e) => {
      // Only a row from our own file tree. This used to take any `text/plain`,
      // which meant a tab dragged onto a terminal typed its id into the shell —
      // and, before there was anything to drag onto a pane, that text dragged
      // in from any other application went straight into it. The `dragover`
      // above already only accepts this type; the drop now agrees with it.
      const path = e.dataTransfer?.getData('application/x-iaw-path')
      if (!path) return
      e.preventDefault()
      e.stopPropagation()
      void backend().pty.write(paneId, path)
    })

    // Right-click copies a selection, or pastes when there isn't one — the
    // Windows Terminal convention, and what Claude Code users expect.
    element.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (term.hasSelection()) {
        void this.copy(term).then(() => term.clearSelection())
        return
      }
      // A program that has turned mouse reporting on has *already been sent
      // this click* by xterm, before this listener ever runs. If it pastes on
      // right-click — Claude Code does — the clipboard is in the pane before we
      // decide to put it there, and ours lands as a second copy. That is the
      // double paste, and it is why it only happens inside a full-screen
      // program and never at a bare prompt.
      //
      // So the click belongs to whoever asked for it. This is what Windows
      // Terminal does too: the application wins the mouse while it wants it.
      //
      // Shift is the override, and it is the same override every terminal has:
      // a shifted mouse event is never reported to the program, so there is
      // nothing to collide with and the pane can paste after all. That matters
      // for the full-screen program that grabs the mouse and has no paste of
      // its own — without it, right-click paste would simply vanish in there.
      //
      // macOS is exempt, and the platform decides that rather than us: the
      // secondary click belongs to the application there, which is why
      // Terminal.app and iTerm2 both keep it for their own menu and no Mac TUI
      // is written expecting one. Handing it over cost the pane its paste and
      // bought nothing — Claude Code, measured, is sent the report and does
      // nothing with it at all.
      if (!e.shiftKey && !isMac() && term.modes.mouseTrackingMode !== 'none') return
      void this.paste(term, paneId)
    })

    // Ctrl+wheel zooms, as in every browser and terminal.
    //
    // Capture phase, not bubble: xterm's viewport swallows the wheel event
    // (preventDefault + stopPropagation) whenever the pane has scrollback to
    // scroll, so a listener on the way back up never runs — which is why zoom
    // died precisely inside long-running TUIs like Claude Code and still
    // worked on a fresh prompt. Passive:false so preventDefault sticks and the
    // page doesn't zoom instead.
    element.addEventListener(
      'wheel',
      (e) => {
        // Cmd+scroll on a Mac: Ctrl+scroll there is the system's own screen
        // zoom, and fighting it would be both rude and unwinnable.
        if (!isPrimary(e)) return
        e.preventDefault()
        e.stopPropagation()
        if (e.deltaY === 0) return
        this.adjustFontSize(e.deltaY < 0 ? 1 : -1)
      },
      { passive: false, capture: true }
    )

    term.attachCustomWheelEventHandler(programWheelDriver(term, element))

    // Absolutely positioned, so it never enters xterm's size measurement.
    const blockedBar = document.createElement('div')
    blockedBar.className = 'pane-blocked'
    blockedBar.hidden = true
    element.appendChild(blockedBar)

    const inst: Instance = {
      paneId,
      workspaceId,
      term,
      fit,
      search,
      element,
      webgl,
      blockedBar,
      blockedSignature: '',
      spawned: false,
      disposed: false,
      lastCols: 0,
      lastRows: 0,
      // A pane is created for the tab being mounted, so it starts awake. The
      // next tab change decides properly for every pane at once.
      deferred: false,
      pending: [],
      pendingBytes: 0,
      pendingTruncated: false,
    }
    this.instances.set(paneId, inst)
    return inst
  }

  /**
   * Copy, paste and interrupt — the one place macOS is genuinely easier.
   *
   * On Windows and Linux, Ctrl+C has to be two things at once, and the only way
   * to tell them apart is whether a selection exists: with one, copy; without
   * one, let SIGINT through. It works, but it is a guess about intent, and it
   * is why `copyOnSelectionCtrlC` is a setting rather than just being how the
   * terminal behaves.
   *
   * A Mac has no such problem. Cmd+C copies and Ctrl+C interrupts, always,
   * because they are different keys — so the ambiguity never arises and the
   * selection heuristic is skipped entirely. Ctrl+C reaches the shell every
   * time, even with half the scrollback selected.
   */
  private handleKey(e: KeyboardEvent, term: Terminal, paneId: string): boolean {
    if (e.type !== 'keydown') return true

    // Cmd+C / Cmd+V on a Mac, and Ctrl+Shift+C / Ctrl+Shift+V elsewhere: both
    // are the platform's ordinary copy and paste for a terminal.
    const copyCombo = isPrimary(e) && (isMac() || e.shiftKey) && e.code === 'KeyC'
    const pasteCombo = isPrimary(e) && (isMac() || e.shiftKey) && e.code === 'KeyV'

    // `preventDefault` on both, and it is load-bearing on the Mac half.
    // Returning false stops *xterm* handling the key; it does not stop the
    // browser, which xterm's own `_keyDown` makes plain — it returns early
    // without cancelling anything. So Cmd+V went on to fire Chromium's paste
    // command on xterm's hidden textarea, xterm pasted that too, and every
    // Cmd+V landed twice. (Electron's default Edit menu is not the culprit,
    // though it does show Cmd+V: those roles carry `registerAccelerator:
    // false` precisely so the keystroke reaches the page instead.)
    //
    // The Ctrl+V branch below has always cancelled for this reason. This is
    // the same bug in the branch that forgot to.
    if (copyCombo) {
      e.preventDefault()
      void this.copy(term)
      return false
    }
    if (pasteCombo) {
      e.preventDefault()
      void this.paste(term, paneId)
      return false
    }

    // Everything below is about Ctrl specifically, and only where Ctrl is also
    // the app's modifier. On a Mac these fall through untouched, which is the
    // whole point: Ctrl belongs to the shell there.
    if (!isMac()) {
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyC' && store.settings.copyOnSelectionCtrlC) {
        if (term.hasSelection()) {
          void this.copy(term)
          return false
        }
        return true // no selection: let SIGINT through
      }
      // Ctrl+V and Shift+Insert used to be left to the browser's own paste
      // event, which xterm already listens for. That event only ever carries
      // *text*: with an image on the clipboard it fires empty and the paste
      // silently does nothing, which is why a screenshot could not be pasted
      // into a pane with the key everyone reaches for. They go through `paste`
      // now, like every other route into it.
      //
      // `preventDefault` is what makes that safe — without it the browser
      // raises its paste event too and the clipboard lands twice.
      if (e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
        e.preventDefault()
        void this.paste(term, paneId)
        return false
      }
    }

    if (e.shiftKey && e.code === 'Insert') {
      e.preventDefault()
      void this.paste(term, paneId)
      return false
    }
    return true
  }

  private async copy(term: Terminal): Promise<void> {
    const text = term.getSelection()
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      /* clipboard can be denied; nothing useful to do */
    }
  }

  /**
   * Paste, with an image on the clipboard becoming something the pane can use.
   *
   * Text is text. An image is the interesting case, and there are two ways to
   * hand one over:
   *
   * **The program reads the clipboard itself.** Every agent CLI worth the name
   * does — Claude Code binds Ctrl+V to its own image paste and shells out to
   * PowerShell for the bitmap, which is how a screenshot becomes an attachment
   * rather than a filename. All it needs is to *see* the keystroke, so for a
   * pane running an agent the raw `Ctrl+V` byte is forwarded and we get out of
   * the way. This pane used to swallow that key, which is exactly why pasting
   * a screenshot into an agent did nothing at all.
   *
   * **Otherwise, a path.** A plain shell has no idea what a bitmap is, so the
   * image is written to a temp file and its path is typed in — the same
   * gesture as dropping an image into a chat, from any Windows capture tool.
   */
  private async paste(term: Terminal, paneId: string): Promise<void> {
    // Through `term.paste`, never `pty.write`. The difference is bracketed
    // paste: a shell that has turned it on expects pasted text wrapped in
    // `ESC [200~ … ESC [201~`, which is how it knows to take the whole thing as
    // one literal insertion. Written raw, the bytes arrive as if typed — so a
    // two-line command pasted at a prompt *runs its first line*, and a TUI gets
    // a burst of keystrokes rather than a paste.
    //
    // `term.paste` applies that wrapping, normalises the line endings, and
    // emits through the same `onData` that carries typing, so it still reaches
    // this pane's shell by the one path everything else uses.
    try {
      const text = await navigator.clipboard.readText()
      // Text first. It is the overwhelmingly common case and it is free,
      // whereas asking the host for an image costs a round trip — and on some
      // hosts a process spawn — that would otherwise be paid on every paste.
      if (text) {
        term.paste(text)
        return
      }
    } catch {
      /* clipboard can be denied; the image path may still work */
    }

    // No text. An agent handles its own clipboard, and does it better than we
    // can: it gets the pixels, where we could only ever get it a filename.
    // Sent through `pty.write` rather than `term.paste`, because this is a
    // keystroke and not a paste — bracketing it would hide it.
    if (store.paneAgent(paneId)) {
      void backend().pty.write(paneId, '\x16')
      return
    }

    try {
      const imagePath = await backend().pasteImage()
      // Quoted because a temp path can contain spaces, with a trailing space so
      // whatever the user types next doesn't run into it.
      if (imagePath) term.paste(`"${imagePath}" `)
    } catch {
      /* nothing pasteable */
    }
  }

  // ---------------------------------------------------------------- layout

  /**
   * Mounts a tab's pane tree. Panes are reparented rather than recreated, so
   * scrollback and running shells survive tab switches and re-splits.
   *
   * Each tab's tree is built once and kept, hidden when another tab is on
   * screen and shown again when it comes back. It used to be torn down and
   * rebuilt on every switch, which was invisible for a terminal — xterm does
   * not care where its element lives — and destructive for a browser pane: a
   * `<webview>`, like an `<iframe>`, is killed and recreated by the act of
   * being moved in the DOM. So visiting a browser tab reloaded the page, losing
   * scroll position, form state and anything the page held in memory.
   *
   * A rebuild still happens when the tab's *layout* changes — a split, a merge,
   * a pane dragged in or out — because then the tree genuinely is different.
   * That still reloads a browser pane in that tab, which is the honest limit of
   * this: the element has to move, and nothing can move a webview without
   * restarting it.
   */
  async showTab(workspaceId: string, tab: TerminalTabState): Promise<void> {
    const token = ++this.layoutToken
    this.mountedTabId = tab.id

    const signature = layoutSignature(tab)
    let entry = this.trees.get(tab.id)

    if (!entry || entry.signature !== signature) {
      // No parking pass here, unlike the old rebuild-everything path:
      // `buildNode` appends each pane's existing element, and appending an
      // element already in the document moves it. The panes this tab needs are
      // out of the old tree by the time it is dropped, wherever they were —
      // including in another tab's tree, which is how a dragged pane arrives.
      const built = this.buildNode(tab, tab.layout, [], workspaceId)
      entry?.element.remove()
      this.host.appendChild(built)
      entry = { element: built, signature }
      this.trees.set(tab.id, entry)
    }

    // Trees for tabs that have since been closed. Pruned here rather than by
    // the close path, because a tab can go in several ways — closed, dragged
    // into a pane, its whole workspace removed — and this notices all of them
    // without each having to remember.
    const alive = new Set(store.workspaces.flatMap((w) => w.tabs.map((t) => t.id)))
    for (const [id, other] of this.trees) {
      if (alive.has(id)) continue
      other.element.remove()
      this.trees.delete(id)
    }

    // `hidden` rather than removal, which is the whole point. Panes inside a
    // hidden tree measure zero, and `fit` already declines to resize a terminal
    // it cannot measure, so nothing downstream needs to know about this.
    for (const [id, other] of this.trees) other.element.hidden = id !== tab.id

    // `hidden` stops the painting; this stops the parsing, which is the part
    // that actually costs. Done here rather than inside the loop above because
    // a pane's tree and its instances are separate maps.
    this.setDeferred(tab.id)

    for (const pane of tab.panes) {
      this.elementOf(pane.id)?.classList.toggle('active', pane.id === tab.activePaneId)
    }

    // Measure only once laid out, otherwise every pane reads zero.
    await new Promise((r) => requestAnimationFrame(r))
    if (token !== this.layoutToken) return

    for (const pane of tab.panes) {
      const inst = this.instances.get(pane.id)
      if (inst) this.fit(inst)
    }

    await this.startPanes(workspaceId, tab)
    if (token !== this.layoutToken) return
    this.focusActive()
  }

  /** Wired by the app shell once, so file panes can drive terminals. */
  setFilesHooks(hooks: FilesPaneHooks): void {
    this.filesHooks = hooks
  }

  /** Wired by the app shell once, so a reader can hand off to your editor. */
  setReaderHooks(hooks: ReaderPaneHooks): void {
    this.readerHooks = hooks
  }

  /** Wired by the app shell once, so the editor can reach your other one. */
  setEditorHooks(hooks: EditorPaneHooks): void {
    this.editorHooks = hooks
  }

  /** Wired by the app shell once, so search results can be opened. */
  setSearchHooks(hooks: SearchPaneHooks): void {
    this.searchHooks = hooks
  }

  /** Wired by the app shell once, so the process list can reach its panes. */
  setPortsHooks(hooks: PortsPaneHooks): void {
    this.portsHooks = hooks
  }

  /** Wired by the app shell once, so the gallery can follow the file tree. */
  setImagesHooks(hooks: ImagesPaneHooks): void {
    this.imagesHooks = hooks
  }

  /**
   * Mounts the non-shell pane for a state, making it if it isn't there yet.
   *
   * The dispatch lives here and nowhere else: a new pane kind is a case in this
   * switch, a `PaneKind` value and a class implementing `AuxPane`.
   */
  private ensureAux(state: PaneState): AuxPane {
    const existing = this.aux.get(state.id)
    if (existing) return existing
    let pane: AuxPane
    switch (state.kind) {
      case 'reader':
        pane = new ReaderPane(state.id, state.file ?? '', this.readerHooks!)
        break
      case 'editor':
        pane = new EditorPane(state.id, workspaceIdOf(state.id), this.editorHooks!)
        break
      // Two names, one pane. See `viewForKind` for why both still exist.
      case 'diff':
      case 'history':
        pane = new GitPane(state.id, gitRoot(state.id), viewForKind(state.kind))
        break
      case 'compare':
        pane = new ComparePane(state.id)
        break
      case 'search':
        pane = new SearchPane(state.id, gitRoot(state.id), this.searchHooks!)
        break
      case 'ports':
        pane = new PortsPane(state.id, this.portsHooks!)
        break
      // The system readings are a dock now, not a tab — see `monitorDock.ts`.
      // The kind stays so a document written before that still round-trips
      // rather than being rewritten as a terminal, and the tab says where its
      // contents went. Deliberately not a second `MonitorPane`: that would be
      // a second poll of the machine, and the poll costs a process.
      case 'monitor':
        pane = new UnavailablePane(
          'The machine readings moved',
          'They are a panel now rather than a tab, because nothing they show belongs to one project. ' +
            'Press Ctrl+Shift+M to show it, and close this tab.'
        )
        break
      case 'images':
        pane = new ImagesPane(state.id, this.imagesHooks!)
        break
      case 'browser':
        pane = backend().capabilities.browser !== null
          ? new BrowserPane(state.id, state.url || store.settings.browserHome.trim() || DEFAULT_URL, {
              onUrlChange: (paneId, url) => store.setPaneUrl(paneId, url),
            })
          : new UnavailablePane(
              'No browser in this build',
              `This pane holds a web page, and the ${backend().name} build cannot show one. ` +
                'It is still here — open this workspace in the Electron build and the page comes back.'
            )
        break
      default:
        pane = new FilesPane(state.id, state.cwd, this.filesHooks!)
    }

    // Every pane zooms, and almost none of them had to be told how. A pane that
    // does not provide its own gets a `DomZoom` fitted here, so a new kind
    // added to the switch above arrives with Ctrl+scroll and Ctrl+0 already
    // working — which is the opposite of how this started, where zoom was a
    // thing the terminal had and the browser reimplemented.
    if (!pane.zoom) pane.zoom = new DomZoom(pane.element)
    attachZoomWheel(pane.element, pane.zoom)

    this.aux.set(state.id, pane)
    return pane
  }

  /**
   * How the focused pane zooms, for the keyboard shortcuts.
   *
   * Null for a terminal, which is not per-pane: font size is one setting shared
   * by every shell, deliberately, so that splitting a pane does not give you two
   * terminals at different sizes. The caller falls back to that.
   */
  activeZoom(): PaneZoom | null {
    const tab = store.activeTab
    if (!tab) return null
    return this.aux.get(tab.activePaneId)?.zoom ?? null
  }

  /** The file pane at this id, if that is what is there. */
  private filesAt(paneId: string): FilesPane | null {
    const pane = this.aux.get(paneId)
    return pane instanceof FilesPane ? pane : null
  }

  private buildNode(
    tab: TerminalTabState,
    node: PaneNode,
    path: number[],
    workspaceId: string
  ): HTMLElement {
    if (node.kind === 'leaf') {
      const state = tab.panes.find((p) => p.id === node.paneId)
      const body =
        state && state.kind && state.kind !== 'terminal'
          ? this.ensureAux(state).element
          : this.ensure(node.paneId, workspaceId).element

      if (!state) return body

      // The shell is always there, even for a lone pane: it is what makes the
      // pane a drop target, and a tab dragged onto a tab that holds one pane is
      // the commonest way this gets used. Only the header is conditional — a
      // name and a close button above a single pane is a wasted row.
      const shell = document.createElement('div')
      shell.className = 'pane-shell'
      shell.dataset.paneId = node.paneId
      if (tab.panes.length >= 2) shell.appendChild(this.buildPaneHeader(tab, state))
      shell.appendChild(body)
      this.wirePaneDrop(shell, tab, state.id)
      return shell
    }

    const container = document.createElement('div')
    container.className = `pane-split ${node.direction}`

    node.children.forEach((child, index) => {
      if (index > 0) {
        container.appendChild(this.buildDivider(tab, node, path, index, container))
      }
      const wrapper = document.createElement('div')
      wrapper.className = 'pane-slot'
      wrapper.style.flexGrow = String(node.sizes[index] ?? 1 / node.children.length)
      wrapper.appendChild(this.buildNode(tab, child, [...path, index], workspaceId))
      container.appendChild(wrapper)
    })

    return container
  }

  setPaneHooks(hooks: PaneHooks): void {
    this.paneHooks = hooks
  }

  /**
   * The bar above a pane when a tab is split: its name, and the controls that
   * only make sense once there is more than one pane.
   */
  private buildPaneHeader(tab: TerminalTabState, pane: PaneState): HTMLElement {
    const header = document.createElement('div')
    header.className = 'pane-header' + (pane.id === tab.activePaneId ? ' active' : '')
    // Only the header is draggable, so selecting text in a terminal still works.
    header.draggable = this.renamingPane !== pane.id

    const grip = document.createElement('span')
    grip.className = 'pane-grip'
    grip.textContent = '⠿'
    grip.title = 'Drag to move this pane'
    header.appendChild(grip)

    const indicator = store.paneIndicator(pane.id)
    if (indicator) {
      const dot = document.createElement('span')
      dot.className = `pane-state pane-state--${indicator}`
      dot.title =
        indicator === 'blocked'
          ? (store.paneAgent(pane.id)?.blockedReason ?? 'Waiting for you')
          : indicator === 'working'
            ? 'Agent working'
            : 'Producing output'
      header.appendChild(dot)
    }

    if (this.renamingPane === pane.id) {
      const input = document.createElement('input')
      input.className = 'pane-title-input'
      input.value = paneLabel(pane)
      input.spellcheck = false
      header.appendChild(input)
      attachInlineEditor(input, {
        onCommit: (value) => {
          this.renamingPane = null
          store.renamePane(pane.id, value)
        },
        onCancel: () => {
          this.renamingPane = null
          this.paneHooks?.remount()
        },
      })
    } else {
      const title = document.createElement('span')
      title.className = 'pane-title'
      title.textContent = paneLabel(pane)
      header.appendChild(title)

      const close = document.createElement('button')
      close.className = 'pane-close'
      close.textContent = '✕'
      close.title = 'Close pane (Ctrl+Shift+W)'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.paneHooks?.closePane(pane.id)
      })
      header.appendChild(close)
    }

    header.addEventListener('mousedown', () => store.setActivePane(tab.id, pane.id))
    header.addEventListener('dblclick', (e) => {
      e.preventDefault()
      this.beginRenamePane(pane.id)
    })
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.openPaneMenu(e.clientX, e.clientY, tab, pane)
    })

    header.addEventListener('dragstart', (e) => {
      this.dragging = pane.id
      // Announced through `dragState` as well as `dataTransfer`, because the
      // tab strip has to decide whether to light up during `dragover` — when
      // the payload is deliberately unreadable. Same reason tabs do it.
      beginDrag({ kind: 'pane', id: pane.id, from: tab.id })
      e.dataTransfer?.setData('application/x-iaw-pane', pane.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    header.addEventListener('dragend', () => {
      this.dragging = null
      endDrag()
      this.clearDropHints()
    })

    return header
  }

  beginRenamePane(paneId: string): void {
    this.renamingPane = paneId
    this.paneHooks?.remount()
  }

  private openPaneMenu(x: number, y: number, tab: TerminalTabState, pane: PaneState): void {
    showContextMenu(x, y, [
      { label: 'Rename pane…', shortcut: 'F2', onClick: () => this.beginRenamePane(pane.id) },
      'separator',
      { label: 'Split right', shortcut: 'Ctrl+\\', onClick: () => this.paneHooks?.split('row') },
      { label: 'Split down', shortcut: 'Ctrl+Shift+\\', onClick: () => this.paneHooks?.split('column') },
      {
        label: 'Merge into this pane',
        disabled: tab.panes.length < 2,
        onClick: () => this.paneHooks?.merge(pane.id),
      },
      'separator',
      {
        label: 'Close pane',
        shortcut: 'Ctrl+Shift+W',
        danger: true,
        onClick: () => this.paneHooks?.closePane(pane.id),
      },
    ])
  }

  /**
   * Turns a pane into a drop target: the edge nearest the cursor decides where
   * what you are dragging lands, which is the same gesture editors use.
   *
   * Two things can land here, and they mean almost the same thing. A pane
   * dragged by its header moves within the tab. A *tab* dragged from the strip
   * brings everything it holds and stops existing — which is how you turn two
   * tabs into one split without first making a pane and then finding what you
   * wanted in it.
   */
  private wirePaneDrop(shell: HTMLElement, tab: TerminalTabState, targetId: string): void {
    const hint = document.createElement('div')
    hint.className = 'pane-drop-hint'
    hint.hidden = true
    shell.appendChild(hint)

    const sideFor = (e: DragEvent): DropSide => {
      const rect = shell.getBoundingClientRect()
      const dx = (e.clientX - rect.left) / rect.width
      const dy = (e.clientY - rect.top) / rect.height
      // Whichever edge the cursor is proportionally closest to.
      const distances: [DropSide, number][] = [
        ['left', dx],
        ['right', 1 - dx],
        ['top', dy],
        ['bottom', 1 - dy],
      ]
      distances.sort((a, b) => a[1] - b[1])
      return distances[0][0]
    }

    /**
     * Whether the thing being dragged can land on this pane.
     *
     * `dataTransfer` cannot be read during `dragover` — its payload is
     * deliberately unreadable until the drop — so the answer comes from
     * `dragState`, which is what that module exists for. A tab is refused only
     * by the tab it is already in: dropping it on one of its own panes asks a
     * tab to contain itself.
     */
    const droppableTab = (): string | null => {
      const dragged = draggingTab()
      if (!dragged || dragged.id === tab.id) return null
      return dragged.id
    }

    shell.addEventListener('dragover', (e) => {
      const paneDrag =
        Boolean(this.dragging) &&
        this.dragging !== targetId &&
        Boolean(e.dataTransfer?.types.includes('application/x-iaw-pane'))
      if (!paneDrag && !droppableTab()) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      hint.hidden = false
      hint.className = `pane-drop-hint ${sideFor(e)}`
    })

    shell.addEventListener('dragleave', (e) => {
      if (!shell.contains(e.relatedTarget as Node)) hint.hidden = true
    })

    shell.addEventListener('drop', (e) => {
      hint.hidden = true

      const source = e.dataTransfer?.getData('application/x-iaw-pane')
      if (source) {
        if (source === targetId) return
        e.preventDefault()
        e.stopPropagation()
        this.paneHooks?.movePane(tab.id, source, targetId, sideFor(e))
        this.dragging = null
        return
      }

      // A tab. The strip's own handler reorders within the strip and the
      // sidebar's moves it between workspaces; this is the third destination,
      // and stopping propagation is what keeps the other two out of it.
      const tabId = droppableTab()
      if (!tabId) return
      e.preventDefault()
      e.stopPropagation()
      this.paneHooks?.dropTabIntoPane(tabId, targetId, sideFor(e))
    })
  }

  private clearDropHints(): void {
    for (const hint of this.host.querySelectorAll('.pane-drop-hint')) {
      ;(hint as HTMLElement).hidden = true
    }
  }

  /** Drag handle between two siblings; rewrites their flex-grow live. */
  private buildDivider(
    tab: TerminalTabState,
    node: Extract<PaneNode, { kind: 'split' }>,
    path: number[],
    index: number,
    container: HTMLElement
  ): HTMLElement {
    const divider = document.createElement('div')
    divider.className = `pane-divider ${node.direction}`

    divider.addEventListener('mousedown', (down) => {
      down.preventDefault()
      divider.classList.add('dragging')

      const slots = [...container.children].filter((c) => c.classList.contains('pane-slot')) as HTMLElement[]
      const before = slots[index - 1]
      const after = slots[index]
      if (!before || !after) return

      const horizontal = node.direction === 'row'
      const startPos = horizontal ? down.clientX : down.clientY
      const beforeSize = horizontal ? before.offsetWidth : before.offsetHeight
      const afterSize = horizontal ? after.offsetWidth : after.offsetHeight
      const total = beforeSize + afterSize
      const beforeGrow = Number(before.style.flexGrow) || 1
      const afterGrow = Number(after.style.flexGrow) || 1
      const totalGrow = beforeGrow + afterGrow

      const onMove = (move: MouseEvent) => {
        const delta = (horizontal ? move.clientX : move.clientY) - startPos
        // Keep both panes usable rather than letting one collapse to nothing.
        const nextBefore = Math.max(80, Math.min(total - 80, beforeSize + delta))
        const ratio = nextBefore / total
        before.style.flexGrow = String(totalGrow * ratio)
        after.style.flexGrow = String(totalGrow * (1 - ratio))
        this.fitAll()
      }

      const onUp = () => {
        divider.classList.remove('dragging')
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        const sizes = slots.map((s) => Number(s.style.flexGrow) || 1)
        const sum = sizes.reduce((a, b) => a + b, 0) || 1
        store.setSplitSizes(tab.id, path, sizes.map((s) => s / sum))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })

    return divider
  }

  /** Starts shells for any pane in the tab that doesn't have one yet. */
  private async startPanes(workspaceId: string, tab: TerminalTabState): Promise<void> {
    for (const pane of tab.panes) {
      if (!isTerminalPane(pane)) continue
      const inst = this.instances.get(pane.id)
      if (!inst || inst.spawned || inst.disposed) continue
      inst.spawned = true
      const res = await backend().pty.spawn({
        paneId: pane.id,
        workspaceId,
        cwd: pane.cwd || store.activeWorkspace?.cwd || fallbackCwd(backend().capabilities.platform),
        // One rule, in one place — see `shellFor`.
        ...shellFor(
          pane,
          store.workspaces.find((w) => w.id === workspaceId),
          store.settings
        ),
        cols: inst.term.cols,
        rows: inst.term.rows,
        // Only on the first start after the app opened. Re-mounting a tab you
        // switched away from must not re-run the resume on a live shell.
        ...(store.settings.resumeAgentSessions && !this.startedOnce.has(pane.id)
          ? { resumeSession: pane.agentSession }
          : {}),
      })
      this.startedOnce.add(pane.id)
      if (!res.ok) {
        inst.spawned = false
        inst.term.write(`\r\n\x1b[31mFailed to start shell: ${res.error ?? 'unknown error'}\x1b[0m\r\n`)
      }
    }
  }

  /**
   * Ends a pane's shell and starts a fresh one, for "Reopen as".
   *
   * A shell cannot change what it is once it is running, so the only honest
   * meaning of reopening a tab as something else is this: kill, then spawn. The
   * screen goes with it — scrollback belongs to the session that produced it,
   * and leaving a PowerShell prompt sitting above a bash one reads as one
   * session that changed its mind.
   *
   * The kill is awaited so the host has forgotten the old session before the
   * new one claims the same pane id. `startedOnce` deliberately keeps its entry:
   * an agent conversation is resumed on the first start of a run and never
   * again, and a shell you replaced by hand must not re-enter one behind you.
   */
  async restartPane(workspaceId: string, paneId: string): Promise<void> {
    const inst = this.instances.get(paneId)
    if (!inst || inst.disposed) return
    await backend().pty.kill(paneId)
    inst.spawned = false
    inst.term.reset()
    // The old session's buffered output belongs to the shell being replaced.
    // Replaying it above the new one is exactly the "PowerShell prompt sitting
    // over a bash one" this method exists to avoid.
    clearPending(inst)
    const tab = store.tabOfPane(paneId)
    if (tab) await this.startPanes(workspaceId, tab)
    this.focusActive()
  }

  setActivePane(paneId: string): void {
    for (const [id, element] of this.paneEntries()) {
      element.classList.toggle('active', id === paneId)
    }
    if (this.mayTakeFocus()) this.instances.get(paneId)?.term.focus()
  }

  /**
   * Whether it is our turn to hold focus.
   *
   * Every store change re-renders, and the re-render re-asserts which pane is
   * active — which pulled focus into the terminal even while the user was in a
   * control somewhere else. That was enough to make the opacity slider
   * undraggable: its own `input` handler saves the theme, the save re-rendered,
   * the terminal took focus, and blurring a range input fires `change` — which
   * rebuilt the settings panel and destroyed the slider mid-drag. One step per
   * click was all you got.
   *
   * So the terminal only claims focus when nothing else wants it.
   */
  private mayTakeFocus(): boolean {
    if (isEditing()) return false
    const active = document.activeElement
    if (!active || active === document.body || active === document.documentElement) return true
    // xterm's own hidden textarea lives inside a pane, and that is not
    // "somewhere else" — losing this case would stop panes focusing at all.
    if (active.closest('.pane, .pane-shell')) return true
    return !active.closest('input, select, textarea, button, [contenteditable="true"]')
  }

  /**
   * Rings panes that want attention. Splits make tab badges insufficient —
   * with four panes on screen you need to see *which* one is asking.
   */
  applyAttention(paneIds: ReadonlySet<string>): void {
    for (const [id, element] of this.paneEntries()) {
      element.classList.toggle('attention', paneIds.has(id))
    }
  }

  /**
   * Paints what each pane is doing.
   *
   * Two different kinds of fact share one indicator, and the precedence matters:
   * `blocked` and `working` were declared by the agent, `active` is only our
   * reading of its output rate. A declared state always wins, because it is the
   * one that can distinguish "thinking" from "waiting for you".
   */
  applyPaneStatus(): void {
    for (const inst of this.instances.values()) {
      if (inst.disposed) continue
      const indicator = store.paneIndicator(inst.paneId)
      if (indicator) inst.element.dataset.status = indicator
      else delete inst.element.dataset.status
      this.renderBlockedBar(inst)
    }
    // Panes that draw from store state rather than from a PTY. Each decides for
    // itself whether anything actually changed.
    for (const pane of this.aux.values()) pane.sync?.()
  }

  /**
   * The bar offering a blocked pane's own declared answers.
   *
   * Every button sends bytes the agent published for that choice; the app never
   * composes a payload of its own, and the backend refuses anything else. A
   * pane that is blocked without declaring choices still gets the bar — knowing
   * *which* pane is stuck and why is most of the value, even when the only way
   * to answer is to type into it.
   */
  private renderBlockedBar(inst: Instance): void {
    const agent = store.paneAgent(inst.paneId)
    const blocked = agent?.state === 'blocked'
    const signature = blocked
      ? `${agent.blockedReason ?? ''}|${agent.choices.map((c) => c.id + c.label).join(',')}|${agent.answeredAt ?? ''}`
      : ''
    if (signature === inst.blockedSignature) return
    inst.blockedSignature = signature

    inst.blockedBar.replaceChildren()
    inst.blockedBar.hidden = !blocked
    if (!blocked || !agent) return

    const reason = document.createElement('span')
    reason.className = 'pane-blocked__reason'
    reason.textContent = agent.blockedReason || 'Waiting for you'
    inst.blockedBar.appendChild(reason)

    for (const choice of agent.choices) {
      const button = document.createElement('button')
      button.className = 'pane-blocked__choice' + (choice.isDefault ? ' default' : '')
      button.textContent = choice.label
      button.addEventListener('click', (e) => {
        e.stopPropagation()
        void backend().agent.answer(inst.paneId, choice.id)
      })
      inst.blockedBar.appendChild(button)
    }

    if (agent.answeredAt) {
      const sent = document.createElement('span')
      sent.className = 'pane-blocked__sent'
      // The agent clears its own blocked state; until it does we only claim to
      // have delivered the answer, not that it worked.
      sent.textContent = 'answer sent'
      inst.blockedBar.appendChild(sent)
    }
  }

  /** Every mounted pane element, shell or otherwise. */
  private *paneEntries(): Generator<[string, HTMLElement]> {
    for (const inst of this.instances.values()) yield [inst.paneId, inst.element]
    for (const [id, pane] of this.aux) yield [id, pane.element]
  }

  elementOf(paneId: string): HTMLElement | null {
    return this.instances.get(paneId)?.element ?? this.aux.get(paneId)?.element ?? null
  }

  /** The folder a file pane is currently showing. */
  filesDirectory(paneId: string): string | null {
    return this.filesAt(paneId)?.directory ?? null
  }

  refreshFiles(): void {
    for (const id of this.aux.keys()) void this.filesAt(id)?.refresh()
  }

  focusActive(): void {
    if (!this.mayTakeFocus()) return
    const paneId = store.activeTab?.activePaneId
    if (paneId) this.instances.get(paneId)?.term.focus()
  }

  /** Nearest pane in a direction, by geometry rather than tree position. */
  paneInDirection(from: string, direction: 'left' | 'right' | 'up' | 'down'): string | null {
    const origin = this.elementOf(from)?.getBoundingClientRect()
    if (!origin) return null
    const tab = store.activeTab
    if (!tab) return null

    let best: { id: string; score: number } | null = null
    for (const pane of tab.panes) {
      if (pane.id === from) continue
      const rect = this.elementOf(pane.id)?.getBoundingClientRect()
      if (!rect) continue

      const dx = rect.left + rect.width / 2 - (origin.left + origin.width / 2)
      const dy = rect.top + rect.height / 2 - (origin.top + origin.height / 2)

      const matches =
        (direction === 'left' && dx < -1) ||
        (direction === 'right' && dx > 1) ||
        (direction === 'up' && dy < -1) ||
        (direction === 'down' && dy > 1)
      if (!matches) continue

      // Prefer panes aligned on the perpendicular axis over merely-close ones.
      const along = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy)
      const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx)
      const score = along + across * 2
      if (!best || score < best.score) best = { id: pane.id, score }
    }
    return best?.id ?? null
  }

  // ------------------------------------------------------------------ sizing

  private fit(inst: Instance): void {
    if (!inst.element.isConnected || inst.disposed) return
    if (inst.element.clientHeight === 0 || inst.element.clientWidth === 0) return
    try {
      inst.fit.fit()
    } catch {
      return
    }
    const { cols, rows } = inst.term
    if (cols === inst.lastCols && rows === inst.lastRows) return
    inst.lastCols = cols
    inst.lastRows = rows
    if (inst.spawned) void backend().pty.resize(inst.paneId, cols, rows)
  }

  fitAll(): void {
    for (const inst of this.instances.values()) {
      if (inst.element.parentElement && inst.element.parentElement !== this.pool) this.fit(inst)
    }
  }

  // ---------------------------------------------------------------- teardown

  close(paneId: string): void {
    const auxPane = this.aux.get(paneId)
    if (auxPane) {
      auxPane.dispose()
      this.aux.delete(paneId)
      return
    }

    const inst = this.instances.get(paneId)
    if (!inst) return
    inst.disposed = true
    void backend().pty.kill(paneId)
    try {
      inst.term.dispose()
    } catch {
      /* already gone */
    }
    inst.element.remove()
    this.instances.delete(paneId)
  }

  /**
   * Marks every pane outside the visible tab as deferred, and wakes the rest.
   *
   * Called on every tab change, so it must be cheap and idempotent: a pane
   * already in the right state does nothing at all, and only a pane crossing
   * from hidden to visible pays for its backlog.
   */
  private setDeferred(visibleTabId: string): void {
    for (const inst of this.instances.values()) {
      if (inst.disposed) continue
      const hidden = store.tabOfPane(inst.paneId)?.id !== visibleTabId
      if (hidden === inst.deferred) continue
      if (hidden) inst.deferred = true
      else this.wake(inst)
    }
  }

  /**
   * Puts a pane back on screen, with whatever it printed while nobody looked.
   *
   * The backlog goes in as one write rather than chunk by chunk — xterm parses
   * a single large string appreciably faster than the same bytes in pieces, and
   * there is no reason to yield to a frame we are about to redraw anyway.
   *
   * A truncated buffer says so, because the alternative is splicing the tail of
   * an hour's output onto the head of it and presenting the join as if nothing
   * were missing. The note is dim and one line; the ring in the main process
   * still holds more, and `iaw read-screen` can still reach it.
   */
  private wake(inst: Instance): void {
    inst.deferred = false
    if (!inst.pending.length) return

    const { text: backlog, truncated } = drainPending(inst)

    if (truncated) {
      inst.term.write('\r\n\x1b[38;5;244m── earlier output trimmed ──\x1b[0m\r\n')
    }
    inst.term.write(backlog)
  }

  closeMany(paneIds: string[]): void {
    for (const id of paneIds) this.close(id)
  }

  isBusy(paneId: string): Promise<boolean> {
    return backend().pty.isBusy(paneId)
  }

  /** True if any pane of the tab is mid-command. */
  async tabIsBusy(tab: TerminalTabState): Promise<boolean> {
    const shells = tab.panes.filter(isTerminalPane)
    const results = await Promise.all(shells.map((p) => this.isBusy(p.id)))
    return results.some(Boolean)
  }

  // ------------------------------------------------------------------ search

  private activeInstance(): Instance | null {
    const paneId = store.activeTab?.activePaneId
    return paneId ? (this.instances.get(paneId) ?? null) : null
  }

  findNext(query: string): void {
    this.activeInstance()?.search.findNext(query, { incremental: false })
  }

  findPrevious(query: string): void {
    this.activeInstance()?.search.findPrevious(query)
  }

  clearSearch(): void {
    this.activeInstance()?.search.clearDecorations()
  }

  clearScrollback(): void {
    const inst = this.activeInstance()
    if (!inst) return
    inst.term.clear()
  }

  // ---------------------------------------------------------------- settings

  applySettings(settings: Settings): void {
    const theme = xtermTheme(settings)
    const translucent = isTranslucent(settings)

    for (const inst of this.instances.values()) {
      inst.term.options.fontFamily = settings.fontFamily
      inst.term.options.fontSize = settings.fontSize
      inst.term.options.lineHeight = settings.lineHeight
      inst.term.options.cursorBlink = settings.cursorBlink
      inst.term.options.cursorStyle = settings.cursorStyle
      inst.term.options.scrollback = settings.scrollback
      inst.term.options.allowTransparency = translucent
      inst.term.options.theme = theme

      // Swap renderers when translucency changes: WebGL can't draw a
      // see-through background, the DOM renderer can.
      if (translucent && inst.webgl) {
        try {
          inst.webgl.dispose()
        } catch {
          /* already gone */
        }
        inst.webgl = null
      } else if (!translucent && !inst.webgl) {
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => webgl.dispose())
          inst.term.loadAddon(webgl)
          inst.webgl = webgl
        } catch {
          inst.webgl = null
        }
      }
    }
    this.applyBackdrop(settings)
    this.fitAll()
  }

  /** Paints the gutter around the grid, carrying the theme's alpha. */
  applyBackdrop(settings: Settings): void {
    this.host.style.background = terminalBackdrop(settings)
  }

  adjustFontSize(delta: number): void {
    const next = Math.max(8, Math.min(32, store.settings.fontSize + delta))
    store.updateSettings({ fontSize: next })
    this.applySettings(store.settings)
  }

  get mountedTab(): string | null {
    return this.mountedTabId
  }
}

/** The workspace a pane belongs to, for the panes that need to know. */
function workspaceIdOf(paneId: string): string {
  return store.workspaceOfPane(paneId)?.id ?? ''
}

/**
 * Ctrl+scroll zooms the pane under the pointer.
 *
 * Capture phase, and this is the whole reason the terminal's own version of
 * this exists too: a scrollable pane stops a wheel event it can act on, so a
 * listener waiting on the way back up never runs. Capturing means the gesture
 * is claimed before anything inside gets to swallow it.
 *
 * `passive: false` so `preventDefault` sticks — without it the page itself
 * zooms underneath, which is the browser's default for Ctrl+wheel and is the
 * one thing that must not happen inside an app that is already a web page.
 */
export function attachZoomWheel(element: HTMLElement, zoom: PaneZoom): void {
  element.addEventListener(
    'wheel',
    (e) => {
      if (!isPrimary(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (e.deltaY === 0) return
      zoom.step(e.deltaY < 0 ? 'in' : 'out')
    },
    { passive: false, capture: true }
  )
}

/**
 * What a tab's tree was built from.
 *
 * The layout tree carries every pane id and how they are arranged, so it
 * catches a split, a merge, a resize of the divider and a pane arriving from
 * elsewhere. Kinds are appended because a pane can change what it holds without
 * moving — "Reopen as" on a terminal, or an editor tab becoming a diff — and
 * the built element would otherwise be reused for the wrong thing.
 */
function layoutSignature(tab: TerminalTabState): string {
  const kinds = tab.panes.map((p) => `${p.id}:${p.kind ?? 'terminal'}`).join(',')
  return `${JSON.stringify(tab.layout)}|${kinds}`
}
