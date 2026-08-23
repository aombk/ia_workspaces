/**
 * Writing a file so that losing power does not lose the file.
 *
 * The obvious version of this is wrong in a way that looks right, and the app
 * shipped the wrong version twice. Both are worth naming, because each one
 * reads as correct until a machine actually stops.
 *
 * **Writing straight over the live file** loses everything on a crash: there is
 * a moment where the old contents are gone and the new ones are not there yet.
 *
 * **Writing to a temporary file and renaming** fixes that for a *process*
 * dying, and not at all for a machine stopping. `writeFileSync` returns when
 * the bytes reach the operating system's cache; the rename is a metadata change
 * the filesystem journals on its own schedule. The rename can therefore land
 * while the data blocks have never been written, publishing a file with the
 * right name and the right length and no contents — which reads back as NUL
 * bytes. That is not theoretical: it is how this app lost every workspace on a
 * real machine, from code whose comment said it could not happen.
 *
 * So: write to a temporary file, **flush it to the disk**, keep the version
 * being replaced, and only then rename. The flush is the part that makes the
 * rename safe, and the copy is what covers everything the flush cannot — a disk
 * that lies about flushing, a file truncated by something else, a bug in a
 * future version of this app writing something unparseable.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'

export interface DurableOptions {
  /**
   * Keep the version being replaced at `<file>.bak`.
   *
   * On for anything a person would miss. Off for files the app can rebuild from
   * something else, where a second copy is disk and confusion for no gain.
   */
  backup?: boolean
}

/**
 * Writes `text` to `file` so that a crash leaves either the old file or the new
 * one, never a half of either.
 *
 * Throws only if the real write fails. A backup that cannot be written is not
 * allowed to fail the save it was meant to protect — the fallback copy is worth
 * less than the thing it is a copy of.
 */
export function writeDurable(file: string, text: string, options: DurableOptions = {}): void {
  const tmp = `${file}.tmp`

  const handle = openSync(tmp, 'w')
  try {
    writeFileSync(handle, text, 'utf8')
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }

  if (options.backup) {
    try {
      // Before the rename, not after: there must be no moment with neither a
      // good live file nor a good copy of one.
      if (existsSync(file)) copyFileSync(file, `${file}.bak`)
    } catch {
      /* the save itself still matters more */
    }
  }

  renameSync(tmp, file)
}

/**
 * Reads a file that `writeDurable` wrote, falling back to its backup.
 *
 * `parse` is given the text and returns the value, or throws. Anything it
 * throws on is treated as damage — as is a file of nothing at all, which is
 * what a power cut leaves and which must never be mistaken for a document that
 * legitimately holds nothing. That distinction is the difference between
 * recovering from a crash and completing one.
 *
 * `onRecovered` fires when the backup was used, so a caller can put the good
 * contents back and say so.
 */
export function readDurable<T>(
  file: string,
  parse: (text: string) => T,
  onRecovered?: () => void
): T | null {
  const read = (path: string): T | null => {
    try {
      if (!existsSync(path)) return null
      const raw = readFileSync(path, 'utf8')
      if (!raw.trim()) return null
      return parse(raw)
    } catch {
      return null
    }
  }

  const live = read(file)
  if (live !== null) return live

  const backup = read(`${file}.bak`)
  if (backup !== null) onRecovered?.()
  return backup
}
