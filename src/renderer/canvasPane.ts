/**
 * A canvas of connected notes, stored in the project it belongs to.
 *
 * The thinking tool the other panes are not. A runbook says what you run and a
 * day says where the time went; neither helps with the part that happens before
 * either — laying out what a thing is made of, what depends on what, and which
 * bit you have not worked out yet. That wants space and boxes and arrows, and
 * it wants them beside the code rather than in a browser tab.
 *
 * **Stored as Obsidian's `.canvas` format**, which is JSON and is the closest
 * thing this has to a standard. That is the whole reason to use somebody else's
 * schema rather than inventing one: the file opens in Obsidian, so a canvas
 * started here is not trapped here, and one started there is not a file this
 * pane has to refuse. It sits in the project folder, so it versions with the
 * code and travels with the repository like `NOTES.md` does.
 *
 * **What it is not.** Not a diagram editor — there are no shapes, no styling,
 * no arrow decorations, and there is not going to be a palette of them.
 * Flowcharts are text in a markdown fence (`shared/flowchart.ts`) and drawings
 * are a browser tab away. This is boxes of words you can move around, which is
 * the part that helps.
 */
import type { AuxPane } from './auxPane'
import { store } from './state'
import { backend } from '../backend'
import { joinPath } from '../shared/platform'
import { folderOf, renderMarkdown } from './markdown'
import {
  anchor,
  boundsOf,
  CANVAS_EXT,
  colorOf,
  curve,
  facing,
  isCanvasPath,
  readCanvas,
  type CanvasEdge,
  type CanvasFile,
  type CanvasNode,
} from '../shared/canvas'
import { showToast } from './ui/toast'
import { showContextMenu, type MenuEntry } from './ui/contextMenu'
import { hasFilePath, pathsFromDrop } from './ui/fileDrag'
import { encodeImagePath, isImagePath } from '../shared/images'
import { grammarFor } from '../shared/editorModes'
import { promptDialog } from './ui/confirm'
import { FindBar } from './ui/findBar'
import { findAll, type FindOptions } from './ui/textOps'
import type { UiActions } from './ui/actions'

/**
 * What a canvas pane opens when nobody said which canvas.
 *
 * The project's own, in its own folder, under a name Obsidian opens without
 * being told anything — the same bargain `NOTES.md` makes for the editor. A
 * pane saved before canvases had names has no file recorded and still resolves
 * to this one, so those tabs come back as they were.
 */
const DEFAULT_FILE = 'notes.canvas'

/**
 * The app's commands, handed in once.
 *
 * A canvas opens other canvases — in their own tabs, which only the app can
 * make — and the same pattern the palette and the notification panel use is
 * cheaper here than threading a hooks object through `ensureAux` for one call.
 */
let actions: UiActions

export function initCanvasPanes(a: UiActions): void {
  actions = a
}

/** The SVG namespace, for the wires and the one icon in the bar. */
const SVG = 'http://www.w3.org/2000/svg'

/** What the native dialogs offer when a canvas is being saved or opened. */
const CANVAS_FILTERS = [
  { name: 'Canvas', extensions: ['canvas'] },
  { name: 'All files', extensions: ['*'] },
]

const NODE_W = 220
const NODE_H = 110
/** A group is a container, so it starts big enough to put something in. */
const GROUP_W = 520
const GROUP_H = 360
/** A file or a link is one line, not a paragraph. */
const LINK_H = 52

/** Matches the dots the viewport draws, so snapping lands on what you can see. */
const GRID = 22

/**
 * The smallest a note may be dragged to.
 *
 * Small enough to make a label or a marker, large enough that a card cannot be
 * shrunk to a dot you then cannot find the corner of again.
 */
const MIN_W = 80
const MIN_H = 44

/**
 * The spec's six presets, in its own order, with the names it gives them.
 *
 * Stored as the numbers, never as hex: JSON Canvas leaves the actual values to
 * whoever draws the file, which is what lets one canvas look right in this
 * app's theme and in Obsidian's at the same time.
 */
const COLOURS: [string, string][] = [
  ['1', 'Red'],
  ['2', 'Orange'],
  ['3', 'Yellow'],
  ['4', 'Green'],
  ['5', 'Cyan'],
  ['6', 'Purple'],
]
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5

