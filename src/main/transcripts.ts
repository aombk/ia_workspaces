/**
 * Claude Code's own transcripts, found and read a piece at a time.
 *
 * Extracted when a second feature needed the same two things `tokenUsage.ts`
 * had grown for itself: *where the conversations are*, and *what has been
 * appended to one since we last looked*. Both are properties of somebody
 * else's file format rather than of what we do with it, and a second private
 * copy of either is a copy that goes out of step the first time that format
 * moves.
 *
 * Nothing here knows what a line means. It hands over whole lines and
 * remembers a byte offset; deciding whether a line is a token count, a prompt
 * or neither belongs to the module that asked.
 *
 * **Incremental because the files are large and append-only.** A transcript is
 * written to for as long as its conversation lasts and never rewritten, so the
 * cheap read is the one that starts where the last one stopped. Lines are
 * streamed rather than slurped — one of these is 23 MB on the machine this was
 * written on, and holding it in memory to count its lines is not a thing to do
 * on a laptop that is already short of it.
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Where Claude Code keeps its transcripts, on every platform it runs on. */
export function transcriptsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** Every `*.jsonl` one level under `projects/`, which is where they all live. */
export async function transcriptFiles(root: string): Promise<string[]> {
  const out: string[] = []
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const inside = path.join(root, dir.name)
    let entries
    try {
      entries = await readdir(inside, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(inside, entry.name))
    }
  }
  return out
}

/**
 * How much of one transcript has already been read.
 *
 * Size *and* mtime, because a file rewritten to the same length is a file to
 * read again — and `offset` counts whole lines only, so a half-written last
 * line is left for next time rather than parsed as truncated JSON.
 */
export interface Scanned {
  size: number
  mtimeMs: number
  offset: number
}

export interface Appended {
  scanned: Scanned
  /**
   * Whether the file was read from the beginning rather than continued.
   *
   * A transcript that has *shrunk* was rewritten, not appended to, so the
   * offsets we held describe a file that no longer exists. The caller is told
   * because only it knows what it accumulated from the old one, and adding a
   * second pass on top of the first would double every figure derived from it.
   */
  restarted: boolean
}

/**
 * Reads whatever has been appended to one transcript since `known`.
 *
 * Returns null when nothing has changed, so an idle poll does no work and
 * writes no cache.
 *
 * `onRestart` fires before the first line of a file that is being read from the
 * beginning, which is the only moment a caller can still throw away what it
 * accumulated from the version that no longer exists. The same fact is in the
 * result, for callers that would rather check afterwards.
 */
export async function readAppended(
  file: string,
  known: Scanned | undefined,
  onLine: (line: string) => void,
  onRestart?: () => void
): Promise<Appended | null> {
  const info = await stat(file)
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return null

  const restarted = !known || info.size < known.offset
  if (restarted) onRestart?.()
  let consumed = restarted ? 0 : known!.offset

  let leftover = ''
  const stream = createReadStream(file, { start: consumed, encoding: 'utf8' })
  for await (const chunk of stream) {
    const text = leftover + (chunk as string)
    const lines = text.split('\n')
    // The last piece may be half a line the writer has not finished. It is held
    // back, and its bytes are not counted as read.
    leftover = lines.pop() ?? ''
    for (const line of lines) {
      consumed += Buffer.byteLength(line, 'utf8') + 1
      if (line) onLine(line)
    }
  }

  return { scanned: { size: info.size, mtimeMs: info.mtimeMs, offset: consumed }, restarted }
}

/** The conversation a transcript *is*, by its name rather than by its contents. */
export function sessionOf(file: string): string {
  return path.basename(file, '.jsonl')
}
