/**
 * What a pane printed, kept after the pane is gone.
 *
 * Closing a pane used to delete its scrollback outright, which is right for the
 * buffer — it exists to restore a pane, and a pane that will never reopen has
 * nothing to restore — and wrong for the *content*. "What did that build say
 * before I closed it" is a question people ask hours later, and until now the
 * honest answer was that the app had deliberately thrown it away.
 *
 * The design is deliberately unambitious, because everything needed to read
 * these already exists. A transcript is a plain text file in a folder:
 *
 * - **reading one** is the editor pane, which already opens text files and
 *   already has find,
 * - **searching all of them** is the search pane, which already does literal
 *   search beneath a folder and works outside a repository,
 * - **finding one** is a picker over an index.
 *
 * So there is no new pane kind here and no search index — only files, written
 * at the one moment the content would otherwise be lost, and pruned so the
 * folder cannot grow without end.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { VaultEntry } from '../shared/types'

/** Transcripts kept, newest first. Older ones are deleted as new ones arrive. */
const MAX_ENTRIES = 200
/** Nothing below this is worth a file — a pane opened and closed by accident. */
const MIN_BYTES = 200

export class SessionVault {
  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A read-only data directory costs the feature, not the app.
    }
  }

  /**
   * Writes a pane's transcript, if there is enough of one to be worth keeping.
   *
   * The text is already escape-stripped by the caller, because what is wanted
   * here is readable prose rather than a byte-exact replay — the opposite of
   * what the restore path needs from the same buffer. A full-screen program
   * gives every frame it ever drew rather than the last one, which is the
   * honest limit of reading a terminal as text and is stated in the header
   * written into each file.
   */
  archive(text: string, meta: { label: string; cwd: string; workspace: string }): string | null {
    const body = text.trimEnd()
    if (body.length < MIN_BYTES) return null

    const at = new Date()
    const stamp =
      `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
      `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
    const file = path.join(this.dir, `${stamp}-${slug(meta.label || meta.cwd)}.txt`)

    const header = [
      `# ${meta.label || '(untitled pane)'}`,
      `# workspace: ${meta.workspace}`,
      `# folder:    ${meta.cwd}`,
      `# closed:    ${at.toISOString()}`,
      '#',
      '# Escape sequences are stripped, so a full-screen program appears as every',
      '# frame it drew rather than the one that was on screen.',
      '',
      '',
    ].join('\n')

    try {
      writeFileSync(file, header + body + '\n', 'utf8')
    } catch {
      return null
    }
    this.prune()
    return file
  }

  /** Newest first. Cheap: names and stats, never the contents. */
  list(limit = MAX_ENTRIES): VaultEntry[] {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.txt'))
    } catch {
      return []
    }

    const out: VaultEntry[] = []
    for (const name of names) {
      const file = path.join(this.dir, name)
      try {
        const stat = statSync(file)
        out.push({
          path: file,
          label: this.labelOf(file) || name.replace(/\.txt$/, ''),
          at: stat.mtimeMs,
          bytes: stat.size,
        })
      } catch {
        /* vanished between the listing and the stat */
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit))
  }

  /**
   * The title line, read from the file rather than kept in an index.
   *
   * An index is a second thing to keep in step with a folder anyone can delete
   * from, and the answer is in the first line of each file. Only the head is
   * read, so a large transcript costs the same as a small one.
   */
  private labelOf(file: string): string {
    try {
      const head = readFileSync(file, 'utf8').slice(0, 200)
      const first = head.split('\n', 1)[0] ?? ''
      return first.startsWith('# ') ? first.slice(2).trim() : ''
    } catch {
      return ''
    }
  }

  /** Keeps the newest `MAX_ENTRIES` and deletes the rest. */
  private prune(): void {
    let files: { file: string; at: number }[]
    try {
      files = readdirSync(this.dir)
        .filter((n) => n.endsWith('.txt'))
        .map((n) => {
          const file = path.join(this.dir, n)
          return { file, at: statSync(file).mtimeMs }
        })
    } catch {
      return
    }
    if (files.length <= MAX_ENTRIES) return
    files.sort((a, b) => b.at - a.at)
    for (const stale of files.slice(MAX_ENTRIES)) {
      try {
        unlinkSync(stale.file)
      } catch {
        /* best effort */
      }
    }
  }

  get folder(): string {
    return this.dir
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** A filename component: readable, and safe on every platform we ship to. */
function slug(text: string): string {
  return (
    text
      .replace(/[\\/]/g, '-')
      .replace(/[<>:"|?*\x00-\x1f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'pane'
  )
}
