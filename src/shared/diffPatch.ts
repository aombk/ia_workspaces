/**
 * Cutting a patch down to the part you actually meant.
 *
 * Picking a whole file is the easy half of "what goes in this save", and it is
 * the half that was already here. The other half is the one people need on the
 * day they have fixed a bug and also left a stray `console.log` three lines
 * further down: those two changes are one file, and a pane that can only offer
 * the file offers a choice between saving the mess and not saving the fix.
 *
 * Git's own answer is `git add -p`, which is a question-and-answer session in a
 * terminal with sixteen single-letter replies. The answer here is the one every
 * graphical client landed on independently: show the patch, let the block or the
 * line be ticked, and hand git a *smaller patch* to apply. That last part is the
 * whole trick and it is worth being explicit about, because it is why this file
 * is arithmetic rather than file editing —
 *
 *   git apply --cached <patch>          puts those lines into what is picked
 *   git apply --cached -R <patch>       takes them back out
 *
 * Neither touches a single file on disk. The worst outcome of a bug in here is
 * that git rejects the patch and nothing happens at all, which is the property
 * that makes line-picking safe enough for a pane whose rule is that nothing can
 * destroy work.
 *
 * No dependency on the DOM or on node: this is text in and text out, so the
 * tests exercise the real thing rather than a copy of it.
 */

/** What one line of a hunk is. The prefix character, decoded once. */
export type PatchLineKind = 'ctx' | 'add' | 'del' | 'nonewline'

export interface PatchLine {
  kind: PatchLineKind
  /** The line as git wrote it, prefix character and all. */
  raw: string
  /** The text without the prefix, for display. */
  text: string
  /**
   * Position within the whole file patch, counting every hunk line from zero.
   *
   * The identity a selection is held by. Deliberately not "line number in the
   * file", which is two different numbers for an added and a removed line and
   * cannot name a `-` and a `+` on the same screen row apart.
   */
  index: number
}

export interface Hunk {
  /** The `@@ -a,b +c,d @@` line, section heading and all. */
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: PatchLine[]
  /** Where this hunk sits in its file's list, for a stable key. */
  index: number
}

export interface FilePatch {
  /**
   * Everything before the first `@@`: `diff --git`, `index`, mode changes, and
   * the `---`/`+++` pair.
   *
   * Kept verbatim and replayed verbatim. It carries the modes and the blob ids
   * git needs to find what the patch applies to, and rebuilding it from the
   * paths would drop a mode change and silently mark a file non-executable.
   */
  header: string[]
  /** The path as the `+++` line gives it, without the `b/`. */
  path: string
  /** The `--- a/` path, which differs for a rename. */
  oldPath: string
  hunks: Hunk[]
  /**
   * True for a patch with no hunks at all — a pure rename, a mode change, or a
   * binary file. There is nothing in it to tick, and a caller that offers line
   * picking on one is offering a choice it cannot honour.
   */
  binaryOrEmpty: boolean
}

/**
 * Splits `git diff` output into files and hunks.
 *
 * Written against what git actually emits rather than against the unified-diff
 * standard, because git emits more than the standard: `diff --git` preamble,
 * `index` lines, `old mode`/`new mode`, `rename from`/`rename to`,
 * `Binary files … differ`, and `\ No newline at end of file` which is a line of
 * the hunk that is not a line of the file.
 */
export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = []
  if (!text.trim()) return files

  const lines = text.split('\n')
  // A patch ends with a newline, so the split ends with an empty string — and
  // an empty string is read below as a blank context line. Left in, it becomes
  // a phantom line on the end of the last hunk: the counts in the `@@` header
  // come out one too high, and git rejects the patch for describing a line that
  // is not there. Dropped once, here, rather than guarded at every use.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  let file: FilePatch | null = null
  let hunk: Hunk | null = null
  let counter = 0

  const closeHunk = () => {
    if (file && hunk) file.hunks.push(hunk)
    hunk = null
  }
  const closeFile = () => {
    closeHunk()
    if (file) {
      file.binaryOrEmpty = file.hunks.length === 0
      files.push(file)
    }
    file = null
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      counter = 0
      file = { header: [line], path: '', oldPath: '', hunks: [], binaryOrEmpty: false }
      continue
    }
    if (!file) continue

    if (line.startsWith('@@')) {
      closeHunk()
      const parsed = parseHunkHeader(line)
      if (!parsed) continue
      hunk = { ...parsed, header: line, lines: [], index: file.hunks.length }
      continue
    }

    if (!hunk) {
      // Still in the preamble. The two path lines are read as they go past
      // rather than from `diff --git`, whose single line has to be split on a
      // space that may appear inside either path.
      if (line.startsWith('--- ')) file.oldPath = stripPrefix(line.slice(4))
      else if (line.startsWith('+++ ')) file.path = stripPrefix(line.slice(4))
      file.header.push(line)
      continue
    }

    const kind = lineKind(line)
    if (kind === null) {
      // Anything unrecognised ends the hunk — in practice the blank line git
      // puts before the next `diff --git`, or the end of the patch.
      closeHunk()
      continue
    }
    hunk.lines.push({ kind, raw: line, text: kind === 'nonewline' ? line : line.slice(1), index: counter++ })
  }
  closeFile()

  // A patch whose `+++` line never arrived — a pure mode change — still names
  // its file in the `diff --git` line, and a file with no name at all cannot be
  // shown against anything.
  for (const f of files) {
    if (!f.path) f.path = f.oldPath || pathFromGitLine(f.header[0])
    if (!f.oldPath) f.oldPath = f.path
  }
  return files
}

