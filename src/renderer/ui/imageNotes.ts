/**
 * Pointing at a place in a picture, and saying something about it.
 *
 * The problem is narrow and everybody has it. You paste a screenshot to show an
 * agent what is wrong, and then you have to *say* where — "the button in the
 * top right, no, the other one, above the tab bar". Words are a poor tool for
 * a coordinate, and the picture is right there.
 *
 * So: click the spot, get a numbered badge, type what you mean. When it goes
 * out, two things travel together — the picture with ①②③ burned into it, and
 * the text `Note 1: …  Note 2: …`. The model reads the note and finds the
 * badge; you never describe a location again.
 *
 * **Both halves or neither.** A capture tool will happily draw numbers on a
 * screenshot, and several do it better than this. What it cannot do is carry
 * the notes as text tied to those numbers into the same message — that pairing
 * is the whole feature, and doing it by hand is exactly where the numbers stop
 * matching the prose.
 *
 * **It burns a new file rather than editing yours.** The badges are drawn into
 * a copy beside the original in the app's own temp folder. A screenshot you
 * marked up is still the screenshot you took.
 *
 * **Nothing is sent.** The result lands on the pane's prompt like everything
 * else this app puts there — see `runbookPane.ts` for the argument.
 */
import { backend } from '../../backend'

/** One thing said about one place. */
interface Note {
  /** The badge's centre, in the image's own pixels. */
  x: number
  y: number
  /**
   * Where the badge is *pointing*, when it points at all.
   *
   * Absent is the ordinary case: the thing you mean is under the badge. Present
   * when you dragged, which is the case the badge alone cannot express — the
   * button you are talking about is smaller than the badge that would cover it,
   * so the badge stands clear and a spike runs from it to the spot.
   */
  tx?: number
  ty?: number
  note: string
}

export interface NotedImage {
  /** The copy with the badges drawn into it. */
  file: string
  /** `Note 1: …` for each, in order, ready to sit beside the path. */
  text: string
}

/**
 * How big a badge is, relative to the picture.
 *
 * A fixed pixel size is wrong in both directions: 16px is a smudge on a 5K
 * screenshot and covers half a cropped button. Proportional to the short edge,
 * with a floor so a thumbnail still gets something legible.
 */
function badgeRadius(width: number, height: number): number {
  return Math.max(13, Math.round(Math.min(width, height) * 0.022))
}

/**
 * The spike from a badge to the spot it means, as four points.
 *
 * Flameshot's shape, and worth copying exactly rather than reaching for a line
 * with an arrowhead: take the normal of the badge→target line at the badge, one
 * radius long, and mirror it through the centre. The path centre → p1 → target
 * → p2 → centre is a filled kite that tapers from the full width of the badge
 * down to a point. It needs no stroke width, no arrowhead geometry, and it
 * reads at any size — which a two-pixel line with a tip does not.
 *
 * Null when the target is inside the badge, which is their rule too: a drag
 * that never left the bubble meant a click, and drawing a stub out of the side
 * of a badge is worse than drawing nothing.
 */
function spike(note: Note, r: number): { x: number; y: number }[] | null {
  if (note.tx === undefined || note.ty === undefined) return null
  const dx = note.tx - note.x
  const dy = note.ty - note.y
  const length = Math.hypot(dx, dy)
  if (length <= r) return null
  // The normal, scaled to the badge's radius.
  const nx = (-dy / length) * r
  const ny = (dx / length) * r
  return [
    { x: note.x + nx, y: note.y + ny },
    { x: note.tx, y: note.ty },
    { x: note.x - nx, y: note.y - ny },
  ]
}

/**
 * Opens the editor on an image file. Resolves to null if it is dismissed.
 *
 * Dismissing is the ordinary outcome of changing your mind, so it costs
 * nothing and leaves no file behind — the copy is only written on the way out.
 */
