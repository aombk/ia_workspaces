/**
 * Where an untitled pane's text lives until it has a name.
 *
 * The problem, stated plainly: an editor tab you have not saved has nowhere to
 * write. `editorPane`'s own `save` says so — `if (!this.path) return false` —
 * and it is right to, because the alternative it was avoiding is worse. An
 * autosave that stops mid-sentence to ask where to put a file is a worse
 * interruption than not saving at all.
 *
 * The instinct is to give the pane a default filename, and that instinct is
 * what `NOTES.md` and `notes.canvas` were. It does keep the text safe, and it
 * costs something that is easy to miss: a file nobody chose, in the project
 * folder, in `git status`, in the tree, named by the app rather than by the
 * person whose work it is. `temp.md` would be worse still — a name that tells
 * the user the file is disposable while the app treats it as the permanent home
 * of their writing.
 *
 * So the text goes somewhere that is not the user's project. One file per pane
 * in the app's own data directory, exactly as `paneHistoryFile.ts` keeps each
 * pane's command history — same shape, same reasoning, same lifetime. The pane
 * comes back after a restart with its text and still no name, and the name is
 * chosen at the one moment it can be chosen well: when the writer knows what
 * they have written.
 *
 * The files are readable markdown and JSON under a plain `<paneId>` name rather
 * than anything encoded, which is deliberate. If the app ever fails to give a
 * buffer back, the recovery should be a file manager and not a support request.
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The folder inside the app's data directory. */
export const SCRATCH_DIR_NAME = 'untitled'

export function scratchDir(dataDir: string): string {
  return path.join(dataDir, SCRATCH_DIR_NAME)
}

/**
 * A pane id is ours and is not a path, but it arrives here over IPC and this
 * builds a filename out of it — so it is checked rather than trusted. A
 * compromised renderer asking for `../../config` should get nothing, not a
 * traversal.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

function fileFor(dataDir: string, paneId: string, ext: string): string | null {
  if (!SAFE_ID.test(paneId)) return null
  if (ext !== 'md' && ext !== 'canvas') return null
  return path.join(scratchDir(dataDir), `${paneId}.${ext}`)
}

/** The text a pane was holding, or null when it was never holding any. */
export async function readScratch(
  dataDir: string,
  paneId: string,
  ext: string
): Promise<string | null> {
  const file = fileFor(dataDir, paneId, ext)
  if (!file) return null
  try {
    return await readFile(file, 'utf8')
  } catch {
    // No file is the ordinary case — most panes are not untitled — and is not
    // an error worth propagating to a renderer that would only ignore it.
    return null
  }
}

/**
 * Writes through a rename, like the history file beside it.
 *
 * The window this closes is small and the cost of landing in it is the whole
 * point of the feature: a crash *during* the write that leaves a truncated
 * buffer would be the one moment this file exists to protect against.
 */
export async function writeScratch(
  dataDir: string,
  paneId: string,
  ext: string,
  text: string
): Promise<void> {
  const file = fileFor(dataDir, paneId, ext)
  if (!file) return
  await mkdir(scratchDir(dataDir), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/** Called when the pane is saved under a real name, or closed for good. */
export async function dropScratch(dataDir: string, paneId: string, ext: string): Promise<void> {
  const file = fileFor(dataDir, paneId, ext)
  if (!file) return
  try {
    await unlink(file)
  } catch {
    // Already gone, which is the state we wanted it in.
  }
}

/**
 * How long an untitled buffer outlives the pane that wrote it.
 *
 * Panes drop their own file when they are saved under a real name or closed, so
 * this only ever catches what a crash left behind. Thirty days rather than
 * something tidier because the thing being weighed is a few kilobytes of text
 * against somebody's unsaved writing, and those are not close.
 */
const ORPHAN_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * Removes buffers nothing has touched in a month.
 *
 * By age rather than by which panes still exist, and that is a deliberate
 * simplification: the main process holds the workspace document as opaque JSON
 * and has no business learning its schema just to enumerate pane ids. A
 * timestamp answers the same question well enough, and answers it without
 * anybody having to pass a list around.
 *
 * Conservative on every failure. Losing an untitled buffer is the exact harm
 * this module exists to prevent, so a `readdir` that fails removes nothing, and
 * a file whose age cannot be read is left alone.
 */
export async function sweepScratch(dataDir: string, now = Date.now()): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(scratchDir(dataDir))
  } catch {
    return
  }
  for (const entry of entries) {
    // Anything that is not one of ours — including a `.tmp` left by a write
    // that died mid-rename — is left where it is rather than guessed at.
    if (!/\.(md|canvas)$/.test(entry)) continue
    const full = path.join(scratchDir(dataDir), entry)
    try {
      const info = await stat(full)
      if (now - info.mtimeMs <= ORPHAN_MAX_AGE_MS) continue
      await unlink(full)
    } catch {
      // Gone already, locked, or unreadable. Not ours to insist on.
    }
  }
}
