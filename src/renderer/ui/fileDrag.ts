/**
 * Dragging a file out of the app, and reading one dropped back in.
 *
 * Both halves live here because they are two ends of one decision. A drag that
 * leaves as an operating-system file drag (`startDrag` in `main/fileDrag.ts`)
 * has no `dataTransfer` of ours on it — the OS took the gesture and discarded
 * what the renderer had set — so every drop target inside the app has to be
 * able to read a real file as well as our own private type. Two files, one
 * rule; splitting them is how a target gets missed and a drop silently stops
 * working when the setting changes.
 *
 * The three settings, and what each actually does:
 *
 * - **path** — what the app did before any of this. The location travels as
 *   text. Everything inside the app understands it and nothing outside does.
 * - **file** — always an OS drag. FileZilla, an upload box and a mail
 *   attachment all get the file. Inside the app the path is read back out of
 *   the dropped file, so the terminal still types it.
 * - **auto** — `file` for a real local file, `path` for anything else. A path
 *   inside WSL is the case that matters: it is a Windows-shaped string that no
 *   other program on this machine can open, and starting a file drag with it
 *   would hand somebody a broken attachment rather than no attachment.
 */
import { backend } from '../../backend'
import { store } from '../state'
import { isWslPath } from '../../shared/wsl'

/**
 * Our own drag type: a path, exactly as the tree knows it.
 *
 * Still set on every drag, including the ones that become OS drags — it costs
 * nothing when the OS discards it, and it is what makes a `path` drag work.
 */
export const FILE_DRAG = 'application/x-iaw-path'

/**
 * Whether this path is something another program could actually open.
 *
 * Deliberately a question about the path rather than about the file: this runs
 * during `dragstart`, where a filesystem check would be a synchronous stat in
 * the middle of a gesture. A path under a WSL distribution is the case worth
 * catching, and it is visible from the string alone.
 */
function isLocalFile(path: string): boolean {
  return Boolean(path.trim()) && !isWslPath(path)
}

/**
 * Starts the right kind of drag for these paths.
 *
 * Call from `dragstart` and nowhere else. When it returns true the OS has taken
 * the gesture and the event has already been prevented; when false, the caller's
 * own `dataTransfer` is the drag and carries the path as before.
 *
 * The path is put on the `dataTransfer` either way and before anything else,
 * because the OS drag is asked for asynchronously: if it is refused — a file
 * deleted a moment ago, a mouse button released early — the HTML5 drag is still
 * in flight and must already be carrying something.
 */
export function startDrag(e: DragEvent, paths: string[]): void {
  const first = paths[0]
  if (!first) return

  e.dataTransfer?.setData('text/plain', paths.map(quotePath).join(' '))
  // One path in this one, always. Every reader of it opens a single file, and a
  // space-joined list would be read as one absurd path.
  e.dataTransfer?.setData(FILE_DRAG, first)
  // `copyMove` rather than `copy`: the file tree now accepts its own rows as a
  // move into a folder, and a target may only set a `dropEffect` the source
  // allowed — asking for `move` against a copy-only drag cancels the drop
  // outright. Every existing target sets its own effect, so none of them
  // changes behaviour.
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copyMove'

  const mode = store.settings.fileDrag ?? 'auto'
  if (mode === 'path') return
  if (mode === 'auto' && !paths.every(isLocalFile)) return

  // Prevented before the call rather than after it: `startDrag` is a round trip
  // to the main process, and Chromium has already begun its own drag by the
  // time the answer comes back. Prevent first, and the OS drag is the only one
  // that ever existed.
  e.preventDefault()
  void backend().startFileDrag(paths)
}

/**
 * A path ready to be one argument at a prompt.
 *
 * The character set is the shell's, not just whitespace: `&`, `(`, `^` and the
 * rest are all ordinary in a folder name and all mean something to cmd. Moved
 * here from the file tree when the second pane needed it.
 */
export function quotePath(value: string): string {
  return /[\s&()[\]{}^=;!'+,`~]/.test(value) ? `"${value}"` : value
}

/**
 * Whether a drag carries a path this app could act on.
 *
 * `Files` covers both an OS drag started by us and one started by Explorer,
 * which is the right answer for both: a file dragged in from a file manager has
 * always been something the editor and compare panes could open, and now the
 * app's own drags look exactly like one.
 */
export function hasFilePath(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return types.includes(FILE_DRAG) || types.includes('Files')
}

/**
 * The path behind a drop, whichever kind of drag brought it.
 *
 * Our own type first: it is exact, and it is the only one present when the
 * setting is `path`. Then the dropped file, which is what an OS drag leaves —
 * `pathForFile` is the host's business because Electron stopped putting a
 * `path` on `File` and it is a preload-only call now. Empty string where
 * neither can answer, which every caller already treats as "not for me".
 */
export function pathFromDrop(e: DragEvent): string {
  const internal = e.dataTransfer?.getData(FILE_DRAG)
  if (internal) return internal
  const file = e.dataTransfer?.files?.[0]
  return file ? backend().pathForFile(file) : ''
}

/** Every path in a drop, for the targets that can take more than one. */
export function pathsFromDrop(e: DragEvent): string[] {
  const files = e.dataTransfer?.files
  if (files?.length) {
    const out: string[] = []
    for (const file of files) {
      const path = backend().pathForFile(file)
      if (path) out.push(path)
    }
    if (out.length) return out
  }
  const single = pathFromDrop(e)
  return single ? [single] : []
}