export function addImageNotes(file: string): Promise<NotedImage | null> {
    return new Promise((resolve) => {
    const overlay = document.getElementById('overlay') as HTMLElement
    const wasHidden = overlay.hidden
    overlay.hidden = false

    const notes: Note[] = []
    let image: HTMLImageElement | null = null
    /** True between pressing on the picture and letting go, while a spike is being pulled. */
    let placing = false

    const panel = document.createElement('div')
    panel.className = 'image-notes-panel'

    const head = document.createElement('div')
    head.className = 'image-notes-head'
    const title = document.createElement('h2')
    title.textContent = 'Notes on the image'
    head.appendChild(title)
    const hint = document.createElement('p')
    hint.textContent =
      'Click the picture to drop a numbered badge, then write the note that goes with it. ' +
      'The numbers are drawn into a copy; the notes travel as text beside it.'
    head.appendChild(hint)
    panel.appendChild(head)

    const main = document.createElement('div')
    main.className = 'image-notes-main'

    // ------------------------------------------------------------ the picture
    const stage = document.createElement('div')
    stage.className = 'image-notes-stage'
    // The spikes live in one SVG over the picture: they are shapes rather than
    // boxes, and drawing them here means the preview uses the same geometry the
    // burn does rather than an approximation of it.
    const spikes = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    spikes.setAttribute('class', 'image-notes-spikes')
    spikes.setAttribute('preserveAspectRatio', 'none')

    const shot = document.createElement('img')
    shot.className = 'image-notes-image'
    // Loaded from a blob this page made, not over the `iaw-media` scheme every
    // other picture in this app arrives on. That scheme is a different origin,
    // and an image from another origin *taints* the canvas it is drawn onto —
    // so the export at the end fails, after every note has been placed. A
    // blob is same-origin and exports cleanly. See `Backend.readImageBytes`.
    let blobUrl: string | null = null
    void (async () => {
      const bytes = await backend()
        .readImageBytes(file)
        .catch(() => null)
      if (!bytes) {
        // Too large, unreadable, or not a picture. Said plainly rather than
        // leaving a broken image in a dialog that asks you to click on it.
        stage.classList.add('image-notes-stage--failed')
        shot.remove()
        const failed = document.createElement('p')
        failed.className = 'image-notes-empty'
        failed.textContent = 'That picture could not be opened for marking up.'
        stage.appendChild(failed)
        return
      }
      blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }))
      shot.src = blobUrl
    })()
    shot.draggable = false
    stage.appendChild(shot)
    stage.appendChild(spikes)
    main.appendChild(stage)

    // ------------------------------------------------------------- the notes
    const side = document.createElement('div')
    side.className = 'image-notes-side'
    const list = document.createElement('div')
    list.className = 'image-notes-list'
    side.appendChild(list)
    const empty = document.createElement('p')
    empty.className = 'image-notes-empty'
    empty.textContent = 'No notes yet.'
    side.appendChild(empty)
    main.appendChild(side)

    panel.appendChild(main)

    // ------------------------------------------------------------- the buttons
    const foot = document.createElement('div')
    foot.className = 'image-notes-foot'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn'
    cancel.textContent = 'Cancel'
    const attach = document.createElement('button')
    attach.type = 'button'
    attach.className = 'btn primary'
    foot.appendChild(cancel)
    foot.appendChild(attach)
    panel.appendChild(foot)

    // On the body, not inside the overlay — which is only the dim behind this,
    // and carries the settings panel's permanent click-to-dismiss listener. A
    // panel parented to it has every click inside itself bubble into that
    // listener, so the first note you place hides the editor you placed it
    // in. Every other dialog here mounts the same way, for the same reason.
    document.body.appendChild(panel)

    /** Where a click on the displayed image lands in the image's own pixels. */
    /**
     * Where the picture sits inside the stage, in the stage's own pixels.
     *
     * Everything drawn over the image is positioned through this rather than as
     * a percentage of the stage, and the difference is not cosmetic: the stage
     * is larger than the picture — it has padding, and it centres a picture
     * whose aspect ratio rarely matches its own — so a badge placed at "30% of
     * the stage" from a coordinate meaning "30% of the picture" lands tens of
     * pixels away from the thing it is pointing at. Measured, once per redraw,
     * because the answer changes with the window.
     */
    function imageBox(): { left: number; top: number; width: number; height: number } | null {
      if (!image) return null
      const box = shot.getBoundingClientRect()
      const outer = stage.getBoundingClientRect()
      if (!box.width || !box.height) return null
      return { left: box.left - outer.left, top: box.top - outer.top, width: box.width, height: box.height }
    }

    /** Puts an element's centre on a point in the picture. */
    function place(el: HTMLElement, x: number, y: number): void {
      const box = imageBox()
      if (!box || !image) return
      el.style.left = `${box.left + (x / image.naturalWidth) * box.width}px`
      el.style.top = `${box.top + (y / image.naturalHeight) * box.height}px`
    }

    function toImage(e: MouseEvent): { x: number; y: number } | null {
      if (!image) return null
      const box = shot.getBoundingClientRect()
      if (!box.width || !box.height) return null
      const x = ((e.clientX - box.left) / box.width) * image.naturalWidth
      const y = ((e.clientY - box.top) / box.height) * image.naturalHeight
      return { x, y }
    }

    /**
     * A translucent badge under the cursor, showing what the next one will be.
     *
     * The badge is centred on the point you click, so it *covers* that point —
     * on a screenshot scaled to fit this dialog it can be wider than the button
     * you were aiming at, and without a preview you only discover that after
     * committing. With one you place it deliberately, slightly off the thing,
     * and drag a spike back to it.
     */
    const ghost = document.createElement('div')
    ghost.className = 'image-notes-badge ghost'
    ghost.hidden = true
    stage.appendChild(ghost)

    stage.addEventListener('mousemove', (e) => {
      if (!image || placing) return
      const at = toImage(e)
      if (!at) {
        ghost.hidden = true
        return
      }
      ghost.hidden = false
      ghost.textContent = `${notes.length + 1}`
      place(ghost, at.x, at.y)
    })
    stage.addEventListener('mouseleave', () => {
      ghost.hidden = true
    })

    /** Redraws every spike, plus the one being dragged out right now. */
    function drawSpikes(live?: Note): void {
      if (!image) return
      const box = imageBox()
      if (!box) return
      spikes.setAttribute('viewBox', `0 0 ${image.naturalWidth} ${image.naturalHeight}`)
      spikes.style.left = `${box.left}px`
      spikes.style.top = `${box.top}px`
      spikes.style.width = `${box.width}px`
      spikes.style.height = `${box.height}px`
      spikes.replaceChildren()
      const r = badgeRadius(image.naturalWidth, image.naturalHeight)
      for (const note of live ? [...notes, live] : notes) {
        const points = spike(note, r)
        if (!points) continue
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
        poly.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '))
        poly.setAttribute('class', 'image-notes-spike')
        spikes.appendChild(poly)
      }
    }

    function draw(): void {
      // The badges over the picture are DOM, not canvas: they have to be
      // draggable and hoverable, and only the *saved* copy needs them painted.
      for (const el of [...stage.querySelectorAll('.image-notes-badge:not(.ghost)')]) el.remove()
      if (!image) return
      drawSpikes()
      notes.forEach((note, i) => {
        const badge = document.createElement('button')
        badge.type = 'button'
        badge.className = 'image-notes-badge'
        badge.textContent = `${i + 1}`
        place(badge, note.x, note.y)
        badge.title = note.note || 'Drag to move. Click to write a note.'
        badge.addEventListener('mousedown', (e) => {
          e.preventDefault()
          e.stopPropagation()
          const move = (m: MouseEvent) => {
            const at = toImage(m)
            if (!at) return
            // Rigid: the spike travels with the badge rather than stretching,
            // so moving a badge out of the way keeps it pointing at the same
            // thing — which is the only reason anybody moves one.
            if (note.tx !== undefined && note.ty !== undefined) {
              note.tx += at.x - note.x
              note.ty += at.y - note.y
            }
            note.x = at.x
            note.y = at.y
            place(badge, at.x, at.y)
            drawSpikes()
          }
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
        })
        badge.addEventListener('click', (e) => {
          e.stopPropagation()
          const input = list.querySelector<HTMLInputElement>(`[data-note="${i}"]`)
          input?.focus()
          input?.select()
        })
        stage.appendChild(badge)
      })
    }

    function renderList(): void {
      list.replaceChildren()
      empty.hidden = notes.length > 0
      attach.textContent = notes.length
        ? `Attach with ${notes.length === 1 ? '1 note' : `${notes.length} notes`}`
        : 'Attach the picture'

      notes.forEach((note, i) => {
        const row = document.createElement('div')
        row.className = 'image-notes-row'

        const number = document.createElement('span')
        number.className = 'image-notes-number'
        number.textContent = `${i + 1}`
        row.appendChild(number)

        const input = document.createElement('input')
        input.type = 'text'
        input.className = 'image-notes-note'
        input.dataset.note = `${i}`
        input.value = note.note
        input.placeholder = 'What about this spot?'
        input.addEventListener('input', () => {
          note.note = input.value
        })
        row.appendChild(input)

        const remove = document.createElement('button')
        remove.type = 'button'
        remove.className = 'image-notes-remove'
        remove.textContent = '×'
        remove.title = 'Remove this note'
        remove.addEventListener('click', () => {
          notes.splice(i, 1)
          // Renumbered, always. A picture with ① and ③ on it and a note list
          // reading 1 and 2 is worse than no numbers at all.
          renderList()
          draw()
        })
        row.appendChild(remove)

        list.appendChild(row)
      })
    }

    /**
     * Press to place, drag to point.
     *
     * Two gestures in one, and the second is what a plain badge cannot do. Let
     * go without moving and the badge sits on the thing you meant. Drag, and
     * the badge stays where you pressed while a spike follows the cursor — so
     * the badge stands clear of a small target and the tip marks it. Flameshot's
     * counter tool, and the reason it beats a bare numbered dot.
     *
     * The threshold for "did you drag" is the badge's own radius, which is the
     * honest one: inside it, the spike would be hidden under the badge anyway.
     */
    stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      const at = toImage(e)
      if (!at || !image) return
      e.preventDefault()
      placing = true
      ghost.hidden = true

      const note: Note = { x: at.x, y: at.y, note: '' }

      const move = (m: MouseEvent) => {
        const to = toImage(m)
        if (!to) return
        note.tx = to.x
        note.ty = to.y
        drawSpikes(note)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        placing = false
        // A drag that never left the badge was a click, and a target under the
        // badge is one nothing can point at.
        if (!spike(note, badgeRadius(image!.naturalWidth, image!.naturalHeight))) {
          delete note.tx
          delete note.ty
        }
        notes.push(note)
        renderList()
        draw()
        list.querySelector<HTMLInputElement>(`[data-note="${notes.length - 1}"]`)?.focus()
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })

    // Both, and the second one is not belt-and-braces. `src` is set above, and
    // this file comes off the local disk through the app's own protocol — so
    // the decode can finish before this line runs, `load` never fires, and
    // `image` stays null. Every click then lands on a picture that is plainly
    // on the screen and silently does nothing, which is the sort of bug that
    // reads as "the feature doesn't work" rather than as a race.
    const ready = () => {
      image = shot
      draw()
    }
    shot.addEventListener('load', ready)
    if (shot.complete && shot.naturalWidth) ready()

    // Everything over the picture is placed in measured pixels, so it all has
    // to be measured again when the picture changes size — which it does on
    // every window resize, the panel being sized to the window.
    const watching = new ResizeObserver(() => draw())
    watching.observe(stage)

    // ------------------------------------------------------------- finishing
    function close(result: NotedImage | null): void {
      // The blob holds the whole picture in memory for as long as a URL points
      // at it, and this dialog is opened repeatedly in a session that never
      // reloads.
      watching.disconnect()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      window.removeEventListener('keydown', onKey, true)
      panel.remove()
      overlay.hidden = wasHidden
      resolve(result)
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      }
    }
    window.addEventListener('keydown', onKey, true)

    cancel.addEventListener('click', () => close(null))

    attach.addEventListener('click', () => {
      void (async () => {
        attach.disabled = true
        try {
          close(await burn(file, shot, notes))
        } catch {
          // Writing the copy failed — a full disk, a temp folder that is not
          // writable. Better to hand back the picture the user actually has
          // than to lose the gesture entirely, so the original goes through
          // with the notes and without the badges.
          close({ file, text: noteText(notes) })
        }
      })()
    })

    renderList()
  })
}

