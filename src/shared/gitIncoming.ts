/**
 * What bringing in (pulling) would change, and whether it lands on your work.
 *
 * A fetch only downloads saves into `.git`; nothing you can see changes until
 * you bring them in. That makes the moment between the two the one where the
 * useful question can still be answered calmly: *which files will this touch,
 * and are any of them files I have changed too?* Git answers it only by trying
 * — refusing over files not saved yet, or stopping on a conflict halfway
 * through a rebase. This answers it beforehand, from the same two lists git
 * would compare.
 *
 * Pure: `main/git.ts` runs the diffs and hands their output in.
 */

export interface IncomingFile {
  repoPath: string
  /** Git's letter: A added, M changed, D deleted, T type changed. */
  change: string
}

export interface BothChanged {
  repoPath: string
  /** Changed here in a file not saved yet, in a save not sent yet, or both. */
  here: 'unsaved' | 'unsent' | 'both'
}

/** `git diff --name-status -z --no-renames` output, as files. */
export function parseNameStatus(out: string): IncomingFile[] {
  const parts = out.split('\0')
  const files: IncomingFile[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const change = parts[i].trim()
    const repoPath = parts[i + 1]
    if (!change || !repoPath) continue
    files.push({ repoPath, change: change[0] })
  }
  return files
}

/** `git diff --name-only -z` output, as paths. */
export function parseNameOnly(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

/**
 * The incoming files you have also changed. Compared case-insensitively on
 * Windows, where `Src/App.ts` and `src/app.ts` are one file on disk.
 */
export function bothChanged(
  incoming: IncomingFile[],
  unsaved: string[],
  unsent: string[],
  caseless: boolean
): BothChanged[] {
  const key = (p: string) => (caseless ? p.toLowerCase() : p)
  const notSaved = new Set(unsaved.map(key))
  const notSent = new Set(unsent.map(key))
  const out: BothChanged[] = []
  for (const file of incoming) {
    const k = key(file.repoPath)
    const a = notSaved.has(k)
    const b = notSent.has(k)
    if (a || b) out.push({ repoPath: file.repoPath, here: a && b ? 'both' : a ? 'unsaved' : 'unsent' })
  }
  return out
}

/** A short list of paths for a sentence: the first few, then "and N more". */
export function namedList(paths: string[], shown = 4): string {
  const head = paths.slice(0, shown).join(', ')
  return paths.length > shown ? `${head} and ${paths.length - shown} more` : head
}
