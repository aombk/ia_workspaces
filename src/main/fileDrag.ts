/**
 * Handing a file to whatever the rest of the desktop is.
 *
 * Dragging a row out of the file tree used to put a *path* on the drag, which
 * every part of this app understands and nothing else does: FileZilla wanted a
 * file to upload, an email wanted an attachment, and each of them got a line of
 * text saying where one was. `webContents.startDrag` is the other kind of drag —
 * the one Explorer and Finder start — and it is the only way to say "here is
 * the file itself" to a program that has never heard of us.
 *
 * The cost is that it is not an addition. Calling this replaces the HTML5 drag
 * outright: the renderer's `dataTransfer` is discarded, the OS takes the
 * gesture, and `dragstart` must `preventDefault` before calling. Which is why
 * the app's own drop targets had to learn to read a dropped file rather than a
 * dropped string — see `fileDrag.ts` in the renderer for that half.
 *
 * **The icon is not optional.** Electron rejects a drag with an empty one, and
 * a drag with a bad one is a drag with a black square under the cursor for as
 * long as it lasts. `app.getFileIcon` asks the operating system for the icon it
 * would use in a file manager, which is both correct and free — and the
 * fallback exists because it answers with nothing for a path that has just been
 * deleted, and a missing icon must not cost the drag.
 */
import { extname } from 'node:path'
import { app, nativeImage, type NativeImage, type WebContents } from 'electron'

/**
 * A last-resort cursor image: one transparent pixel.
 *
 * Deliberately not a drawn placeholder. This is only reached when the system
 * declined to describe the file, which is rare and usually means the file is
 * going away — and an honest nothing under the cursor beats a generic document
 * icon that claims the drag knows what it is carrying.
 */
const BLANK = nativeImage.createFromDataURL(
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)

/**
 * The system's own icon for a file, or a blank one.
 *
 * `getFileIcon` throws for a path that no longer exists rather than answering
 * with a default, so this can never be allowed to reject: the drag is a gesture
 * already in progress, and failing it leaves the user holding a mouse button
 * with nothing happening and no way to find out why.
 */
async function iconFor(file: string): Promise<NativeImage> {
  try {
    const icon = await app.getFileIcon(file, { size: 'normal' })
    return icon.isEmpty() ? BLANK : icon
  } catch {
    return BLANK
  }
}

/**
 * Icons already fetched, by what decides a file's icon: its extension, or the
 * file itself for the kinds that carry their own (a program, a shortcut).
 */
const icons = new Map<string, NativeImage>()

function iconKey(file: string): string {
  const ext = extname(file).toLowerCase()
  return ext === '.exe' || ext === '.lnk' || ext === '.ico' || ext === '.url' ? file.toLowerCase() : ext || '<none>'
}

/**
 * Fetches a file's icon ahead of a drag, so the drag does not have to wait.
 *
 * Called when the mouse goes down on a row: the drag, if one comes, starts a
 * few pixels of movement later, and by then this has usually answered.
 */
export function prepareFileDrag(file: string): void {
  if (typeof file !== 'string' || !file.trim()) return
  const key = iconKey(file)
  if (icons.has(key)) return
  void iconFor(file).then((icon) => {
    if (icon !== BLANK) icons.set(key, icon)
  })
}

/**
 * Starts an operating-system file drag from a window.
 *
 * Returns whether it started, so the renderer knows whether the gesture was
 * taken over or whether it should carry on with its own drag. Nothing here
 * throws: a refused drag is an ordinary outcome — an empty list, a file deleted
 * between the mouse going down and this being reached.
 *
 * **Synchronous on purpose.** This used to fetch the icon first and start the
 * drag after, and on Windows that lost most drags outright: the OS drag has to
 * begin while the button is still down in the gesture that started it, the
 * icon lookup takes long enough for an ordinary quick drag to have ended, and
 * by then the renderer had already cancelled its own drag — so nothing moved
 * and nothing said why. Now the drag starts at once with whatever icon is in
 * hand (fetched on mousedown by `prepareFileDrag`, or the blank one), and the
 * real icon is fetched for next time.
 *
 * Multiple files go as one drag. Dropping five rows into an upload should be
 * five files arriving, not five drags, and `startDrag` takes the list directly.
 */
export function startFileDrag(sender: WebContents, paths: string[]): boolean {
  const files = paths.filter((file) => typeof file === 'string' && file.trim())
  if (!files.length || sender.isDestroyed()) return false

  // The first file's icon stands for the drag. There is one cursor, and
  // Explorer does the same with a badge for the count.
  const icon = icons.get(iconKey(files[0])) ?? BLANK
  try {
    sender.startDrag({ file: files[0], files, icon })
    return true
  } catch {
    return false
  } finally {
    prepareFileDrag(files[0])
  }
}
