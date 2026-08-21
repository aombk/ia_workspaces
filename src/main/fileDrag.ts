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
 * Starts an operating-system file drag from a window.
 *
 * Returns whether it started, so the renderer knows whether the gesture was
 * taken over or whether it should carry on with its own drag. Nothing here
 * throws: a refused drag is an ordinary outcome — an empty list, a file deleted
 * between the mouse going down and this being reached — and every one of them
 * ends with the path drag happening instead, which is worse than a file and far
 * better than nothing at all.
 *
 * Multiple files go as one drag. Dropping five rows into an upload should be
 * five files arriving, not five drags, and `startDrag` takes the list directly.
 */
export async function startFileDrag(sender: WebContents, paths: string[]): Promise<boolean> {
  const files = paths.filter((file) => typeof file === 'string' && file.trim())
  if (!files.length) return false

  try {
    // The first file's icon stands for the drag. There is one cursor, and
    // Explorer does the same with a badge for the count.
    const icon = await iconFor(files[0])
    if (sender.isDestroyed()) return false
    sender.startDrag({ file: files[0], files, icon })
    return true
  } catch {
    // Electron refuses a drag whose window has lost the gesture — the mouse
    // button came up while the icon was being fetched, which is easy to do on a
    // short drag. Not an error worth surfacing; the drag simply did not happen.
    return false
  }
}