export class CanvasPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly scene: HTMLDivElement
  private readonly wires: SVGSVGElement
  /** Needed to turn a pointer's screen position into a position on the canvas. */
  private viewport!: HTMLDivElement
  /** The line that follows the cursor while a connection is being drawn. */
  private ghost: SVGPathElement | null = null
  private disposed = false

  private nodes: CanvasNode[] = []
  private edges: CanvasEdge[] = []
  private loaded = false

  /** Where the canvas sits in the viewport, and how big it is drawn. */
  private panX = 0
  private panY = 0
  private scale = 1

  /**
   * The text of every markdown file a node points at, and its stamp.
   *
   * A file node in JSON Canvas is the note itself, not a shortcut to it — so
   * the card shows the file's contents and editing the card edits the file.
   * That means reading them, and reading them once rather than on every render:
   * a canvas redraws whenever anything moves, and a disk read per node per
   * frame would make dragging a note feel like dragging the filesystem.
   *
   * The stamp is what makes writing back safe. A file changed underneath us —
   * in the editor pane, or by an agent — must not be overwritten by a card
   * holding what it said five minutes ago.
   */
  private files = new Map<string, { text: string; mtime: number; size: number }>()

  /**
   * Whether a dragged note lands on the grid the background already draws.
   *
   * On, because the grid is drawn either way and a note that ignores it looks
   * like a mistake. Off is for the canvas that is a sketch rather than a
   * diagram, where lining things up is not the point.
   */
  private snap = true

  /** The name in the bar, repainted when the pane changes canvas. */
  private nameEl: HTMLButtonElement | null = null

  /** Ctrl+F, the same bar the editor and the terminals use. */
  private readonly find: FindBar
  /** Node ids holding a match, in the order the search walks them. */
  private matches: string[] = []
  /** Which of those the last Enter went to. */
  private matchAt = -1

  private selected: string | null = null
  /** The node a connection is being dragged from, while one is. */
  private linking: string | null = null
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * The canvas this pane is showing, absolute, or '' for "the project's own".
   *
   * Held rather than read from the store on every use because it is the one
   * thing about a canvas pane that must not change under it: a pane that saved
   * to whichever file the store happened to hold at that instant is a pane that
   * can write a canvas over an unrelated one.
   */
  private path: string

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string,
    file?: string
  ) {
    this.path = file ?? ''
    this.element = document.createElement('div')
    this.element.className = 'canvas-pane'
    this.element.tabIndex = 0

    this.element.appendChild(this.toolbar())

    this.find = new FindBar({
      find: (query, opts, backwards) => this.runFind(query, opts, backwards),
      replace: (query, replacement, opts) => this.runReplace(query, replacement, opts, false),
      replaceAll: (query, replacement, opts) => this.runReplace(query, replacement, opts, true),
      close: () => {
        this.find.hide()
        this.matches = []
        this.matchAt = -1
        this.render()
        this.element.focus()
      },
    })
    this.element.appendChild(this.find.element)

    const viewport = document.createElement('div')
    viewport.className = 'canvas-viewport'
    this.viewport = viewport

    this.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    this.wires.setAttribute('class', 'canvas-wires')

    this.scene = document.createElement('div')
    this.scene.className = 'canvas-scene'
    this.scene.appendChild(this.wires)

    viewport.appendChild(this.scene)
    this.element.appendChild(viewport)

    this.wireViewport(viewport)
    this.wireKeys()
    void this.load()
  }

  sync(): void {
    /* Nothing here comes from the store; the file is the state. */
  }

  /**
   * The app's own zoom gesture, pointed at the canvas rather than at its text.
   *
   * Every other pane scales its font; scaling this one's font would leave the
   * notes where they were and the words spilling out of them. `reset` fits
   * everything instead of going to 100%, because on a canvas "show me it all"
   * is what somebody pressing Ctrl+0 actually wants.
   */
  readonly zoom = {
    step: (direction: 'in' | 'out'): void => {
      this.scale = clamp(this.scale * (direction === 'in' ? 1.2 : 1 / 1.2), MIN_ZOOM, MAX_ZOOM)
      this.applyTransform()
    },
    reset: (): void => this.fit(),
    factor: (): number => this.scale,
  }

  dispose(): void {
    this.disposed = true
    // A canvas closed with a move still inside the debounce must not lose it.
    // The delay is for the disk's sake, not a reason to drop the last edit —
    // and `save` clears the timer itself, so this cannot write twice.
    if (this.saveTimer) void this.save()
  }

  // ------------------------------------------------------------------- chrome

  /**
   * One control, and the sentence that says what the surface does.
   *
   * Four "Add …" buttons used to sit here and were the least-used pixels in the
   * pane: adding a note is a double-click where you want it, and everything
   * else — a group, an existing file, a link — is on the canvas's own
   * right-click, which is where you already are when you have decided where the
   * thing goes. A button that puts a note in the middle of the view and leaves
   * you dragging it somewhere is a worse version of both.
   *
   * What is left is the one thing no gesture covers: bringing the whole canvas
   * back into view when you have panned off the edge of it.
   */
  private toolbar(): HTMLElement {
    const bar = document.createElement('div')
    bar.className = 'canvas-bar'

    // The canvas's own name, and the way to reach the others. A workspace can
    // hold as many canvases as it has files, so which one you are looking at is
    // the first thing the bar has to say — and the place you would click to
    // change it is the name itself, which is where every application that opens
    // documents has always put it.
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'btn canvas-name'
    name.textContent = this.title()
    name.title = 'New, open or save this canvas under another name'
    name.addEventListener('click', () => {
      const rect = name.getBoundingClientRect()
      this.fileMenu(rect.left, rect.bottom + 4)
    })
    this.nameEl = name
    bar.appendChild(name)

    const hint = document.createElement('span')
    hint.className = 'canvas-hint'
    hint.textContent =
      'drag to pan · wheel to zoom · double-click to add or edit · drag a note’s edge to connect, ' +
      'or to empty space for a new one · drag a note’s corner to resize, double-click it to fit the ' +
      'text · right-click for colour, groups and links · drop a file to link it'
    bar.appendChild(hint)

    const fit = document.createElement('button')
    fit.type = 'button'
    fit.className = 'icon-btn canvas-fit'
    fit.title = 'Bring everything into view'
    fit.setAttribute('aria-label', 'Bring everything into view')
    fit.appendChild(fitIcon())
    fit.addEventListener('click', () => this.fit())
    bar.appendChild(fit)

    return bar
  }

  /** The canvas being edited, absolute. Falls back to the project's own. */
  private file(): string {
    if (this.path) return this.path
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    if (!workspace) return ''
    return joinPath(backend().capabilities.platform, workspace.cwd, DEFAULT_FILE)
  }

  /** The name shown on the tab and in the bar. */
  private title(): string {
    const file = this.file()
    return file.split(/[\\/]/).pop() ?? DEFAULT_FILE
  }

  // -------------------------------------------------------------------- load

  private async load(): Promise<void> {
    // The document menu lists the project's other canvases, and it has to be
    // ready before the first click on it rather than after.
    void this.loadSiblings()
    const file = this.file()
    if (!file) return
    try {
      // Everything in the file survives, including what this app has no use
      // for — see `readCanvas`, and the spec it follows.
      const parsed = readCanvas(await backend().readText(file))
      this.nodes = parsed.nodes
      this.edges = parsed.edges
    } catch {
      // No canvas yet — the ordinary case for a project nobody has made one
      // for, and the empty state says so.
      this.nodes = []
      this.edges = []
    }
    this.loaded = true
    if (this.disposed) return
    this.render()
    this.fit()
    // After the first paint: the canvas should be on screen while its notes are
    // being read, not after.
    void this.loadFiles()
  }

  /**
   * Whether this node's file is a note — one the card *is*, rather than points at.
   *
   * Markdown only. The card can also show a picture or the first page of a code
   * file (see `showsContent`), but those are previews: a note is the one kind
   * you edit here, because a note is the one kind that is prose.
   */
  private isNote(node: CanvasNode): boolean {
    return node.type === 'file' && /\.(md|markdown|mdown|mkd)$/i.test(node.file ?? '')
  }

  /**
   * Whether a file node shows what is in the file, or only its name.
   *
   * The line is whether a format is *scannable at a glance*, because a card is
   * small and a canvas is spatial. Prose, a picture, and the top of a source
   * file all say what they are from across the screen. A hex dump and a
   * thousand-row grid say nothing at that size and need a viewport and
   * scrolling to be worth anything — so for those the card is a door to the
   * pane that does it properly, which is what a double-click already opens.
   */
  private showsContent(node: CanvasNode): boolean {
    return (
      this.isNote(node) ||
      isImagePath(node.file ?? '') ||
      isCode(node.file ?? '') ||
      isCanvasPath(node.file ?? '')
    )
  }

  /**
   * The menu on empty canvas: everything that can be put on it.
   *
   * A menu where the canvas is, rather than only buttons at the top, because
   * the thing you are adding goes *here* — and a toolbar button drops it in the
   * middle of the view and leaves you dragging it to where you meant. Obsidian
   * puts the same list on the same click, which is the other reason: a canvas
   * is a place people arrive at already knowing the gesture.
   */
  private canvasMenu(e: MouseEvent): void {
    const at = this.atPointer(e)
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Add note', onClick: () => this.addNode(at) },
      { label: 'Add note from a file…', onClick: () => void this.addExisting(at) },
      {
        label: 'Add another canvas…',
        onClick: () => this.chooseCanvasNode(at, e.clientX, e.clientY),
      },
      { label: 'Add link…', onClick: () => void this.addLink(at) },
      { label: 'Create group', onClick: () => this.addGroup(at) },
      'separator',
      {
        label: 'Snap to grid',
        checked: this.snap,
        onClick: () => {
          this.snap = !this.snap
        },
      },
      'separator',
      { label: 'Find on this canvas', shortcut: 'Ctrl+F', onClick: () => this.find.show(this.selectedText()) },
      ...this.fileEntries(),
    ])
  }

  /**
   * New, open, save-as — the three things a document does.
   *
   * On the name in the bar and on the canvas's own right-click, because both
   * are true: it is a property of this document, and it is also the thing you
   * reach for while looking at the canvas rather than at the bar.
   */
  private fileMenu(x: number, y: number): void {
    showContextMenu(x, y, this.fileEntries())
  }

  /**
   * The document menu: this project's canvases, and the ways to make one.
   *
   * The project's own canvases are listed here rather than reached through the
   * system's file dialog, because that dialog answers a question nobody asked.
   * A canvas lives beside the code it is about, so "open another one" almost
   * always means one of the handful this project has — and the dialog makes you
   * navigate to the folder you are already standing in, in a window that cannot
   * be driven from the keyboard the way the rest of this app can.
   *
   * `Browse…` stays for the case the list cannot cover: a canvas in another
   * project, or saving this one somewhere else entirely.
   */
  private fileEntries(): MenuEntry[] {
    const here = this.file().toLowerCase()
    const others: MenuEntry[] = this.siblings.map((path) => ({
      label: path.split(/[\\/]/).pop() ?? path,
      // The one you are on is ticked rather than left out: a list that drops
      // its current entry is a list whose length changes as you move about it.
      checked: path.toLowerCase() === here,
      onClick: () => actions.openCanvas(this.workspaceId, path),
    }))

    return [
      'separator',
      { label: 'New canvas…', onClick: () => void this.newCanvas() },
      { label: 'Save as…', onClick: () => void this.saveAs() },
      { label: 'Browse…', onClick: () => void this.browse() },
      ...(others.length ? (['separator'] as MenuEntry[]) : []),
      ...others,
    ]
  }

  /**
   * Every canvas in the project, refreshed in the background.
   *
   * Held rather than looked up when the menu opens: a menu that appears a
   * quarter of a second after the click is a menu that feels broken, and the
   * answer changes about as often as somebody makes a canvas. Refreshed on load
   * and after anything that adds one.
   */
  private siblings: string[] = []

  private async loadSiblings(): Promise<void> {
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    if (!workspace) return
    try {
      this.siblings = await backend().listByExtension(workspace.cwd, [CANVAS_EXT])
    } catch {
      // A folder that cannot be walked simply has no list; `Browse…` still works.
      this.siblings = []
    }
  }

  /**
   * Asks for a name, and puts the canvas beside this one.
   *
   * A name, not a place: the canvas you are making belongs with the canvas you
   * are looking at, and the folder is already decided by that. Somewhere else
   * is what `Browse…` is for, and it is the rarer half.
   */
  private async askName(title: string, initial: string): Promise<string | null> {
    const name = await promptDialog({
      title,
      body: `Saved in ${folderOf(this.file()) || 'the project folder'}. A name, or a path inside it.`,
      placeholder: 'plans.canvas',
      initial,
    })
    if (name === null) return null
    const trimmed = name.trim()
    if (!trimmed) return null
    const withExt = isCanvasPath(trimmed) ? trimmed : `${trimmed}${CANVAS_EXT}`
    const folder = folderOf(this.file())
    return folder ? joinPath(backend().capabilities.platform, folder, withExt) : withExt
  }

  /**
   * A canvas that does not exist yet, opened in its own tab.
   *
   * Written empty before the pane opens on it: a tab pointing at a file that is
   * not there yet is a pane that will not save until you have drawn something.
   */
  private async newCanvas(): Promise<void> {
    const file = await this.askName('New canvas', '')
    if (!file) return
    await this.create(file)
  }

  /** Writes an empty canvas and opens it, or says why it could not. */
  private async create(file: string): Promise<void> {
    try {
      await backend().files.writeText(file, JSON.stringify({ nodes: [], edges: [] }, null, 2))
    } catch {
      showToast('Could not make that canvas', `${file} could not be written.`, { kind: 'warn' })
      return
    }
    void this.loadSiblings()
    actions.openCanvas(this.workspaceId, file)
  }

  /**
   * This canvas, under another name, and this pane follows it.
   *
   * Follows rather than opens a second pane: "save as" means the thing you are
   * working on is now that file, and leaving the pane on the old one would put
   * your next edit somewhere you had just decided to stop writing.
   */
  private async saveAs(): Promise<void> {
    const file = await this.askName('Save canvas as', this.title())
    if (!file) return
    await this.moveTo(file)
  }

  private async moveTo(file: string): Promise<void> {
    this.path = file
    store.setPaneFile(this.paneId, file)
    if (this.nameEl) this.nameEl.textContent = this.title()
    await this.save()
    void this.loadSiblings()
  }

  /**
   * The system's own dialogs, for the cases a list of this project cannot
   * cover: a canvas in another project, or saving this one outside it.
   *
   * One entry for both, because which of the two you meant is answered by
   * whether you pick a file that exists — and asking that as two menu items
   * would be the app making the user classify its own implementation.
   */
  private async browse(): Promise<void> {
    const picked = await backend().pickOpenFile({
      title: 'Open a canvas from anywhere',
      filters: CANVAS_FILTERS,
    })
    if (!picked) return
    if (!isCanvasPath(picked)) {
      showToast('Not a canvas', 'A canvas is a `.canvas` file.', { kind: 'warn' })
      return
    }
    actions.openCanvas(this.workspaceId, picked)
  }

  /** The absolute path of a file node, whose stored path is project-relative. */
  private fullPath(node: CanvasNode): string {
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    if (!workspace || !node.file) return ''
    return joinPath(backend().capabilities.platform, workspace.cwd, node.file)
  }

  /**
   * Reads every markdown file the canvas points at, once.
   *
   * Missing files are recorded as missing rather than skipped, so a card whose
   * note has been moved or deleted says so instead of sitting blank — a blank
   * card reads as an empty note, which is a different and much more alarming
   * thing.
   */
  private async loadFiles(): Promise<void> {
    for (const node of this.nodes) {
      // A picture is drawn from its path; there is nothing to read. A canvas is
      // read for the same reason a note is — the card draws what is in it.
      if (!this.isNote(node) && !isCode(node.file ?? '') && !isCanvasPath(node.file ?? '')) continue
      const full = this.fullPath(node)
      if (!full || this.files.has(full)) continue
      try {
        const [text, stamp] = await Promise.all([
          backend().readText(full),
          backend().fileStamp(full),
        ])
        this.files.set(full, { text, mtime: stamp?.mtime ?? 0, size: stamp?.size ?? 0 })
      } catch {
        this.files.set(full, { text: '', mtime: -1, size: -1 })
      }
    }
    if (!this.disposed) this.render()
  }

  /**
   * Writes a card's text back to the file it came from.
   *
   * Checked against the stamp first. A note edited in the editor pane while its
   * card sat open on a canvas must not be silently reverted to what the card
   * remembered — so a file that moved on is left alone and re-read, and the
   * typing is handed back rather than thrown away.
   */
  private async saveFile(node: CanvasNode, text: string): Promise<void> {
    const full = this.fullPath(node)
    const held = this.files.get(full)
    if (!full || !held) return
    if (held.text === text) return

    try {
      const now = await backend().fileStamp(full)
      if (now && held.mtime > 0 && (now.mtime !== held.mtime || now.size !== held.size)) {
        showToast(
          'That note changed elsewhere',
          `${node.file} was edited outside this canvas, so it was not overwritten. Your text is ` +
            'still on the card; copy it out before switching away.',
          { kind: 'warn', timeout: 15000 }
        )
        return
      }

      await backend().files.writeText(full, text)
      const after = await backend().fileStamp(full)
      this.files.set(full, { text, mtime: after?.mtime ?? 0, size: after?.size ?? 0 })
    } catch {
      showToast('Could not save that note', `${node.file} could not be written.`, { kind: 'warn' })
    }
  }

  private queueSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.save(), 700)
  }

  private async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const file = this.file()
    if (!file || !this.loaded) return
    try {
      // Two spaces and one node per line, so a canvas in a repository produces a
      // diff somebody can read rather than one enormous line.
      await backend().files.writeText(file, JSON.stringify({ nodes: this.nodes, edges: this.edges }, null, 2))
    } catch {
      showToast('Could not save the canvas', `${this.title()} could not be written.`, { kind: 'warn' })
    }
  }

  // ---------------------------------------------------------------- viewport

  private wireViewport(viewport: HTMLElement): void {
    // Panning with a drag on the background. Not on a node — that moves the
    // node — and not with a modifier, because the background is the one part
    // of a canvas that has nothing else to do.
    let panning = false
    let fromX = 0
    let fromY = 0

    viewport.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.canvas-node')) return
      panning = true
      fromX = e.clientX - this.panX
      fromY = e.clientY - this.panY
      this.select(null)
      viewport.setPointerCapture(e.pointerId)
    })
    viewport.addEventListener('pointermove', (e) => {
      if (!panning) return
      this.panX = e.clientX - fromX
      this.panY = e.clientY - fromY
      this.applyTransform()
    })
    const stop = (e: PointerEvent) => {
      if (!panning) return
      panning = false
      try {
        viewport.releasePointerCapture(e.pointerId)
      } catch {
        /* already released */
      }
    }
    viewport.addEventListener('pointerup', stop)
    viewport.addEventListener('pointercancel', stop)

    // A file dragged from the tree — or from Explorer — becomes a node pointing
    // at it. A button and a picker would be a second way to do what the file
    // tree already does better.
    viewport.addEventListener('dragover', (e) => {
      if (!hasFilePath(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    })
    viewport.addEventListener('drop', (e) => {
      const paths = pathsFromDrop(e)
      if (!paths.length) return
      e.preventDefault()
      const at = this.atPointer(e)
      // Several files stack down the canvas rather than landing on top of each
      // other, which is what dropping a selection should obviously do.
      paths.forEach((path, index) => this.addFile(path, { x: at.x, y: at.y + index * (LINK_H + 12) }))
      void this.loadFiles()
    })

    viewport.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement).closest('.canvas-node')) return
      e.preventDefault()
      this.canvasMenu(e)
    })

    viewport.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.canvas-node')) return
      const rect = viewport.getBoundingClientRect()
      this.addNode({
        x: (e.clientX - rect.left - this.panX) / this.scale - NODE_W / 2,
        y: (e.clientY - rect.top - this.panY) / this.scale - NODE_H / 2,
      })
    })

    // Zoom about the pointer, so the thing under the cursor stays under it —
    // zooming about the centre makes a canvas feel like it is fighting you.
    viewport.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const rect = viewport.getBoundingClientRect()
        const px = e.clientX - rect.left
        const py = e.clientY - rect.top
        const next = clamp(this.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), MIN_ZOOM, MAX_ZOOM)
        const ratio = next / this.scale
        this.panX = px - (px - this.panX) * ratio
        this.panY = py - (py - this.panY) * ratio
        this.scale = next
        this.applyTransform()
      },
      { passive: false }
    )
  }

  private wireKeys(): void {
    // Claims Ctrl+F for this pane, the way the editor does: without it the
    // app's global handler opens the *terminal's* find bar over a canvas.
    this.element.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        this.find.show(this.selectedText())
        return
      }
      if (e.key === 'Escape' && this.find.open) {
        e.preventDefault()
        this.find.hide()
        this.matches = []
        this.matchAt = -1
        this.render()
      }
    })

    this.element.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      // Not while typing into a note, or the first Backspace would delete the
      // note somebody is editing rather than a character in it.
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
      if (!this.selected) return
      e.preventDefault()
      this.removeNode(this.selected)
    })
  }

  // ------------------------------------------------------------------- find

  /**
   * What a note holds, for searching.
   *
   * Each kind says what it is made of: a note is its text, a group and a link
   * are their label, a file node is the path it points at. Not the *contents*
   * of a file node — those live in a file, the pane is showing a preview of
   * them, and searching them here would find things this canvas cannot take you
   * to. Searching the path finds the card, which is what the canvas is for.
   */
  private searchable(node: CanvasNode): string {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'group') return node.label ?? ''
    if (node.type === 'link') return `${node.label ?? ''} ${node.url ?? ''}`.trim()
    return `${node.label ?? ''} ${node.file ?? ''}`.trim()
  }

  /** The selected note's text, to seed the bar the way a selection does. */
  private selectedText(): string {
    const node = this.nodes.find((n) => n.id === this.selected)
    return node ? this.searchable(node).split('\n')[0].slice(0, 80) : ''
  }

  /**
   * Runs a search and goes to the next match.
   *
   * Every note holding the query is lit, not only the one you are on — a canvas
   * is a picture, and "where is this mentioned" is answered better by four
   * highlighted cards than by being walked round them one at a time. Enter
   * still walks them, and brings each into view.
   */
  private runFind(query: string, opts: FindOptions, backwards: boolean): void {
    const before = this.matches[this.matchAt]
    this.matches = this.nodes
      .filter((node) => findAll(this.searchable(node), query, opts).length > 0)
      .map((node) => node.id)

    if (!this.matches.length) {
      this.matchAt = -1
      this.find.report(0, 0)
      this.render()
      return
    }

    // A changed query restarts from the top rather than from wherever the last
    // one happened to leave the cursor, which is what the editor does too.
    const held = before ? this.matches.indexOf(before) : -1
    if (held === -1) this.matchAt = backwards ? this.matches.length - 1 : 0
    else this.matchAt = (held + (backwards ? -1 : 1) + this.matches.length) % this.matches.length

    this.find.report(this.matchAt, this.matches.length)
    const id = this.matches[this.matchAt]
    this.selected = id
    this.render()
    this.bringIntoView(id)
  }

  /**
   * Replaces in notes, and only in notes.
   *
   * A group's label and a link's address are single values with their own
   * dialogs, and a file node's text is a file on disk — replacing inside those
   * from a find bar would be editing three different kinds of thing through one
   * box. What a canvas is mostly made of is notes, and those are text.
   */
  private runReplace(query: string, replacement: string, opts: FindOptions, all: boolean): void {
    if (!query) return
    const targets = all
      ? this.nodes.filter((n) => n.type === 'text')
      : this.nodes.filter((n) => n.type === 'text' && n.id === this.matches[this.matchAt])

    let changed = 0
    for (const node of targets) {
      const text = node.text ?? ''
      const spans = findAll(text, query, opts)
      if (!spans.length) continue
      // Back to front, so an earlier replacement cannot move a later span.
      const use = all ? [...spans].reverse() : [spans[0]]
      let next = text
      for (const span of use) next = next.slice(0, span.from) + replacement + next.slice(span.to)
      node.text = next
      changed += use.length
    }
    if (!changed) return
    this.render()
    this.queueSave()
    this.runFind(query, opts, false)
  }

  /** Pans until a note is on screen, keeping the zoom the user chose. */
  private bringIntoView(nodeId: string): void {
    const node = this.nodes.find((n) => n.id === nodeId)
    if (!node) return
    const rect = this.viewport.getBoundingClientRect()
    const left = node.x * this.scale + this.panX
    const top = node.y * this.scale + this.panY
    const right = left + node.width * this.scale
    const bottom = top + node.height * this.scale
    const pad = 40
    if (left < pad) this.panX += pad - left
    else if (right > rect.width - pad) this.panX -= right - (rect.width - pad)
    if (top < pad) this.panY += pad - top
    else if (bottom > rect.height - pad) this.panY -= bottom - (rect.height - pad)
    this.applyTransform()
  }

  private applyTransform(): void {
    this.scene.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`
  }

  /**
   * The colour menu, on a note's right-click.
   *
   * The spec's six presets plus "none", and deliberately not a colour picker:
   * JSON Canvas stores presets as the numbers `"1"` to `"6"` and leaves their
   * actual values to whoever is drawing, which is what lets the same file look
   * right in this app's theme and in Obsidian's. Picking a hex here would throw
   * that away for every other reader of the file.
   */
  private colourMenu(x: number, y: number, node: CanvasNode): void {
    const set = (colour: string | undefined): void => {
      if (colour) node.color = colour
      else delete node.color
      this.render()
      this.queueSave()
    }

    showContextMenu(x, y, [
      { label: 'No colour', checked: !node.color, onClick: () => set(undefined) },
      'separator',
      ...COLOURS.map(([value, name]) => ({
        label: name,
        checked: node.color === value,
        onClick: () => set(value),
      })),
      'separator',
      { label: 'Delete', danger: true, onClick: () => this.removeNode(node.id) },
    ])
  }

  /**
   * Ends a connection drag on empty canvas by making the note it points at.
   *
   * The gesture is worth having because it matches the order thinking happens
   * in: you know something follows from this before you know what it is. The
   * new note opens for editing straight away, so the drag and the sentence are
   * one movement.
   */
  private finishLinkToNew(at: { x: number; y: number }, screen: { x: number; y: number }): void {
    const from = this.linking
    this.linking = null
    this.element.classList.remove('canvas-pane--linking')
    if (!from) return

    // Asked rather than assumed. Dragging a line out means "something follows
    // from this" — it does not say whether the something is a thought you are
    // about to type or a note that already exists, and guessing the first one
    // makes the second take a deletion to reach.
    //
    // Dismissing the menu makes nothing: the drag is then simply cancelled,
    // which is what changing your mind should cost.
    const connect = (node: CanvasNode, thenEdit: boolean): void => {
      this.edges.push({ id: id(), fromNode: from, toNode: node.id })
      this.render()
      this.queueSave()
      if (thenEdit) this.edit(node.id)
    }

    // Centred on where the line was pointing, so the note lands under the
    // arrow rather than hanging below and to the right of it.
    const topLeft = (w: number, h: number): { x: number; y: number } => ({
      x: at.x - w / 2,
      y: at.y - h / 2,
    })

    showContextMenu(screen.x, screen.y, [
      {
        label: 'Add note',
        onClick: () => connect(this.place({ type: 'text', text: '' }, topLeft(NODE_W, NODE_H), NODE_W, NODE_H), true),
      },
      {
        label: 'Add note from a file…',
        onClick: () => {
          void (async () => {
            const before = this.nodes.length
            await this.addExisting(topLeft(NODE_W, NODE_H))
            // `addExisting` is the one that knows how to size a file card, so
            // the node it made is the one to connect — if the picker was not
            // cancelled.
            const made = this.nodes[this.nodes.length - 1]
            if (this.nodes.length > before && made) connect(made, false)
          })()
        },
      },
      {
        label: 'Add link…',
        onClick: () => {
          void (async () => {
            const before = this.nodes.length
            await this.addLink(topLeft(NODE_W, LINK_H))
            const made = this.nodes[this.nodes.length - 1]
            if (this.nodes.length > before && made) connect(made, false)
          })()
        },
      },
    ])
  }

  /**
   * Ends a connection drag on whatever note it was released over.
   *
   * Null — released over empty canvas, or over the note it started from — is a
   * cancel rather than a mistake: dragging a line and thinking better of it is
   * an ordinary thing to do, and it should cost nothing.
   */
  private finishLink(toId: string | null): void {
    const from = this.linking
    this.linking = null
    this.element.classList.remove('canvas-pane--linking')
    if (!from || !toId || toId === from) return

    // Not twice, and not both ways round: a pair of notes is connected or it is
    // not, and a second line on top of the first is invisible anyway.
    const already = this.edges.some(
      (edge) =>
        (edge.fromNode === from && edge.toNode === toId) ||
        (edge.fromNode === toId && edge.toNode === from)
    )
    if (already) return

    // No sides pinned. The router picks them from where the two notes actually
    // sit, and re-picks them every time one moves — a line that always left the
    // right edge would loop around a note directly above.
    this.edges.push({ id: id(), fromNode: from, toNode: toId })
    this.drawWires()
    this.queueSave()
  }

  /** A pointer's position in canvas coordinates rather than screen ones. */
  private atPointer(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.viewport.getBoundingClientRect()
    return {
      x: (e.clientX - rect.left - this.panX) / this.scale,
      y: (e.clientY - rect.top - this.panY) / this.scale,
    }
  }

  /**
   * The line that follows the cursor while a connection is being drawn.
   *
   * Without it the gesture is invisible: you press on a note's edge, move, and
   * nothing happens until you release over another note — so there is no way to
   * tell whether the drag started, where it is going, or that the feature
   * exists at all. Dashed, and in the accent colour, so it reads as a line
   * being *proposed* rather than one that is there.
   */
  private drawGhost(from: CanvasNode, to: { x: number; y: number }): void {
    // Re-attached as well as created: `drawWires` empties the layer whenever a
    // note moves, which would leave this holding an element that is no longer
    // in the document — and setting attributes on one of those draws nothing.
    if (this.ghost && !this.ghost.isConnected) this.wires.appendChild(this.ghost)
    if (!this.ghost) {
      this.ghost = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      this.ghost.setAttribute('class', 'canvas-wire canvas-wire--ghost')
      this.ghost.setAttribute('fill', 'none')
      // The same head the finished line gets, so the preview shows which way
      // round the connection is going to be.
      this.ghost.setAttribute('marker-end', 'url(#canvas-arrow)')
      this.wires.appendChild(this.ghost)
    }
    // Aimed at the cursor as though it were a note, so the curve leaves the
    // side the finished line would leave from and the preview does not jump
    // when it lands.
    const target: CanvasNode = { id: '', type: 'text', x: to.x, y: to.y, width: 1, height: 1 }
    const side = facing(from, target)
    this.ghost.setAttribute('d', curve(anchor(from, side), side, to, facing(target, from)))
  }

  private clearGhost(): void {
    this.ghost?.remove()
    this.ghost = null
  }

  /** Brings everything into view, which is also what an empty canvas needs. */
  private fit(): void {
    if (!this.nodes.length) {
      this.panX = 40
      this.panY = 40
      this.scale = 1
      this.applyTransform()
      return
    }
    const box = boundsOf(this.nodes)
    if (!box) return
    const { minX, minY, maxX, maxY } = box

    const rect = this.element.getBoundingClientRect()
    const pad = 60
    const zoom = clamp(
      Math.min((rect.width - pad) / (maxX - minX || 1), (rect.height - pad) / (maxY - minY || 1)),
      MIN_ZOOM,
      1
    )
    this.scale = zoom
    this.panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom
    this.panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom
    this.applyTransform()
  }

  // ------------------------------------------------------------------- edits

  private addNode(at: { x: number; y: number }): void {
    const node = this.place({ type: 'text', text: '' }, at, NODE_W, NODE_H)
    this.render()
    this.queueSave()
    // Straight into editing: a note nobody typed into is a box of nothing, and
    // the reason to make one is always to write in it.
    this.edit(node.id)
  }

  /**
   * Puts a node of any type on the canvas, and returns it.
   *
   * Groups go to the *front* of the array rather than the end, which is JSON
   * Canvas's way of saying "underneath": the spec places nodes in ascending
   * z-order, so a container has to be first or it covers what it contains.
   */
  private place(
    fields: Partial<CanvasNode> & { type: CanvasNode['type'] },
    at: { x: number; y: number },
    width: number,
    height: number
  ): CanvasNode {
    const node: CanvasNode = {
      id: id(),
      x: Math.round(at.x),
      y: Math.round(at.y),
      width,
      height,
      ...fields,
    }
    if (node.type === 'group') this.nodes.unshift(node)
    else this.nodes.push(node)
    return node
  }

  /** A container to put other notes on. Bigger, and behind them. */
  private addGroup(at: { x: number; y: number }): void {
    this.place({ type: 'group', label: 'Group' }, at, GROUP_W, GROUP_H)
    this.render()
    this.queueSave()
  }

  /** A node that is a URL. Opened in the real browser, not in the app. */
  private async addLink(at: { x: number; y: number }): Promise<void> {
    const url = await promptDialog({
      title: 'Add a link',
      body: 'The address this note should point at.',
      placeholder: 'https://example.com',
    })
    if (!url?.trim()) return
    this.place({ type: 'link', url: url.trim() }, at, NODE_W, LINK_H)
    this.render()
    this.queueSave()
  }

  /**
   * Puts an existing file on the canvas.
   *
   * The other way in is dropping one from the file tree, which is better when
   * you can see it — and useless when you cannot, which is the case this is
   * for. A markdown file becomes a card showing the note itself; anything else
   * becomes a card that opens it.
   */
  private async addExisting(at: { x: number; y: number }): Promise<void> {
    let picked: string | null = null
    try {
      picked = await backend().pickOpenFile({ title: 'Put a file on the canvas', anyFile: true })
    } catch {
      return
    }
    if (!picked) return
    this.addFile(picked, at)
    void this.loadFiles()
  }

  /**
   * Puts an existing canvas on this one, as a card that draws it.
   *
   * The project's canvases, listed where the click was. A canvas is a file, and
   * the spec puts no restriction on which kind a file node points at — which is
   * exactly why nesting works — but a general file picker is a poor way to
   * offer it: "a canvas can hold a canvas" is not something anyone would think
   * to try by browsing for one.
   */
  private chooseCanvasNode(at: { x: number; y: number }, x: number, y: number): void {
    const here = this.file().toLowerCase()
    // Not this one. A card drawing the canvas it is drawn on is a mirror facing
    // a mirror, and the format allowing it does not make it useful.
    const others = this.siblings.filter((path) => path.toLowerCase() !== here)

    showContextMenu(x, y, [
      ...others.map((path) => ({
        label: path.split(/[\\/]/).pop() ?? path,
        onClick: () => {
          this.addFile(path, at)
          void this.loadFiles()
        },
      })),
      ...(others.length ? (['separator'] as MenuEntry[]) : []),
      { label: 'Browse…', onClick: () => void this.addCanvasNode(at) },
    ])
  }

  /** The same, through the system's dialog, for a canvas in another project. */
  private async addCanvasNode(at: { x: number; y: number }): Promise<void> {
    let picked: string | null = null
    try {
      picked = await backend().pickOpenFile({
        title: 'Put a canvas on this canvas',
        filters: CANVAS_FILTERS,
      })
    } catch {
      return
    }
    if (!picked) return
    if (!isCanvasPath(picked)) {
      showToast('Not a canvas', 'A canvas is a `.canvas` file.', { kind: 'warn' })
      return
    }
    const same = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    if (same(picked) === same(this.file())) {
      showToast('That is this canvas', 'A canvas cannot hold itself.', { kind: 'warn' })
      return
    }
    this.addFile(picked, at)
    void this.loadFiles()
  }

  /**
   * A node that is a file in the project.
   *
   * Made by dropping one on the canvas rather than by a button, because the app
   * already has file dragging and a picker would be a second way to do a thing
   * the file tree does better. The path is stored relative to the project where
   * it can be, which is what the spec means by "the path to the file within the
   * system" — and what makes a canvas still work after the project moves.
   */
  private addFile(path: string, at: { x: number; y: number }): void {
    const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
    const root = (workspace?.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const full = path.replace(/\\/g, '/')
    const relative =
      root && full.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? full.slice(root.length + 1) : full

    // A markdown file gets a card the size of a note, because it will hold one;
    // a canvas gets a square-ish one, because what it will hold is a picture.
    const isNote = /\.(md|markdown|mdown|mkd)$/i.test(relative)
    const height = isCanvasPath(relative) ? NODE_H * 1.6 : isNote ? NODE_H : LINK_H
    this.place({ type: 'file', file: relative }, at, NODE_W, Math.round(height))
    this.render()
    this.queueSave()
  }

  private removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter((n) => n.id !== nodeId)
    // A line to a node that is gone is a line to nowhere.
    this.edges = this.edges.filter((e) => e.fromNode !== nodeId && e.toNode !== nodeId)
    this.selected = null
    this.render()
    this.queueSave()
  }

  private select(nodeId: string | null): void {
    if (this.selected === nodeId) return
    this.selected = nodeId
    for (const el of this.scene.querySelectorAll('.canvas-node')) {
      el.classList.toggle('selected', (el as HTMLElement).dataset.id === nodeId)
    }
  }

  /**
   * What double-clicking a note does, which depends on what the note is.
   *
   * A text note is edited. A file opens in a reader, a link opens in the real
   * browser. Editing a file node's path in place would be a way to break the
   * link by typing, and there is nothing in a link node to write.
   */
  private open(node: CanvasNode): void {
    if (node.type === 'text') {
      this.edit(node.id)
      return
    }
    if (node.type === 'group') {
      // The only thing a group holds that is worth changing here.
      void this.renameGroup(node)
      return
    }
    if (node.type === 'link' && node.url) {
      void backend().openExternal(node.url)
      return
    }
    if (this.isNote(node)) {
      // Edited here rather than opened elsewhere: the card is the note, and
      // sending somebody to another pane to change what is in front of them is
      // the thing a canvas exists to avoid.
      this.edit(node.id)
      return
    }
    if (node.type === 'file' && node.file) {
      const workspace = store.workspaces.find((w) => w.id === this.workspaceId)
      if (!workspace) return
      const full = joinPath(backend().capabilities.platform, workspace.cwd, node.file)
      // A canvas inside a canvas opens as a canvas, in its own tab. The card
      // shows a picture of it; this is the way in. Deliberately *not* a live
      // canvas nested in the card — pan and zoom inside pan and zoom fights the
      // surface it sits on, and Obsidian's embed clicks through for the same
      // reason.
      if (isCanvasPath(full)) {
        actions.openCanvas(this.workspaceId, full)
        return
      }
      // Through the same event the search pane and the file tree use, so a file
      // node opens where every other file in the app opens.
      window.dispatchEvent(new CustomEvent('canvas-open-file', { detail: { file: full } }))
    }
  }

  private async renameGroup(node: CanvasNode): Promise<void> {
    const label = await promptDialog({
      title: 'Name this group',
      body: 'What the container is for.',
      initial: node.label ?? '',
    })
    if (label === null) return
    node.label = label
    this.render()
    this.queueSave()
  }

  private edit(nodeId: string): void {
    const el = this.scene.querySelector<HTMLElement>(`.canvas-node[data-id="${nodeId}"]`)
    const node = this.nodes.find((n) => n.id === nodeId)
    if (!el || !node) return
    if (node.type !== 'text' && !this.isNote(node)) return

    const area = document.createElement('textarea')
    area.className = 'canvas-node__edit'
    area.value =
      node.type === 'file' ? (this.files.get(this.fullPath(node))?.text ?? '') : (node.text ?? '')
    area.spellcheck = false

    const body = el.querySelector('.canvas-node__body')
    body?.replaceChildren(area)
    area.focus()
    area.select()

    const commit = (): void => {
      if (node.type === 'file') {
        // Straight to the file on disk. The canvas file itself holds only the
        // path, so there is nothing to save there.
        void this.saveFile(node, area.value)
        const full = this.fullPath(node)
        const held = this.files.get(full)
        if (held) this.files.set(full, { ...held, text: area.value })
        this.render()
        return
      }
      node.text = area.value
      this.render()
      this.queueSave()
    }
    area.addEventListener('blur', commit)
    area.addEventListener('keydown', (e) => {
      // Escape commits rather than cancelling: there is no version of this where
      // somebody wanted the words they just typed thrown away, and Ctrl+Z in the
      // box is the undo they would reach for.
      if (e.key === 'Escape') {
        e.preventDefault()
        area.blur()
      }
      e.stopPropagation()
    })
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    if (this.disposed) return
    for (const el of [...this.scene.querySelectorAll('.canvas-node')]) el.remove()

    if (this.loaded && !this.nodes.length) {
      this.element.classList.add('canvas-pane--empty')
    } else {
      this.element.classList.remove('canvas-pane--empty')
    }

    for (const node of this.nodes) this.scene.appendChild(this.nodeEl(node))
    this.drawWires()
  }

  private nodeEl(node: CanvasNode): HTMLElement {
    const el = document.createElement('div')
    el.className = `canvas-node canvas-node--${node.type}`
    el.dataset.id = node.id
    if (node.id === this.selected) el.classList.add('selected')
    // Every note holding the search, lit at once. The one Enter is on is the
    // selected one, so the two marks stack rather than competing.
    if (this.matches.includes(node.id)) el.classList.add('canvas-node--match')
    el.style.left = `${node.x}px`
    el.style.top = `${node.y}px`
    el.style.width = `${node.width}px`
    el.style.height = `${node.height}px`

    const tint = colorOf(node.color)
    if (tint) el.style.borderColor = tint

    const body = document.createElement('div')
    body.className = 'canvas-node__body'
    const path = node.type === 'file' ? (node.file ?? '') : (node.label ?? node.url ?? '')
    const held = node.type === 'file' ? this.files.get(this.fullPath(node)) : undefined

    if (node.type === 'text') {
      // "Plain text with Markdown syntax" is what the spec says a text node
      // holds, so it is rendered as markdown rather than shown raw — which also
      // means a heading, a list, a `[[link]]` and even a mermaid diagram all
      // work inside a note, for free.
      body.classList.add('markdown')
      body.appendChild(renderMarkdown(node.text ?? '', folderOf(this.file())))
    } else if (node.type === 'group') {
      body.textContent = node.label ?? ''
    } else if (node.type === 'file' && isImagePath(path)) {
      // The picture itself. Canvases are full of them, and a card showing a
      // filename where a screenshot should be is a card doing nothing.
      el.classList.add('canvas-node--note', 'canvas-node--image')
      el.appendChild(this.fileStrip(path))
      const img = document.createElement('img')
      img.className = 'canvas-node__image'
      img.src = encodeImagePath(this.fullPath(node))
      img.alt = path
      img.loading = 'lazy'
      img.addEventListener('error', () => {
        img.remove()
        body.textContent = 'That picture is not there any more.'
        body.classList.add('canvas-node__missing')
      })
      body.appendChild(img)
    } else if (held && isCanvasPath(path)) {
      // A canvas on a canvas, drawn as what it is: a small picture of its own
      // notes and the lines between them. A filename would say "there is
      // another canvas" and nothing about which one — and the whole reason to
      // nest them is that the shape of the thing is the information.
      el.classList.add('canvas-node--note', 'canvas-node--nested')
      el.appendChild(this.fileStrip(path))
      if (held.mtime < 0) {
        body.textContent = 'That canvas is not there any more.'
        body.classList.add('canvas-node__missing')
      } else {
        const inner = readCanvas(held.text)
        if (!inner.nodes.length) {
          body.textContent = 'An empty canvas. Double-click to open it.'
          body.classList.add('canvas-node__missing')
        } else {
          body.appendChild(thumbnail(inner))
        }
      }
    } else if (held && this.showsContent(node) && this.isNote(node)) {
      // A markdown file node *is* the note, so the card shows what is in it —
      // that is the difference between a canvas and a page of shortcuts.
      el.classList.add('canvas-node--note')
      el.appendChild(this.fileStrip(path))
      body.classList.add('markdown')
      if (held.mtime < 0) {
        body.textContent = 'This file is not there any more.'
        body.classList.add('canvas-node__missing')
      } else if (!held.text.trim()) {
        body.textContent = 'Empty. Double-click to write in it.'
        body.classList.add('canvas-node__missing')
      } else {
        body.appendChild(renderMarkdown(held.text, folderOf(this.fullPath(node))))
      }
    } else if (held && this.showsContent(node)) {
      // The first page. Enough to say "this is the file that does X", which is
      // what a source file is on a canvas for — and read-only, because editing
      // code on a card two hundred pixels wide is worse than opening the editor.
      el.classList.add('canvas-node--note', 'canvas-node--code')
      el.appendChild(this.fileStrip(path))
      const pre = document.createElement('pre')
      pre.className = 'canvas-node__code'
      pre.textContent =
        held.mtime < 0
          ? 'This file is not there any more.'
          : held.text.split('\n').slice(0, CODE_LINES).join('\n')
      body.appendChild(pre)
    } else {
      // A door to the pane that does this properly — a hex view, a grid, a
      // picture format we cannot draw. The leaf, with the folder as hover text.
      body.textContent = path.split('/').pop() ?? path
      if (path !== body.textContent) body.title = path
    }
    el.appendChild(body)

    // The handle a connection is dragged from. On the right edge, because that
    // is where a left-to-right reader expects a line to leave.
    const handle = document.createElement('div')
    handle.className = 'canvas-node__link'
    handle.title = 'Drag to another note to connect them'
    el.appendChild(handle)

    // And the one that changes its size. Bottom-right, where every window and
    // every text area on this machine puts it, because a note whose text does
    // not fit is the ordinary case — the size in the file is a starting guess,
    // and a card two hundred pixels wide cannot hold a paragraph.
    const grip = document.createElement('div')
    grip.className = 'canvas-node__resize'
    grip.title = 'Drag to resize · double-click to fit the text'
    el.appendChild(grip)

    this.wireNode(el, node, handle, grip)
    return el
  }

  /** The file's name across the top of a card that is showing its contents. */
  private fileStrip(path: string): HTMLElement {
    const name = document.createElement('div')
    name.className = 'canvas-node__file'
    name.textContent = path.split('/').pop() ?? path
    name.title = path
    return name
  }

  /**
   * Grows a card until its content fits, or shrinks it until it stops being
   * empty space.
   *
   * `scrollHeight` on the body is what the content actually needs; the card's
   * own padding and any file-name strip are the difference between that and the
   * card. Measured from the element rather than computed from the text, because
   * the text is markdown — a heading, a list and a mermaid diagram are all
   * different heights and only the browser knows which.
   */
  private fitHeight(el: HTMLElement, node: CanvasNode): void {
    const body = el.querySelector('.canvas-node__body') as HTMLElement | null
    if (!body) return
    const chrome = el.getBoundingClientRect().height / this.scale - body.clientHeight
    const wanted = body.scrollHeight + chrome
    node.height = Math.max(MIN_H, this.snap ? Math.ceil(wanted / GRID) * GRID : Math.ceil(wanted))
    el.style.height = `${node.height}px`
    this.drawWires()
    this.queueSave()
  }

  private wireNode(
    el: HTMLElement,
    node: CanvasNode,
    handle: HTMLElement,
    grip: HTMLElement
  ): void {
    el.addEventListener('pointerdown', (e) => {
      if (e.target === handle || e.target === grip) return
      e.stopPropagation()
      this.select(node.id)

      const startX = e.clientX
      const startY = e.clientY
      const fromX = node.x
      const fromY = node.y
      el.setPointerCapture(e.pointerId)

      const move = (ev: PointerEvent): void => {
        // Divided by the zoom, or a note would move faster than the cursor when
        // zoomed out and slower when zoomed in.
        const x = fromX + (ev.clientX - startX) / this.scale
        const y = fromY + (ev.clientY - startY) / this.scale
        node.x = this.snap ? Math.round(x / GRID) * GRID : Math.round(x)
        node.y = this.snap ? Math.round(y / GRID) * GRID : Math.round(y)
        el.style.left = `${node.x}px`
        el.style.top = `${node.y}px`
        this.drawWires()
      }
      const up = (): void => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        this.queueSave()
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    })

    el.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      this.open(node)
    })

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.select(node.id)
      this.colourMenu(e.clientX, e.clientY, node)
    })

    // Resizing. The same shape as the move above — capture, follow the pointer
    // divided by the zoom, snap where moving snaps — because a note being made
    // bigger is the same gesture as a note being moved somewhere, and the two
    // behaving differently under the same zoom would be the surprise.
    grip.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.select(node.id)

      const startX = e.clientX
      const startY = e.clientY
      const fromW = node.width
      const fromH = node.height
      grip.setPointerCapture(e.pointerId)

      const move = (ev: PointerEvent): void => {
        const w = fromW + (ev.clientX - startX) / this.scale
        const h = fromH + (ev.clientY - startY) / this.scale
        node.width = Math.max(MIN_W, this.snap ? Math.round(w / GRID) * GRID : Math.round(w))
        node.height = Math.max(MIN_H, this.snap ? Math.round(h / GRID) * GRID : Math.round(h))
        el.style.width = `${node.width}px`
        el.style.height = `${node.height}px`
        // Edges leave from the middle of a side, so every wire touching this
        // note moves with its size, not only with its position.
        this.drawWires()
      }
      const up = (): void => {
        grip.removeEventListener('pointermove', move)
        grip.removeEventListener('pointerup', up)
        this.queueSave()
      }
      grip.addEventListener('pointermove', move)
      grip.addEventListener('pointerup', up)
    })

    // Double-clicking the corner sizes the card to what is in it, which is the
    // thing the drag is usually being done by hand to achieve. The width is
    // kept — that is a layout decision the user made — and only the height
    // follows the text, the way a paragraph reflows rather than a page.
    grip.addEventListener('dblclick', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.fitHeight(el, node)
    })

    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      this.linking = node.id
      this.element.classList.add('canvas-pane--linking')

      // Captured on the handle, so the line keeps following even when the
      // cursor crosses a note — which it has to, since a note is where it is
      // going. Without capture the first note dragged over would swallow the
      // moves and the line would freeze under it.
      handle.setPointerCapture(e.pointerId)
      this.drawGhost(node, this.atPointer(e))

      const move = (ev: PointerEvent): void => this.drawGhost(node, this.atPointer(ev))
      const done = (ev: PointerEvent): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', done)
        handle.removeEventListener('pointercancel', done)
        this.clearGhost()
        try {
          handle.releasePointerCapture(ev.pointerId)
        } catch {
          /* already released */
        }
        // With the pointer captured, the release lands here rather than on the
        // note underneath — so the note under the cursor is found by asking the
        // document what is there.
        const under = document
          .elementsFromPoint(ev.clientX, ev.clientY)
          .find((el) => el.classList.contains('canvas-node')) as HTMLElement | undefined
        if (under?.dataset.id) {
          this.finishLink(under.dataset.id)
          return
        }
        // Released over empty canvas: make a note there and connect to it,
        // which is how a train of thought actually goes — you know there is a
        // next thing before you know what it says. Obsidian does the same.
        this.finishLinkToNew(this.atPointer(ev), { x: ev.clientX, y: ev.clientY })
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', done)
      handle.addEventListener('pointercancel', done)
    })


  }

  /**
   * The lines between notes.
   *
   * Redrawn whole on every move rather than updated in place: a canvas anybody
   * can hold in their head has a few dozen notes, and the arithmetic for one
   * curve is cheaper than the bookkeeping to know which curves changed.
   */
  private drawWires(): void {
    const at = new Map(this.nodes.map((n) => [n.id, n]))
    while (this.wires.firstChild) this.wires.removeChild(this.wires.firstChild)

    const extent = this.nodes.length
      ? {
          w: Math.max(...this.nodes.map((n) => n.x + n.width)) + 200,
          h: Math.max(...this.nodes.map((n) => n.y + n.height)) + 200,
        }
      : { w: 800, h: 600 }
    this.wires.setAttribute('width', String(extent.w))
    this.wires.setAttribute('height', String(extent.h))
    this.wires.setAttribute('viewBox', `0 0 ${extent.w} ${extent.h}`)
    this.wires.appendChild(arrowDefs())

    for (const edge of this.edges) {
      const from = at.get(edge.fromNode)
      const to = at.get(edge.toNode)
      if (!from || !to) continue

      // The spec lets an edge name the side it leaves and arrives at. Where it
      // does not — every edge this pane makes, and plenty made elsewhere — the
      // sides are chosen from where the two notes actually sit, which is what
      // stops a line looping back around a note that is directly above.
      const fromSide = edge.fromSide ?? facing(from, to)
      const toSide = edge.toSide ?? facing(to, from)
      const start = anchor(from, fromSide)
      const end = anchor(to, toSide)

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', 'canvas-wire')
      path.setAttribute('d', curve(start, fromSide, end, toSide))
      path.setAttribute('fill', 'none')

      const tint = colorOf(edge.color)
      if (tint) path.setAttribute('stroke', tint)

      // The spec's defaults, which are not symmetric: nothing at the start,
      // an arrow at the end.
      if ((edge.toEnd ?? 'arrow') === 'arrow') path.setAttribute('marker-end', 'url(#canvas-arrow)')
      if ((edge.fromEnd ?? 'none') === 'arrow') path.setAttribute('marker-start', 'url(#canvas-arrow)')

      this.wires.appendChild(path)

      if (!edge.label) continue
      const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      const plate = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      plate.setAttribute('class', 'canvas-wire__plate')
      plate.setAttribute('x', String(mid.x - (edge.label.length * 6.4) / 2 - 4))
      plate.setAttribute('y', String(mid.y - 9))
      plate.setAttribute('width', String(edge.label.length * 6.4 + 8))
      plate.setAttribute('height', '18')
      plate.setAttribute('rx', '3')

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('class', 'canvas-wire__label')
      text.setAttribute('x', String(mid.x))
      text.setAttribute('y', String(mid.y))
      text.setAttribute('text-anchor', 'middle')
      text.setAttribute('dominant-baseline', 'middle')
      text.textContent = edge.label
      this.wires.append(plate, text)
    }
  }
}

/** The one arrow head, taking the colour of whatever line it ends. */
function arrowDefs(): SVGDefsElement {
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker')
  marker.setAttribute('id', 'canvas-arrow')
  marker.setAttribute('viewBox', '0 0 10 10')
  marker.setAttribute('refX', '9')
  marker.setAttribute('refY', '5')
  marker.setAttribute('markerWidth', '5')
  marker.setAttribute('markerHeight', '5')
  marker.setAttribute('orient', 'auto-start-reverse')
  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  head.setAttribute('d', 'M 0 1 L 10 5 L 0 9 z')
  head.setAttribute('fill', 'context-stroke')
  marker.appendChild(head)
  defs.appendChild(marker)
  return defs
}

/**
 * Whether a file is source this app knows how to colour.
 *
 * Asked of the same table the editor uses, so a card and a tab agree about what
 * a `.ts` is — and so a language added there is understood here without anybody
 * remembering to.
 */
/**
 * Four arrows to the corners: the "fit everything on screen" mark every map,
 * photo viewer and design tool uses. Drawn rather than written because the bar
 * is one control wide now, and a word there reads as a label for the pane.
 */
function fitIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG, 'path')
  // Each corner: the bracket, then the arrow leaving it outwards.
  path.setAttribute(
    'd',
    'M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4M2.6 2.6l4 4M13.4 2.6l-4 4M2.6 13.4l4-4M13.4 13.4l-4-4'
  )
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.3')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

/**
 * A canvas, small enough to sit on another one.
 *
 * Boxes and lines, no text: at a hundred pixels across the words are noise and
 * the arrangement is the whole signal — which of these is the big one, what
 * hangs off what, is this the sketch with three notes or the one with forty.
 * Drawn from the file's own coordinates, scaled to fit, so the picture is the
 * canvas rather than an impression of it.
 */
function thumbnail(canvas: CanvasFile): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg')
  svg.setAttribute('class', 'canvas-thumb')
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  const box = boundsOf(canvas.nodes)
  if (!box) return svg
  const pad = 24
  svg.setAttribute(
    'viewBox',
    `${box.minX - pad} ${box.minY - pad} ${box.maxX - box.minX + pad * 2} ${box.maxY - box.minY + pad * 2}`
  )

  const at = new Map(canvas.nodes.map((n) => [n.id, n]))
  // Lines first, so a box sits on top of what points at it.
  for (const edge of canvas.edges) {
    const from = at.get(edge.fromNode)
    const to = at.get(edge.toNode)
    if (!from || !to) continue
    const line = document.createElementNS(SVG, 'line')
    line.setAttribute('x1', String(from.x + from.width / 2))
    line.setAttribute('y1', String(from.y + from.height / 2))
    line.setAttribute('x2', String(to.x + to.width / 2))
    line.setAttribute('y2', String(to.y + to.height / 2))
    line.setAttribute('class', 'canvas-thumb__wire')
    svg.appendChild(line)
  }
  for (const node of canvas.nodes) {
    const box = document.createElementNS(SVG, 'rect')
    box.setAttribute('x', String(node.x))
    box.setAttribute('y', String(node.y))
    box.setAttribute('width', String(Math.max(1, node.width)))
    box.setAttribute('height', String(Math.max(1, node.height)))
    box.setAttribute('rx', '8')
    box.setAttribute('class', `canvas-thumb__node canvas-thumb__node--${node.type}`)
    const tint = colorOf(node.color)
    if (tint) box.setAttribute('stroke', tint)
    svg.appendChild(box)
  }
  return svg
}

function isCode(path: string): boolean {
  return !!grammarFor(path)
}

/** How many lines of a source file a card shows before it stops. */
const CODE_LINES = 14

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/** Obsidian's ids are opaque strings; sixteen hex characters matches its shape. */
function id(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
}