function lineKind(line: string): PatchLineKind | null {
  if (line.startsWith('\\')) return 'nonewline'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  // A context line is a space and then the text. `''` is accepted as well
  // because a blank context line is a lone space, and anything that has passed
  // the patch through whitespace-trimming — a chat window, a bug report, an
  // editor that tidies on save — turns it into nothing at all. Reading that as
  // "not a hunk line" would truncate the hunk at the first blank line.
  if (line.startsWith(' ') || line === '') return 'ctx'
  return null
}

function stripPrefix(path: string): string {
  const clean = path.replace(/\t.*$/, '').trim()
  if (clean === '/dev/null') return clean
  return clean.replace(/^[ab]\//, '')
}

function pathFromGitLine(line: string): string {
  const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  return m ? m[2] : ''
}

interface HunkRange {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

/** `@@ -12,7 +12,9 @@ some function()` — the counts are optional and mean 1. */
export function parseHunkHeader(line: string): HunkRange | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  }
}

/** Which way a built patch is going to be applied, which changes what it must contain. */
export type PatchDirection = 'pick' | 'unpick'

/**
 * Builds the patch for exactly the ticked lines.
 *
 * The rule is short and every graphical git client has it, and it is not
 * obvious enough to leave unstated. A line the user did not tick still has to
 * appear in the patch — as *context* — whenever it is already present in the
 * file the patch is being applied against, because a patch whose context does
 * not match is a patch git rejects. Which lines those are depends on the
 * direction:
 *
 * - **pick** (`git apply --cached`) applies against what is picked, which
 *   currently matches the last save. So an unticked `-` line is still in that
 *   file and becomes context; an unticked `+` line is not there yet and is
 *   dropped entirely.
 * - **unpick** (`git apply --cached -R`) reverses the patch against what is
 *   picked, which already contains the changes. So it is the other way round:
 *   an unticked `+` line is there and becomes context, and an unticked `-` line
 *   is already gone and is dropped.
 *
 * Get that backwards and git says "patch does not apply" and changes nothing,
 * which is a bad afternoon and not a lost file.
 *
 * Returns null when the selection contains no actual change — every ticked line
 * was context — because handing git an empty patch is an error message about
 * nothing.
 */
export function buildPatch(
  file: FilePatch,
  hunks: readonly Hunk[],
  selected: ReadonlySet<number>,
  direction: PatchDirection
): string | null {
  const out: string[] = [...file.header]
  let changes = 0

  for (const hunk of hunks) {
    const body: string[] = []
    let oldCount = 0
    let newCount = 0

    for (let i = 0; i < hunk.lines.length; i++) {
      const line = hunk.lines[i]

      if (line.kind === 'nonewline') {
        // Belongs to the line above. If that one survived, so does this.
        if (body.length) body.push(line.raw)
        continue
      }

      if (line.kind === 'ctx') {
        body.push(line.raw === '' ? ' ' : line.raw)
        oldCount++
        newCount++
        continue
      }

      const ticked = selected.has(line.index)
      if (ticked) {
        body.push(line.raw)
        if (line.kind === 'add') newCount++
        else oldCount++
        changes++
        continue
      }

      // Unticked. Present in the target file, or not?
      const present = direction === 'pick' ? line.kind === 'del' : line.kind === 'add'
      if (present) {
        body.push(` ${line.text}`)
        oldCount++
        newCount++
      }
      // Otherwise dropped, and it is as if it were never in the patch.
    }

    // A hunk reduced to nothing but context changes nothing, and including it
    // only gives git more to reject.
    if (!body.some((l) => l.startsWith('+') || l.startsWith('-'))) continue

    out.push(rewriteHeader(hunk, oldCount, newCount), ...body)
  }

  if (!changes) return null
  return `${out.join('\n')}\n`
}

/**
 * The `@@` line, with the counts corrected for what survived.
 *
 * The *starts* are deliberately left alone. They are positions in the two files
 * the patch was made against, and those files have not moved — only our
 * selection of lines has. Recomputing them is the classic way to produce a
 * patch that applies in the wrong place.
 *
 * The trailing section heading is kept because it costs nothing and it is what
 * tells you which function a hunk is in when git prints an error about it.
 */
function rewriteHeader(hunk: Hunk, oldCount: number, newCount: number): string {
  const tail = hunk.header.replace(/^@@[^@]*@@/, '')
  return `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${tail}`
}

/** Every changeable line in a hunk — what ticking the hunk itself means. */
export function hunkLineIndices(hunk: Hunk): number[] {
  return hunk.lines.filter((l) => l.kind === 'add' || l.kind === 'del').map((l) => l.index)
}

/** How many lines a hunk adds and removes, for the count beside its heading. */
export function hunkCounts(hunk: Hunk): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of hunk.lines) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}
