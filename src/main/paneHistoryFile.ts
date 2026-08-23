/**
 * One file per pane, holding what that pane's Up arrow should walk.
 *
 * The shells that bind the arrows themselves — see `shared/historyBinding.ts` —
 * run inside their own process and cannot ask the app anything. A file is the
 * whole interface between the two: the app writes the list, the key handler in
 * `resources/shell-integration/*` reads it. No socket, no protocol, nothing to
 * keep alive, and a handler that runs while the app is closing simply reads a
 * list that has stopped changing.
 *
 * **Newest first, one command per line.** The handler indexes into it and does
 * no parsing, because parsing is the part of a shell script most likely to be
 * wrong and hardest to test. Anything with a newline in it never gets here —
 * `133;E` drops multi-line submissions at the source.
 *
 * The file is rewritten in full whenever the scope changes or the list grows.
 * It is a few kilobytes and rewriting is atomic-ish through a rename, which
 * matters because the handler may read it between our write and our finish.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The folder inside the app's data directory. Named in `IAW_HISTORY_DIR`. */
export const HISTORY_DIR_NAME = 'pane-history'

/**
 * How many lines a pane's file holds.
 *
 * The store itself caps at 500. This is smaller because the handler reads the
 * whole file on the first arrow press of a walk, and a shell script reading two
 * hundred lines is instant while one reading five hundred is still instant —
 * but there is no reason to write more than anybody walks through.
 */
const MAX_LINES = 200

export function historyDir(dataDir: string): string {
  return path.join(dataDir, HISTORY_DIR_NAME)
}

/**
 * Writes the list this pane's arrows should walk.
 *
 * Through a temporary file and a rename, so a handler reading at the wrong
 * moment sees the old list or the new one and never half of either. A failure
 * is swallowed: the worst case is an arrow key that recalls something slightly
 * stale, which is not worth an error path in the renderer.
 */
export async function writePaneHistory(
  dataDir: string,
  paneId: string,
  commands: readonly string[]
): Promise<void> {
  if (!safeId(paneId)) return
  const dir = historyDir(dataDir)
  const file = path.join(dir, `${paneId}.txt`)
  const temp = `${file}.tmp`

  const body = commands
    .filter((line) => line && !line.includes('\n') && !line.includes('\r'))
    .slice(0, MAX_LINES)
    .join('\n')

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(temp, body, 'utf8')
    await rename(temp, file)
  } catch {
    // An unwritable data folder, or a rename losing a race with another write
    // of the same file. Either way the handler keeps whatever it last read.
  }
}

/** Removes a closed pane's file, so the folder does not grow forever. */
export async function forgetPaneHistory(dataDir: string, paneId: string): Promise<void> {
  if (!safeId(paneId)) return
  try {
    await unlink(path.join(historyDir(dataDir), `${paneId}.txt`))
  } catch {
    // Never written, or already gone.
  }
}

/**
 * Pane ids are ours and are uuids, but this string becomes a path.
 *
 * Checked rather than trusted because it arrives over IPC, and the one thing a
 * renderer must never be able to do is name a file outside this folder.
 */
function safeId(paneId: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(paneId)
}
