/**
 * Images, from wherever the file tree is standing.
 *
 * Two states, and which one it is in is decided entirely by the tree: select an
 * image and it fills the pane; select anything else, or nothing, and you get
 * every image in that folder arranged across the canvas. Navigating the tree
 * moves the gallery with it. Nothing here is opened, in the sense the editor and
 * reader panes mean it — there is no "open this image" step, because the pane is
 * a view onto a selection that already exists.
 *
 * The arrangement maths is all in `shared/images.ts`, pure and tested. This file
 * is the DOM, the loading, and the dragging.
 */
import { backend } from '../backend'
import { trashName } from '../shared/platform'
import { store, type TreeSelection } from './state'
import { showContextMenu, type MenuEntry } from './ui/contextMenu'
import { confirmDialog, promptDialog } from './ui/confirm'
import { copyText } from './ui/clipboard'
import { showToast } from './ui/toast'
import { refreshAllTrees } from './filesPane'
import { DomZoom, stepZoom, type AuxPane, type PaneZoom } from './auxPane'
import {
  fitToHeight,
  isImagePath,
  layoutBoard,
  layoutMasonry,
  layoutRows,
  sortImages,
  type ImageFilter,
  type ImageItem,
  type ImageLayout,
  type ImageSort,
  type Layout,
} from '../shared/images'
import type { BoardPlacement } from '../shared/types'

export interface ImagesPaneHooks {
  /** The folder the workspace's file tree is showing. */
  treeFolder(): string
  /** The row highlighted in that tree. `path` is '' when nothing is. */
  treeSelection(): TreeSelection
  /** Hand an image to whatever the OS opens it with. */
  openExternally(path: string): void
  /** Show an image in a reader-style split, for a proper look at one. */
  revealInTree(path: string): void
}

/** Height a row aims for before it is solved to the width. */
const TARGET_ROW_HEIGHT = 220
const TARGET_COLUMN_WIDTH = 260
const GAP = 8

const LAYOUT_LABELS: Record<ImageLayout, string> = {
  rows: 'Rows',
  masonry: 'Columns',
  board: 'Board',
}

const SORT_LABELS: Record<ImageSort, string> = {
  name: 'Name',
  size: 'Size',
  modified: 'Date',
  random: 'Random',
}

export class ImagesPane implements AuxPane {
  readonly element: HTMLDivElement
  zoom?: PaneZoom

  private readonly head: HTMLDivElement
  private readonly status: HTMLSpanElement
  private readonly canvas: HTMLDivElement
  private readonly single: HTMLDivElement
  private readonly singleImg: HTMLImageElement
  private readonly singleBar: HTMLDivElement
  private readonly singleName: HTMLSpanElement
  private readonly prevBtn: HTMLButtonElement
  private readonly nextBtn: HTMLButtonElement

  /**
   * The image being viewed full-pane, or '' for none.
   *
   * Separate from the tree's selection, and deliberately: maximising is
   * something you do *to* the gallery, from inside it, and it has to work when
   * the gallery is showing a folder rather than one selected file. Session-only
   * — a maximised image is a thing you are looking at now, not a state a pane
   * should reopen in tomorrow.
   */
  private maximized = ''

  /** What the last load produced, before ordering. */
  private items: ImageItem[] = []
  private truncated = false
  private loading = false
  private error = ''

  /** Measured aspect ratios by path, so a re-layout never re-measures. */
  private readonly aspects = new Map<string, number>()

  /** Live cells by path, reused across re-layouts. See `paint`. */
  private readonly cells = new Map<string, HTMLDivElement>()
  /** Which of them already carry the board's drag handlers. */
  private readonly draggable = new Set<string>()
  /** The width the last paint solved against, for recording a drag. */
  private canvasWidth = 0

  /**
   * Zoom and pan of the single image, session-only.
   *
   * 1 is "fit the pane", not "actual size" — the image is already scaled to
   * fit, and zooming is relative to what you are looking at. Reset whenever the
   * image changes: a zoom is about the picture in front of you, and carrying it
   * to the next one lands you somewhere arbitrary in a photograph of a
   * different shape.
   */
  private scale = 1
  private panX = 0
  private panY = 0
  /** Which image the current zoom belongs to, so a new one starts fitted. */
  private viewingPath = ''
  /** Where the last press landed, and whether it became a drag. See the click
   * handler: a pan must not be mistaken for a click on the backdrop. */
  private pressedOnBackdrop = false
  private dragMoved = false
  /** Zoom for the gallery, which scales its layout rather than an image. */
  private readonly galleryZoom: DomZoom

  /** What the pane was showing last sync, to decide whether to reload. */
  private shownFolder = ''
  private shownSelection = ''
  private shownRecursive: boolean | undefined

  private disposed = false
  private frame = 0
  private loadToken = 0
  private readonly observer: ResizeObserver