/**
 * Draws the badges into a copy and writes it.
 *
 * At the image's own resolution, never at the size it was displayed: the point
 * of the copy is that somebody reads it later, and a 5K screenshot downscaled
 * to fit a dialog is a 5K screenshot nobody can read.
 */
async function burn(
  file: string,
  shot: HTMLImageElement,
  notes: Note[]
): Promise<NotedImage> {
  if (!notes.length) return { file, text: '' }

  const canvas = document.createElement('canvas')
  canvas.width = shot.naturalWidth
  canvas.height = shot.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')

  ctx.drawImage(shot, 0, 0)

  const r = badgeRadius(canvas.width, canvas.height)
  notes.forEach((note, i) => {
    // The spike first, so the badge is painted over its wide end and the join
    // disappears — the order flameshot uses, and the reason theirs looks like
    // one shape rather than a circle with a triangle stuck to it.
    const points = spike(note, r)
    if (points) {
      ctx.beginPath()
      ctx.moveTo(note.x, note.y)
      for (const p of points) ctx.lineTo(p.x, p.y)
      ctx.closePath()
      ctx.fillStyle = '#d29922'
      ctx.fill()
      ctx.lineWidth = Math.max(2, Math.round(r * 0.16))
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
      ctx.stroke()
    }

    // A ring of the page's own colour around a filled disc, so the badge is
    // visible on a dark screenshot and on a light one without either being
    // guessed at.
    ctx.beginPath()
    ctx.arc(note.x, note.y, r, 0, Math.PI * 2)
    ctx.fillStyle = '#d29922'
    ctx.fill()
    ctx.lineWidth = Math.max(2, Math.round(r * 0.16))
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)'
    ctx.stroke()

    ctx.fillStyle = '#101010'
    ctx.font = `600 ${Math.round(r * 1.25)}px system-ui, -apple-system, "Segoe UI", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(`${i + 1}`, note.x, note.y + r * 0.04)
  })

  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!blob) throw new Error('nothing to write')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const written = await backend().saveNotedImage(file, bytes)
  return { file: written, text: noteText(notes) }
}

/**
 * The notes, as one line to sit beside the path.
 *
 * `Note 1:` rather than `Note 1:`, which is what this said first — and which
 * is close enough to painapple's `**Note 1 on screenshot.png:**` to be worth
 * moving away from. This is the text the model actually reads, so it is the
 * place where sounding like somebody else's product matters more than a label
 * does.
 *
 * A badge with nothing written against it is still named. It means "look here"
 * — which is a thing somebody deliberately did — and a badge on the picture
 * that the text never mentions reads as a mistake.
 */
function noteText(notes: Note[]): string {
  return notes
    .map((item, i) => {
      const text = item.note.trim()
      return text ? `Note ${i + 1}: ${text.replace(/\s+$/, '')}` : `Note ${i + 1}.`
    })
    .join(' ')
}