  constructor(
    readonly paneId: string,
    private readonly hooks: ImagesPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'images-pane'

    this.head = document.createElement('div')
    this.head.className = 'images-head'
    this.element.appendChild(this.head)

    this.status = document.createElement('span')
    this.status.className = 'images-status'

    this.canvas = document.createElement('div')
    this.canvas.className = 'images-canvas'
    this.element.appendChild(this.canvas)

    this.single = document.createElement('div')
    this.single.className = 'images-single'
    this.single.hidden = true

    // Only shown when maximised. A file selected in the tree needs no bar —
    // the tree is right there and already says which file it is.
    this.singleBar = document.createElement('div')
    this.singleBar.className = 'images-single-bar'

    // Every one of these has a key as well, and says so. The buttons are for
    // the times your hand is on the mouse; the keys are for the times it is
    // not, and neither is the "real" one.
    this.prevBtn = this.button('‹', 'Previous (←)', () => this.step(-1))
    this.nextBtn = this.button('›', 'Next (→)', () => this.step(1))
    this.singleBar.append(this.prevBtn, this.nextBtn)

    this.singleName = document.createElement('span')
    this.singleName.className = 'images-single-name'
    this.singleBar.appendChild(this.singleName)

    const remove = this.button('Delete', 'Delete this image (Del)', () => {
      void this.remove(this.maximized)
    })
    remove.classList.add('danger')
    this.singleBar.appendChild(remove)

    this.singleBar.appendChild(
      this.button('Close', 'Back to the gallery (Esc)', () => this.setMaximized(''))
    )
    this.single.appendChild(this.singleBar)

    this.singleImg = document.createElement('img')
    this.singleImg.className = 'images-single-img'
    this.single.appendChild(this.singleImg)
    this.element.appendChild(this.single)

    // Focusable so the viewer can have keys of its own. -1 keeps it out of the
    // tab order: this is a pane, not a form control.
    this.element.tabIndex = -1
    this.element.addEventListener('keydown', (e) => this.onKeyDown(e))
    // Clicking the backdrop leaves the viewer, the way every lightbox does.
    // Not the image itself, which you may well be clicking to focus the pane.
    //
    // Both conditions are read from where the gesture *began*, not from the
    // click event, and neither is optional. `click` reports the common ancestor
    // of press and release, so a drag that ends over the backdrop names the
    // backdrop however it started — and while panning, the pointer is captured
    // by this element, which retargets everything here regardless. Either one
    // would close the viewer the moment you let go of a pan.
    this.single.addEventListener('click', () => {
      if (!this.maximized) return
      if (this.dragMoved || !this.pressedOnBackdrop) return
      this.setMaximized('')
    })

    // Scroll zooms the image. Bare scroll, not Ctrl+scroll, because there is
    // nothing else a wheel could mean here — the picture is already fitted, so
    // there is nothing to scroll — and it is what every image viewer does.
    // Passive is off: this has to be able to stop the page scrolling instead.
    this.single.addEventListener('wheel', (e) => this.onSingleWheel(e), { passive: false })
    // One handler for both, because the click above needs to know where the
    // press landed and whether it turned into a drag — and only pointerdown
    // still knows, before any capture retargets things.
    this.single.addEventListener('pointerdown', (e) => {
      this.pressedOnBackdrop = e.target === this.single
      this.dragMoved = false
      this.onSinglePan(e)
    })
    // Double-click toggles between fitted and 2×, at the point you clicked —
    // the shortcut for "let me see that bit properly".
    this.singleImg.addEventListener('dblclick', (e) => {
      e.preventDefault()
      if (this.scale === 1) this.zoomAt(2, e.clientX, e.clientY)
      else this.resetView()
    })

    // The layout is a function of the canvas width, so a resized pane — or a
    // dragged split divider — has to re-solve it. Cheap: the arithmetic runs
    // over an array that is already in memory and nothing is re-decoded.
    this.observer = new ResizeObserver(() => this.scheduleRender())
    this.observer.observe(this.canvas)

    this.canvas.addEventListener('contextmenu', (e) => this.onCanvasMenu(e))
    this.singleImg.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.showImageMenu(e, this.shownSelection)
    })

    // Its own, rather than the `DomZoom` that `Terminals` fits to any pane that
    // does not provide one. Two different things are zoomable here and the
    // gesture has to mean the right one: in the gallery it scales the layout,
    // and on a single image it scales the image — which is the same thing the
    // wheel already does, so Ctrl+scroll and Ctrl+`+` agree with each other.
    this.galleryZoom = new DomZoom(this.canvas)
    this.zoom = {
      step: (direction) => {
        if (this.single.hidden) {
          this.galleryZoom.step(direction)
          return
        }
        // About the middle of the image, there being no pointer involved.
        const box = this.singleImg.getBoundingClientRect()
        this.zoomAt(
          stepZoom(this.scale, direction),
          box.left + box.width / 2,
          box.top + box.height / 2
        )
      },
      reset: () => {
        if (this.single.hidden) this.galleryZoom.reset()
        else this.resetView()
      },
      factor: () => (this.single.hidden ? this.galleryZoom.factor() : this.scale),
    }

    this.renderHead()
    this.applyFilter()
    this.sync()
  }

  // ------------------------------------------------------------ pane settings
  //
  // Read through the pane first and the setting second, so a pane you have
  // adjusted keeps what you set while an untouched one follows the default.

  private get layout(): ImageLayout {
    return store.pane(this.paneId)?.imageLayout ?? store.settings.imageLayout
  }

  private get sort(): ImageSort {
    return store.pane(this.paneId)?.imageSort ?? store.settings.imageSort
  }

  private get sortDesc(): boolean {
    return store.pane(this.paneId)?.imageSortDesc ?? store.settings.imageSortDesc
  }

  private get recursive(): boolean {
    return store.pane(this.paneId)?.imageRecursive ?? store.settings.imageRecursive
  }

  private get fit(): boolean {
    return store.pane(this.paneId)?.imageFit ?? store.settings.imageFit
  }

  private get filter(): ImageFilter {
    return store.pane(this.paneId)?.imageFilter ?? store.settings.imageFilter
  }

  private get seed(): number {
    return store.pane(this.paneId)?.imageSeed ?? 1
  }

  private get board(): Record<string, BoardPlacement> {
    return store.pane(this.paneId)?.imageBoard ?? {}
  }

  // ------------------------------------------------------------------- header

  private renderHead(): void {
    this.head.replaceChildren()

    this.head.appendChild(
      this.dropdown(LAYOUT_LABELS[this.layout], 'Arrangement', () =>
        (Object.keys(LAYOUT_LABELS) as ImageLayout[]).map((kind) => ({
          label: LAYOUT_LABELS[kind],
          checked: this.layout === kind,
          onClick: () => {
            store.setPaneImageOptions(this.paneId, { imageLayout: kind })
            this.renderHead()
            this.scheduleRender()
          },
        }))
      )
    )

    // Direction is folded into the sort menu rather than sitting beside it as
    // an arrow: it is meaningless for Random, and a control that greys itself
    // out half the time is worse than one that simply is not there.
    this.head.appendChild(
      this.dropdown(SORT_LABELS[this.sort], 'Order', () => {
        const entries: MenuEntry[] = (Object.keys(SORT_LABELS) as ImageSort[]).map((kind) => ({
          label: SORT_LABELS[kind],
          checked: this.sort === kind,
          onClick: () => {
            store.setPaneImageOptions(this.paneId, { imageSort: kind })
            this.renderHead()
            this.scheduleRender()
          },
        }))
        if (this.sort === 'random') {
          return [...entries, 'separator', { label: 'Shuffle again', onClick: () => this.reseed() }]
        }
        return [
          ...entries,
          'separator',
          {
            label: 'Reverse',
            checked: this.sortDesc,
            onClick: () => {
              store.setPaneImageOptions(this.paneId, { imageSortDesc: !this.sortDesc })
              this.renderHead()
              this.scheduleRender()
            },
          },
        ]
      })
    )

    this.head.appendChild(
      this.toggle('Subfolders', this.recursive, 'Include images in every folder beneath this one', () => {
        store.setPaneImageOptions(this.paneId, { imageRecursive: !this.recursive })
        this.renderHead()
        // The file list itself changes, not just its arrangement.
        this.shownRecursive = undefined
        this.sync()
      })
    )

    this.head.appendChild(
      this.toggle('Fit', this.fit, 'Shrink everything until it fits without scrolling', () => {
        store.setPaneImageOptions(this.paneId, { imageFit: !this.fit })
        this.renderHead()
        this.scheduleRender()
      })
    )

    // Named for what it is rather than "Smoothing off": someone zooming into a
    // sprite is looking for nearest-neighbour, and that is the word they will
    // scan the bar for.
    this.head.appendChild(
      this.toggle(
        'Nearest',
        this.filter === 'pixel',
        'Nearest-neighbour scaling, for pixel art — no blur between pixels',
        () => {
          store.setPaneImageOptions(this.paneId, {
            imageFilter: this.filter === 'pixel' ? 'smooth' : 'pixel',
          })
          this.renderHead()
          this.applyFilter()
        }
      )
    )

    if (this.layout === 'board' && Object.keys(this.board).length > 0) {
      this.head.appendChild(
        this.button('Reset board', 'Put every image back where the packing puts it', () => {
          store.setPaneImageOptions(this.paneId, { imageBoard: {} })
          this.renderHead()
          this.scheduleRender()
        })
      )
    }

    this.head.appendChild(this.status)
  }

  private dropdown(label: string, title: string, entries: () => MenuEntry[]): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'images-btn'
    b.textContent = `${label} ▾`
    b.title = title
    b.addEventListener('click', () => {
      const box = b.getBoundingClientRect()
      showContextMenu(box.left, box.bottom + 2, entries())
    })
    return b
  }

  private toggle(label: string, on: boolean, title: string, onClick: () => void): HTMLButtonElement {
    const b = this.button(label, title, onClick)
    b.classList.toggle('active', on)
    return b
  }

  private button(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = 'images-btn'
    b.textContent = label
    b.title = title
    b.addEventListener('click', onClick)
    return b
  }

  private reseed(): void {
    // A fresh seed is the only thing that changes; the order is a pure function
    // of it, so this is what "shuffle" means here.
    store.setPaneImageOptions(this.paneId, {
      imageSeed: Math.floor(Math.random() * 0x7fffffff) || 1,
    })
    this.scheduleRender()
  }

  // -------------------------------------------------------------------- state

  /**
   * Called on every app render. Reloads only when the folder, the selection or
   * the recursive flag has actually moved — this fires for unrelated changes
   * too, and re-walking a photo library on a theme change would be a disaster.
   */
  sync(): void {
    if (this.disposed) return
    const { folder, single } = this.resolve()
    const recursive = this.recursive

    const singleChanged = single !== this.shownSelection
    const needsList = folder !== this.shownFolder || recursive !== this.shownRecursive

    if (!singleChanged && !needsList) return

    this.shownSelection = single
    if (needsList) {
      this.shownFolder = folder
      this.shownRecursive = recursive
      void this.load(folder, recursive)
      return
    }
    this.scheduleRender()
  }

  /**
   * What the tree's state means for this pane: which folder to fill from, and
   * which single image — if any — to show instead.
   *
   * A selected *folder* is a folder to show, not a thing to open. That is the
   * difference between this and every other pane that watches the tree: opening
   * a folder means navigating into it, and there is nothing to navigate here,
   * so a single click is the whole gesture. Selecting a folder therefore beats
   * the folder the tree is standing in.
   *
   * A selected image wins over both, and anything else selected — a `.ts`, a
   * `.md` — means neither, so the gallery simply stays on the folder.
   */
  private resolve(): { folder: string; single: string } {
    const selection = this.hooks.treeSelection()
    if (selection.path && selection.isDir) {
      return { folder: selection.path, single: '' }
    }
    return {
      folder: this.hooks.treeFolder(),
      single: selection.path && isImagePath(selection.path) ? selection.path : '',
    }
  }

  private async load(folder: string, recursive: boolean): Promise<void> {
    const token = ++this.loadToken
    this.loading = true
    this.error = ''
    this.scheduleRender()

    if (!folder) {
      this.items = []
      this.loading = false
      this.scheduleRender()
      return
    }

    try {
      // Hidden images are never included. The tree's own hidden-file toggle is
      // per-pane state that this pane has no way to see, and a gallery that
      // silently pulled in `.thumbnails` and cache directories would be worse
      // than one that misses the rare deliberately-hidden photograph.
      const result = await backend().listImages(folder, recursive, false)
      // A slower earlier load must not overwrite a newer one — navigating two
      // folders quickly is exactly how that happens.
      if (this.disposed || token !== this.loadToken) return
      this.items = result.files.map((file) => ({
        path: file.path,
        name: file.name,
        size: file.size,
        modified: file.modified,
        aspect: this.aspects.get(file.path) ?? 0,
      }))
      this.truncated = result.truncated
      // Navigating the tree while maximised leaves the viewer holding a file
      // that is no longer part of this gallery — and with it, arrow keys that
      // step through a list it is not in. Back to the gallery instead.
      if (this.maximized && !this.items.some((i) => i.path === this.maximized)) {
        this.maximized = ''
      }
    } catch (err) {
      if (this.disposed || token !== this.loadToken) return
      this.items = []
      this.truncated = false
      this.maximized = ''
      this.error = err instanceof Error ? err.message : String(err)
    }
    this.loading = false
    this.scheduleRender()
  }

  // ------------------------------------------------------------------ drawing

  private scheduleRender(): void {
    if (this.disposed || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.render()
    })
  }

  private render(): void {
    if (this.disposed) return

    // Maximising beats the tree: it is a deliberate act inside this pane, and
    // it has to hold even while the gallery is showing a whole folder.
    // Otherwise `resolve()` has already reduced the selection to '' or an
    // image path — never a folder.
    const single = this.maximized || this.shownSelection
    if (single) {
      this.renderSingle(single)
      return
    }
    this.single.hidden = true
    this.canvas.hidden = false
    this.renderGallery()
  }

  private renderSingle(path: string): void {
    this.canvas.hidden = true
    this.single.hidden = false
    // A different picture starts fitted. Zoom is about the image in front of
    // you; carrying it over lands you somewhere arbitrary in a photograph of a
    // different shape. `setMaximized` resets too, but selecting another file in
    // the tree does not go through it.
    if (path !== this.viewingPath) {
      this.viewingPath = path
      this.resetView()
    }
    const url = backend().imageUrl(path)
    if (this.singleImg.src !== url) this.singleImg.src = url
    this.singleImg.alt = path
    this.singleImg.title = path

    const maximized = Boolean(this.maximized)
    this.singleBar.hidden = !maximized
    this.single.classList.toggle('maximized', maximized)

    if (maximized) {
      const ordered = this.ordered()
      const at = ordered.findIndex((i) => i.path === path)
      this.singleName.textContent =
        at >= 0 && ordered.length > 1
          ? `${fileName(path)}  ·  ${at + 1} of ${ordered.length}`
          : fileName(path)
      // Nothing to step to when the folder holds one image. Stepping wraps, so
      // these are only ever dead in that one case.
      const alone = ordered.length < 2
      this.prevBtn.disabled = alone
      this.nextBtn.disabled = alone
    }
    this.status.textContent = fileName(path)
  }

  private renderGallery(): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight

    if (this.error) {
      this.showMessage(this.error)
      return
    }
    if (this.loading && this.items.length === 0) {
      this.showMessage('Reading…')
      return
    }
    if (this.items.length === 0) {
      this.showMessage(
        this.shownFolder
          ? `No images in ${folderLeaf(this.shownFolder)}${this.recursive ? ' or anything beneath it' : ''}`
          : 'No folder — open a file tree in this workspace'
      )
      return
    }

    const ordered = sortImages(this.items, this.sort, this.sortDesc, this.seed)
    const layout = this.solve(ordered, width, height)

    this.status.textContent =
      `${this.items.length} image${this.items.length === 1 ? '' : 's'}` +
      (this.truncated ? ' (showing the first found)' : '')

    this.paint(layout, width)
  }

  private solve(ordered: ImageItem[], width: number, height: number): Layout {
    const kind = this.layout
    const build = (target: number): Layout => {
      if (kind === 'masonry') {
        // The knob for masonry is column width, so "smaller" means narrower
        // columns rather than shorter rows. Scaled off the same target so the
        // fit search below drives all three layouts identically.
        const columnWidth = (target / TARGET_ROW_HEIGHT) * TARGET_COLUMN_WIDTH
        return layoutMasonry(ordered, width, columnWidth, GAP)
      }
      if (kind === 'board') return layoutBoard(ordered, width, target, GAP, this.seed)
      return layoutRows(ordered, width, target, GAP)
    }

    const base = this.fit
      ? fitToHeight(build, height, TARGET_ROW_HEIGHT)
      : build(TARGET_ROW_HEIGHT)

    return kind === 'board' ? this.applyBoard(base, width) : base
  }

  /**
   * Overlays hand-placed positions on the packed ones.
   *
   * Only images that were actually dragged carry an entry, so a board is the
   * packing everywhere you have not intervened. Stored as fractions of the
   * canvas, which is what makes a resized pane keep the arrangement rather than
   * pushing half of it out of view.
   */
  private applyBoard(layout: Layout, width: number): Layout {
    const board = this.board
    if (Object.keys(board).length === 0) return layout

    let bottom = layout.height
    const placed = layout.placed.map((entry) => {
      const saved = board[entry.item.path]
      if (!saved) return entry
      const w = Math.max(24, saved.w * width)
      const aspect = entry.width / entry.height || 1
      const h = w / aspect
      const x = saved.x * width
      const y = saved.y * width
      bottom = Math.max(bottom, y + h)
      return { ...entry, x, y, width: w, height: h }
    })
    return { placed, height: bottom }
  }

  private showMessage(text: string): void {
    // The cell map has to be emptied with the canvas, or the next paint reuses
    // elements it thinks are mounted and draws nothing.
    for (const cell of this.cells.values()) cell.querySelector('img')?.removeAttribute('src')
    this.cells.clear()
    this.draggable.clear()
    this.canvas.replaceChildren()
    this.canvas.style.removeProperty('height')

    const box = document.createElement('div')
    box.className = 'images-empty'
    box.textContent = text
    this.canvas.appendChild(box)
    this.status.textContent = ''
  }

  /**
   * Draws a solved layout, reusing the elements already on screen.
   *
   * The obvious version rebuilds every cell, and it is wrong for one specific
   * reason: dragging a split divider fires the ResizeObserver on every frame, so
   * a rebuild means creating and destroying a few hundred `<img>` elements sixty
   * times a second. Chromium re-decodes on a fresh element even when the bytes
   * are cached, and the drag turns to treacle.
   *
   * Keyed by path, so a re-layout is a few style writes per cell and no decoding
   * at all. Only a changed *set* of images creates or destroys anything.
   */
  private paint(layout: Layout, width: number): void {
    const board = this.layout === 'board'
    const live = new Set<string>()
    // A message left by an earlier empty state is not one of our cells, so the
    // reconciliation below would never remove it.
    this.canvas.querySelector('.images-empty')?.remove()

    for (const entry of layout.placed) {
      const path = entry.item.path
      live.add(path)

      let cell = this.cells.get(path)
      if (!cell) {
        cell = document.createElement('div')

        const img = document.createElement('img')
        img.className = 'images-thumb'
        img.loading = 'lazy'
        // Decoding off the main thread: with a hundred images the synchronous
        // path stalls the whole window, scrolling included.
        img.decoding = 'async'
        img.draggable = false
        img.alt = entry.item.name
        img.addEventListener('load', () => this.measured(path, img))
        img.addEventListener('error', () => cell!.classList.add('broken'), { once: true })
        img.src = backend().imageUrl(path)

        cell.appendChild(img)
        cell.title = entry.item.name
        cell.addEventListener('contextmenu', (e) => {
          e.preventDefault()
          e.stopPropagation()
          this.showImageMenu(e, path)
        })
        // Read off the click count rather than a `dblclick` listener, to match
        // the file tree — and because on the board the first click begins a
        // drag, which a `dblclick` would have to be untangled from.
        cell.addEventListener('click', (e) => {
          if (e.detail >= 2) this.setMaximized(path)
        })
        this.cells.set(path, cell)
        this.canvas.appendChild(cell)
      }

      // Set every time: the same cell moves between arrangements, and only the
      // board carries a drag handle.
      cell.className = board ? 'images-cell images-cell-board' : 'images-cell'
      cell.style.left = `${entry.x}px`
      cell.style.top = `${entry.y}px`
      cell.style.width = `${entry.width}px`
      cell.style.height = `${entry.height}px`

      if (board && !this.draggable.has(path)) this.makeDraggable(cell, path, width)
      // The width a drag is recorded against has to be the current one, or a
      // resize would save fractions of a canvas that no longer exists.
      this.canvasWidth = width
    }

    for (const [path, cell] of this.cells) {
      if (live.has(path)) continue
      // Dropped before removal so the decoded bitmap goes now rather than
      // whenever the element is collected.
      cell.querySelector('img')?.removeAttribute('src')
      cell.remove()
      this.cells.delete(path)
      this.draggable.delete(path)
    }

    this.canvas.style.height = `${layout.height}px`
  }

  /**
   * Records a real aspect ratio and re-solves.
   *
   * Batched through the same animation frame as everything else, so a folder of
   * two hundred images produces a handful of re-layouts as they stream in
   * rather than two hundred.
   */
  private measured(path: string, img: HTMLImageElement): void {
    if (this.disposed) return
    const aspect = img.naturalWidth / img.naturalHeight
    if (!Number.isFinite(aspect) || aspect <= 0) return
    if (this.aspects.get(path) === aspect) return
    this.aspects.set(path, aspect)
    for (const item of this.items) if (item.path === path) item.aspect = aspect
    this.scheduleRender()
  }

  /**
   * Drag to move, drag the corner to resize. Board only.
   *
   * Pointer events rather than HTML drag-and-drop: this is moving something
   * within a canvas, not transferring it anywhere, and the drag API brings a
   * ghost image and a drop protocol that would both have to be suppressed.
   */
  private makeDraggable(cell: HTMLDivElement, path: string, _canvasWidth: number): void {
    this.draggable.add(path)
    const grip = document.createElement('div')
    grip.className = 'images-grip'
    cell.appendChild(grip)

    const start = (e: PointerEvent, mode: 'move' | 'resize'): void => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      const box = cell.getBoundingClientRect()
      const originX = e.clientX
      const originY = e.clientY
      const left = cell.offsetLeft
      const top = cell.offsetTop
      const startWidth = box.width
      const aspect = box.width / box.height || 1
      cell.classList.add('dragging')
      cell.setPointerCapture(e.pointerId)

      const move = (ev: PointerEvent): void => {
        if (mode === 'move') {
          cell.style.left = `${left + (ev.clientX - originX)}px`
          cell.style.top = `${Math.max(0, top + (ev.clientY - originY))}px`
        } else {
          const w = Math.max(24, startWidth + (ev.clientX - originX))
          cell.style.width = `${w}px`
          cell.style.height = `${w / aspect}px`
        }
      }

      const end = (): void => {
        cell.classList.remove('dragging')
        cell.removeEventListener('pointermove', move)
        cell.removeEventListener('pointerup', end)
        cell.removeEventListener('pointercancel', end)
        // Fractions of the canvas width — including y, deliberately: scaling
        // both axes by the same number is what preserves the arrangement's
        // shape when the pane is resized. Dividing y by height instead would
        // stretch the board vertically every time the split moved.
        //
        // Read from the field rather than captured at construction: this cell
        // outlives any one layout, so a width closed over here would be the one
        // it was first drawn at.
        const canvasWidth = this.canvasWidth
        if (canvasWidth <= 0) return
        store.setPaneImageOptions(this.paneId, {
          imageBoard: {
            ...this.board,
            [path]: {
              x: cell.offsetLeft / canvasWidth,
              y: cell.offsetTop / canvasWidth,
              w: cell.offsetWidth / canvasWidth,
            },
          },
        })
        this.renderHead()
      }

      cell.addEventListener('pointermove', move)
      cell.addEventListener('pointerup', end)
      cell.addEventListener('pointercancel', end)
    }

    cell.addEventListener('pointerdown', (e) => start(e, 'move'))
    grip.addEventListener('pointerdown', (e) => start(e, 'resize'))
  }

  // ------------------------------------------------------------------- menus

  private onCanvasMenu(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.images-cell')) return
    e.preventDefault()
    showContextMenu(e.clientX, e.clientY, [
      {
        label: 'Shuffle',
        onClick: () => {
          if (this.sort !== 'random') {
            store.setPaneImageOptions(this.paneId, { imageSort: 'random' })
            this.renderHead()
          }
          this.reseed()
        },
      },
      'separator',
      ...(Object.keys(LAYOUT_LABELS) as ImageLayout[]).map((kind) => ({
        label: LAYOUT_LABELS[kind],
        checked: this.layout === kind,
        onClick: () => {
          store.setPaneImageOptions(this.paneId, { imageLayout: kind })
          this.renderHead()
          this.scheduleRender()
        },
      })),
    ])
  }

  private showImageMenu(e: MouseEvent, path: string): void {
    if (!path) return
    const onBoard = this.layout === 'board' && !this.maximized
    const moved = Boolean(this.board[path])

    showContextMenu(e.clientX, e.clientY, [
      this.maximized === path
        ? { label: 'Close', shortcut: 'Esc', onClick: () => this.setMaximized('') }
        : { label: 'Maximize', shortcut: 'double-click', onClick: () => this.setMaximized(path) },
      { label: 'Open with the system viewer', onClick: () => this.hooks.openExternally(path) },
      'separator',
      { label: 'Show in file tree', onClick: () => this.hooks.revealInTree(path) },
      { label: 'Show in Explorer', onClick: () => void backend().revealItem(path) },
      'separator',
      { label: 'Copy path', onClick: () => void copyText(path) },
      { label: 'Copy name', onClick: () => void copyText(fileName(path)) },
      // Board-only, because there is nowhere to send an image on a layout that
      // places every one of them for you.
      ...(onBoard
        ? ([
            'separator',
            { label: 'Bring to front', onClick: () => this.bringToFront(path) },
            {
              label: 'Reset position',
              disabled: !moved,
              onClick: () => this.resetPlacement(path),
            },
          ] as MenuEntry[])
        : []),
      'separator',
      { label: 'Rename…', onClick: () => void this.rename(path) },
      { label: 'Delete…', danger: true, onClick: () => void this.remove(path) },
    ])
  }

  // ------------------------------------------------------------------ viewing

  private setMaximized(path: string): void {
    if (this.maximized === path) return
    this.maximized = path
    this.resetView()
    if (path) this.element.focus()
    this.render()
  }

  /**
   * The resampling filter, as a class on the pane root.
   *
   * One class rather than a property set on each `<img>`: it applies to the
   * gallery and the single view alike, and a class means the rule is in the
   * stylesheet with everything else rather than reapplied on every repaint.
   */
  private applyFilter(): void {
    this.element.classList.toggle('pixelated', this.filter === 'pixel')
  }

  /** Back to fitted and centred. */
  private resetView(): void {
    this.scale = 1
    this.panX = 0
    this.panY = 0
    this.applyView()
  }

  private applyView(): void {
    if (this.scale === 1 && !this.panX && !this.panY) {
      this.singleImg.style.removeProperty('transform')
      this.singleImg.classList.remove('zoomed')
      return
    }
    this.singleImg.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`
    this.singleImg.classList.add('zoomed')
  }

  private onSingleWheel(e: WheelEvent): void {
    // Ctrl+scroll is the app-wide zoom gesture and is already handled, on the
    // way down, by the wheel handler `Terminals` fits to every pane. Acting on
    // it here as well would zoom twice per notch.
    if (e.ctrlKey || e.metaKey) return
    e.preventDefault()
    // deltaMode is lines on some mice and pixels on others, so only the sign is
    // trusted. One notch is one step, whatever the driver reports.
    const next = this.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)
    this.zoomAt(next, e.clientX, e.clientY)
  }

  /**
   * Zooms so the point under the cursor stays under the cursor.
   *
   * Scaling about the centre instead is the thing that makes an image viewer
   * feel broken: you zoom toward the detail you are looking at and it slides
   * away from you.
   */
  private zoomAt(scale: number, clientX: number, clientY: number): void {
    const next = Math.max(1, Math.min(20, scale))
    if (next === this.scale) return

    // Where the cursor is relative to the image's untransformed centre, which
    // is the origin `transform` scales about.
    const box = this.singleImg.getBoundingClientRect()
    const centreX = box.left + box.width / 2
    const centreY = box.top + box.height / 2
    const ratio = next / this.scale

    this.panX = clientX - centreX - (clientX - centreX - this.panX) * ratio
    this.panY = clientY - centreY - (clientY - centreY - this.panY) * ratio
    this.scale = next

    // Fitted again means centred again: an image that fits has nowhere to be
    // panned to, and leaving it offset would strand it against an edge.
    if (this.scale === 1) {
      this.panX = 0
      this.panY = 0
    }
    this.applyView()
  }

  /** Drag to pan, but only when there is something out of view to pan to. */
  private onSinglePan(e: PointerEvent): void {
    if (e.button !== 0 || this.scale === 1) return
    e.preventDefault()
    const originX = e.clientX
    const originY = e.clientY
    const startX = this.panX
    const startY = this.panY
    const target = this.single
    target.setPointerCapture(e.pointerId)
    this.single.classList.add('panning')

    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - originX
      const dy = ev.clientY - originY
      // A few pixels of slop before it counts as a drag: a hand shakes, and a
      // press that wobbles by one pixel is still a click. Below the threshold
      // the backdrop can still be clicked to leave.
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.dragMoved = true
      this.panX = startX + dx
      this.panY = startY + dy
      this.applyView()
    }
    const end = (): void => {
      this.single.classList.remove('panning')
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', end)
      target.removeEventListener('pointercancel', end)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
  }

  /** The gallery in the order it is drawn — what the arrow keys step through. */
  private ordered(): ImageItem[] {
    return sortImages(this.items, this.sort, this.sortDesc, this.seed)
  }

  private step(delta: number): void {
    if (!this.maximized) return
    const ordered = this.ordered()
    const at = ordered.findIndex((i) => i.path === this.maximized)
    if (at < 0) return
    // Wraps, because a viewer that stops dead at the last picture makes you
    // work out which end you are at before every keypress.
    const next = ordered[(at + delta + ordered.length) % ordered.length]
    if (next) this.setMaximized(next.path)
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.maximized) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      this.setMaximized('')
      return
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      // Stopped so the app's own Alt+arrow pane navigation does not also fire.
      e.stopPropagation()
      this.step(e.key === 'ArrowRight' ? 1 : -1)
      return
    }
    // Del deletes what you are looking at — still behind the confirmation, so
    // a key pressed by accident costs a dialog rather than a photograph.
    // Deliberately not Backspace: it is the key people hit meaning "back", and
    // here that is Esc.
    if (e.key === 'Delete') {
      e.preventDefault()
      e.stopPropagation()
      void this.remove(this.maximized)
    }
  }

  // -------------------------------------------------------------------- board

  private bringToFront(path: string): void {
    // Z-order is document order among absolutely positioned siblings, so
    // "front" is simply "last". Nothing to persist: the board's saved state is
    // positions, and re-deriving a stacking order from it on every load would
    // be a second thing to keep consistent for very little.
    const cell = this.cells.get(path)
    if (cell) this.canvas.appendChild(cell)
  }

  private resetPlacement(path: string): void {
    const board = { ...this.board }
    delete board[path]
    store.setPaneImageOptions(this.paneId, { imageBoard: board })
    this.renderHead()
    this.scheduleRender()
  }

  // --------------------------------------------------------------- file edits

  private async rename(path: string): Promise<void> {
    const current = fileName(path)
    const name = await promptDialog({
      title: 'Rename image',
      body: current,
      initial: current,
      confirmLabel: 'Rename',
    })
    if (!name || name === current) return
    try {
      await backend().files.rename(path, name)
    } catch (err) {
      showToast('Rename failed', err instanceof Error ? err.message : String(err), {
        kind: 'error',
      })
      return
    }
    this.forget(path)
    refreshAllTrees()
    // Re-listed rather than patched: a rename can move a file out of the sort
    // position it held, and re-reading the folder is both simpler and correct.
    void this.load(this.shownFolder, this.recursive)
  }

  private async remove(path: string): Promise<void> {
    if (!path) return
    const ok = await confirmDialog({
      title: 'Delete image',
      body: `Move ${fileName(path)} to the ${trashName(backend().capabilities.platform)}?`,
      confirmLabel: 'Delete',
      danger: true,
    })
    // The dialog took the keyboard; give it back either way, or the arrows and
    // Del stop working the moment you use them once.
    if (this.maximized) this.element.focus()
    if (!ok) return
    try {
      await backend().files.remove(path)
    } catch (err) {
      showToast('Delete failed', err instanceof Error ? err.message : String(err), {
        kind: 'error',
      })
      return
    }

    // Dropped from what is already loaded rather than re-listing: the gallery
    // should close the gap immediately, and a recursive walk of a large tree to
    // learn what we already know would be visible as a stall.
    const wasMaximized = this.maximized === path
    const ordered = this.ordered()
    const at = ordered.findIndex((i) => i.path === path)
    this.items = this.items.filter((i) => i.path !== path)
    this.forget(path)

    if (wasMaximized) {
      // Stay in the viewer and move to what took its place, which is what you
      // want when clearing out a folder. Falling back to the previous image at
      // the end, and out of the viewer entirely when nothing is left.
      const remaining = this.ordered()
      this.maximized = remaining[Math.min(at, remaining.length - 1)]?.path ?? ''
    }
    refreshAllTrees()
    this.render()
    // Still in the viewer, still driving it from the keyboard.
    if (this.maximized) this.element.focus()
  }

  /** Drops every trace of a path that is no longer there. */
  private forget(path: string): void {
    const cell = this.cells.get(path)
    if (cell) {
      cell.querySelector('img')?.removeAttribute('src')
      cell.remove()
      this.cells.delete(path)
    }
    this.draggable.delete(path)
    this.aspects.delete(path)
    if (this.board[path]) {
      const board = { ...this.board }
      delete board[path]
      store.setPaneImageOptions(this.paneId, { imageBoard: board })
    }
  }

  dispose(): void {
    this.disposed = true
    this.observer.disconnect()
    if (this.frame) cancelAnimationFrame(this.frame)
    // Dropping the sources lets Chromium release the decoded bitmaps now rather
    // than whenever the elements are collected, which for a board of large
    // photographs is a lot of memory to leave lying around.
    for (const img of this.canvas.querySelectorAll('img')) img.removeAttribute('src')
    this.singleImg.removeAttribute('src')
    this.cells.clear()
    this.draggable.clear()
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function folderLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}
