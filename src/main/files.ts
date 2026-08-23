import { cp, readdir, readFile, stat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { isHiddenEntry } from '../shared/platform'
import { isImagePath } from '../shared/images'
import type { FileEntry, GitStatusMap, SearchHit } from '../shared/types'

/**
 * Largest file `readText` will return.
 *
 * The result crosses the IPC boundary and is then laid out as DOM. A 200MB log
 * opened by a mis-click should fail with a message, not wedge the window.
 */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/**
 * Enough of a file's identity to notice somebody else wrote to it.
 *
 * Deliberately not a hash and not the content: this is polled, per open editor,
 * for the whole time the app is up, and reading a two-megabyte file every couple
 * of seconds to find out that nothing happened is not a trade worth making.
 * Modification time and size together are what every editor uses for this, and
 * they are wrong only for a write that lands in the same millisecond at exactly
 * the same length.
 *
 * Null rather than a throw for a file that is not there: an editor open on a
 * path that does not exist yet is an ordinary state — it is how a new file is
 * made — and so is one whose file has just been deleted.
 */
export async function fileStamp(target: string): Promise<{ mtime: number; size: number } | null> {
  try {
    const info = await stat(target)
    if (info.isDirectory()) return null
    return { mtime: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

/**
 * Reads a file as UTF-8 text, for the panes that display one.
 *
 * Refuses anything oversized or not valid UTF-8 rather than returning something
 * lossy: this is used to *show a file to you*, and silently replacing bytes
 * with U+FFFD would misrepresent what is on disk.
 */
export async function readText(target: string): Promise<string> {
  const info = await stat(target)
  if (info.isDirectory()) throw new Error('that is a folder')
  if (info.size > MAX_TEXT_BYTES) {
    throw new Error(`file is ${(info.size / 1024 / 1024).toFixed(1)} MB — too large to display`)
  }
  const bytes = await readFile(target)
  const text = new TextDecoder('utf-8', { fatal: true })
  try {
    return text.decode(bytes)
  } catch {
    throw new Error('not a UTF-8 text file')
  }
}

/**
 * Largest slice of a file the hex view will load.
 *
 * Not a refusal like `readText`'s limit: past this the file is *truncated*,
 * because "show me the header of this 4GB image" is a reasonable thing to want
 * and refusing it helps nobody.
 */
const MAX_BYTES = 1024 * 1024

/** Raw bytes, base64-encoded, for the hex view. */
export async function readBytes(
  target: string
): Promise<{ base64: string; size: number; truncated: boolean }> {
  const info = await stat(target)
  if (info.isDirectory()) throw new Error('that is a folder')
  const handle = await open(target, 'r')
  try {
    const take = Math.min(info.size, MAX_BYTES)
    const buffer = Buffer.alloc(take)
    await handle.read(buffer, 0, take, 0)
    return { base64: buffer.toString('base64'), size: info.size, truncated: info.size > take }
  } finally {
    await handle.close()
  }
}

/**
 * Overwrites bytes at an offset, leaving the rest of the file — and its length
 * — exactly as they were. The hex view's save.
 */
export async function patchBytes(target: string, offset: number, base64: string): Promise<void> {
  const bytes = Buffer.from(base64, 'base64')
  const handle = await open(target, 'r+')
  try {
    await handle.write(bytes, 0, bytes.length, offset)
  } finally {
    await handle.close()
  }
}

/**
 * Writes UTF-8 text over whatever was there, for the notes editor.
 *
 * Deliberately an overwrite, and deliberately only reachable with a full path:
 * the caller is editing a file it just read, so there is nothing to validate a
 * name against and nothing to refuse.
 */
export async function writeText(target: string, content: string): Promise<void> {
  await writeFile(target, content, 'utf8')
}

/**
 * Largest diff the pane will render. A generated-file commit can run to
 * megabytes, and past a point nobody is reading it anyway.
 */
const MAX_DIFF_BYTES = 1024 * 1024

/**
 * A unified diff between two files that need have nothing to do with each other.
 *
 * `--no-index` is git's mode for exactly this: it compares two paths as given
 * and does not care whether either is tracked, or whether there is a repository
 * anywhere in sight. So this works on a `.env` against a `.env.example`, on two
 * config files in unrelated folders, or on a pair of downloads — and it emits
 * the same unified format the changes pane already knows how to colour.
 *
 * Absolute paths, so no working directory can change what is being compared;
 * `cwd` is only somewhere for git to start.
 */
export async function compareFiles(left: string, right: string): Promise<string> {
  const text = await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      ['diff', '--no-index', '--no-color', '--', left, right],
      { maxBuffer: MAX_DIFF_BYTES * 4, windowsHide: true },
      (err, stdout) => {
        // Exit 1 means "they differ", which is the ordinary outcome here.
        if (stdout) resolve(stdout)
        else if (err && !stdout) reject(err)
        else resolve('')
      }
    )
  })

  return text.length > MAX_DIFF_BYTES
    ? `${text.slice(0, MAX_DIFF_BYTES)}\n\n… diff truncated at ${MAX_DIFF_BYTES / 1024} KB`
    : text
}

/**
 * A unified diff of the working tree, or of one file within it.
 *
 * `HEAD` rather than the index, so staged and unstaged changes both show: this
 * answers "what is different from the last commit", which is the question you
 * have after an agent has been editing. Untracked files have nothing to diff
 * against, so `--no-index` against the null device is used for those — that is
 * what produces the whole file as additions rather than silence.
 */
export async function gitDiff(cwd: string, target: string, untracked: boolean): Promise<string> {
  const args =
    untracked && target
      ? ['diff', '--no-index', '--no-color', '--', '/dev/null', target]
      : ['diff', 'HEAD', '--no-color', '--', target || '.']

  // `git diff --no-index` exits 1 when the files differ, which is the normal
  // case here rather than a failure — so stdout is trusted over the exit code.
  const text = await new Promise<string>((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_DIFF_BYTES * 4, windowsHide: true },
      (err, stdout) => {
        if (stdout) resolve(stdout)
        else if (err) reject(err)
        else resolve('')
      }
    )
  })

  return text.length > MAX_DIFF_BYTES
    ? `${text.slice(0, MAX_DIFF_BYTES)}\n\n… diff truncated at ${MAX_DIFF_BYTES / 1024} KB`
    : text
}

/** Most hits worth returning. Past this you refine the query, not scroll. */
const MAX_HITS = 500
/** Longest line kept. A minified bundle is one line and megabytes wide. */
const MAX_HIT_LEN = 400

/**
 * Searches a folder for a literal string.
 *
 * `git grep` in both cases, because it is the only thing to hand that honours
 * .gitignore. That is not a nicety: `findstr /S` was used here first and took
 * over two minutes on a project with `node_modules` and a build directory,
 * because it has no notion of what not to look in. Nothing was ever found
 * because nothing ever came back.
 *
 * Inside a repository, `--untracked` so a file you have not committed yet is
 * still searched. Outside one, `--no-index` makes git search a plain directory,
 * and `--exclude-standard` still applies any .gitignore it finds.
 *
 * Literal, not regex: this is a "where is this string" box, and a stray `(`
 * typed into a regex search is an error message rather than a result.
 */
export async function searchWorkspace(
  cwd: string,
  query: string,
  caseSensitive: boolean
): Promise<SearchHit[]> {
  if (!query.trim()) return []

  const args = [
    'grep',
    '--fixed-strings',
    '--line-number',
    '--no-color',
    '--exclude-standard',
    (await hasGitDir(cwd)) ? '--untracked' : '--no-index',
    ...(caseSensitive ? [] : ['--ignore-case']),
    '-e',
    query,
  ]

  // git grep exits non-zero when nothing matched, which is not an error.
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 20000 },
      (_e, out) => resolve(out ?? '')
    )
  })

  const hits: SearchHit[] = []
  for (const raw of stdout.split('\n')) {
    if (hits.length >= MAX_HITS) break
    const line = raw.replace(/\r$/, '')
    const split = splitAfterDrive(line)
    if (!split) continue
    const [target, rest] = split
    const at = rest.indexOf(':')
    if (at < 0) continue
    const number = Number.parseInt(rest.slice(0, at), 10)
    if (!Number.isFinite(number)) continue
    let text = rest.slice(at + 1).trim()
    if (text.length > MAX_HIT_LEN) text = `${text.slice(0, MAX_HIT_LEN)}\u2026`
    hits.push({ path: path.join(cwd, target.replace(/\//g, '\\')), line: number, text })
  }
  return hits
}

/** Splits `path:rest`, stepping over a `C:` drive letter at the start. */
function splitAfterDrive(line: string): [string, string] | null {
  const skip = line.length > 2 && line[1] === ':' ? 2 : 0
  const at = line.indexOf(':', skip)
  if (at < 0) return null
  return [line.slice(0, at), line.slice(at + 1)]
}

async function hasGitDir(dir: string): Promise<boolean> {
  let at = dir
  for (let i = 0; i < 64; i++) {
    if (await isDirectory(path.join(at, '.git'))) return true
    const parent = path.dirname(at)
    if (parent === at) return false
    at = parent
  }
  return false
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/**
 * File operations for the tree's context menu.
 *
 * Names are validated rather than trusted: the tree passes user input straight
 * through, and a name containing a separator would silently write outside the
 * folder the user is looking at.
 */
function assertPlainName(name: string): string {
  const clean = name.trim()
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid name')
  if (/[\\/:*?"<>|]/.test(clean)) throw new Error('A name cannot contain \\ / : * ? " < > |')
  return clean
}

/**
 * Makes an empty file, refusing to clobber one that is already there.
 *
 * `wx` rather than `w`: this is reached from a "new file" menu and from the
 * notes tab, and silently truncating something you already had would be the
 * worst possible reading of either.
 */
export async function createFile(parent: string, name: string): Promise<string> {
  const target = path.join(parent, assertPlainName(name))
  try {
    await writeFile(target, '', { flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new Error('That file already exists')
    }
    throw err
  }
  return target
}

/**
 * Launches a program with one file as its argument.
 *
 * Spawned directly rather than typed into a shell: routing "open my editor"
 * through whichever pane happened to exist meant it silently did nothing when
 * there wasn't one, and made the whole thing depend on shell quoting for no
 * benefit. Detached and unref'd — the editor outlives us.
 */
export async function openWith(program: string, target: string): Promise<void> {
  if (!program.trim()) throw new Error('no editor is set')
  const child = spawn(program, [target], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

export async function createDirectory(parent: string, name: string): Promise<string> {
  const target = path.join(parent, assertPlainName(name))
  await mkdir(target, { recursive: false })
  return target
}

export async function renameEntry(target: string, name: string): Promise<string> {
  const next = path.join(path.dirname(target), assertPlainName(name))
  await rename(target, next)
  return next
}

export async function removeEntry(target: string): Promise<void> {
  await rm(target, { recursive: true, force: false })
}

/**
 * A destination in `dir` for something called `name`, never overwriting.
 *
 * Copy and paste into a folder that already has that name is not a mistake —
 * it is how you duplicate a file — so a collision gets a suffix rather than a
 * dialog. `path.extname` returns '' for a dotfile, which is what we want: a
 * second `.gitignore` should be `.gitignore (2)`, not `. (2)gitignore`.
 */
async function freeDestination(dir: string, name: string): Promise<string> {
  const first = path.join(dir, name)
  if (!(await taken(first))) return first

  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  // Bounded: a thousand copies of one file means something has gone wrong, and
  // an unbounded loop on a filesystem that always answers "taken" would hang.
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`)
    if (!(await taken(candidate))) return candidate
  }
  throw new Error('too many copies of that name in one folder')
}

async function taken(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/**
 * Guards the one move that destroys data: a folder into itself.
 *
 * `cp` and `rename` will both happily start copying a directory into its own
 * subtree and recurse until the disk fills. Checked on the resolved paths so
 * `..` cannot walk around it.
 */
function wouldContainItself(source: string, destDir: string): boolean {
  const from = path.resolve(source)
  const to = path.resolve(destDir)
  if (from === to) return false
  const rel = path.relative(from, to)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Copies a file or folder into `destDir`. Returns where it landed. */
export async function copyEntry(source: string, destDir: string): Promise<string> {
  if (wouldContainItself(source, destDir)) {
    throw new Error('cannot copy a folder into itself')
  }
  const target = await freeDestination(destDir, path.basename(source))
  // `recursive` covers a folder; `errorOnExist` is belt and braces, since
  // `freeDestination` has already found a name nothing is using.
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  return target
}

/**
 * Moves a file or folder into `destDir`. Returns where it landed.
 *
 * `rename` first, which is instant and atomic within a volume. It fails with
 * EXDEV across volumes — a different drive, a network share, a WSL path — and
 * that is not an error, it is the case where a move has to be a copy followed
 * by a delete.
 */
export async function moveEntry(source: string, destDir: string): Promise<string> {
  if (wouldContainItself(source, destDir)) {
    throw new Error('cannot move a folder into itself')
  }
  // Already there: nothing to do, and going ahead would rename it to "x (2)".
  if (path.resolve(path.dirname(source)) === path.resolve(destDir)) return source

  const target = await freeDestination(destDir, path.basename(source))
  try {
    await rename(source, target)
    return target
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'EXDEV') throw err
  }
  await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  // Only after the copy has succeeded. The other order loses the file if the
  // write fails halfway.
  await rm(source, { recursive: true, force: false })
  return target
}

/**
 * Directory listing for the file tree.
 *
 * `withFileTypes` avoids a stat per entry for the common case; a stat is only
 * needed for size and mtime, and a failing one (locked file, broken junction)
 * degrades to zeroes rather than dropping the row.
 */
export async function readDirectory(dir: string, showHidden: boolean): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true })

  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FileEntry | null> => {
      const name = dirent.name
      // The dot convention applies everywhere, including Windows: a `.git` in
      // a checkout is hidden by convention there whether or not its attribute
      // is set, which is what a developer expects to see. The attribute check
      // below adds the other half, and answers false where there is none.
      if (!showHidden && isHiddenEntry(name)) return null

      const full = path.join(dir, name)
      let size = 0
      let modified = 0
      try {
        const info = await stat(full)
        size = info.size
        modified = info.mtimeMs
        // Hidden/system files have no dot prefix on Windows.
        if (!showHidden && isWindowsHidden(info as unknown as Record<string, unknown>)) return null
      } catch {
        /* unreadable entry still gets listed */
      }

      return { name, path: full, isDir: dirent.isDirectory(), size, modified }
    })
  )

  return entries
    .filter((e): e is FileEntry => e !== null)
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    })
}

/**
 * Ceilings for the recursive image walk.
 *
 * A gallery pointed at a drive root would otherwise walk the whole filesystem
 * while the pane sits empty. Both limits are generous enough that a photo
 * library is unaffected and a mistake stops in about a second — and the caller
 * is told it was cut short, so the pane can say so rather than quietly showing
 * a subset.
 */
const MAX_IMAGE_FILES = 5000
const MAX_IMAGE_DEPTH = 8

/** Folders never worth walking for images, and expensive to get wrong. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '__pycache__', '.venv'])

/**
 * Every image at or beneath a folder.
 *
 * In the main process rather than the renderer walking `readDir` itself: a deep
 * tree is thousands of round trips over IPC, each one serialising a directory
 * the renderer then throws away. This returns only the image files, already
 * flat.
 *
 * Symlinked directories are not followed. A link pointing at an ancestor is a
 * cycle, and the depth limit alone would turn that into thousands of duplicates
 * of the same photographs rather than a hang.
 */
export async function listImages(
  dir: string,
  recursive: boolean,
  showHidden: boolean
): Promise<{ files: FileEntry[]; truncated: boolean }> {
  const files: FileEntry[] = []
  let truncated = false

  async function walk(current: string, depth: number): Promise<void> {
    if (truncated) return
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      // An unreadable folder is skipped rather than failing the whole walk —
      // one permission-denied subdirectory should not empty the gallery.
      return
    }

    const subdirs: string[] = []
    for (const dirent of dirents) {
      const name = dirent.name
      if (!showHidden && isHiddenEntry(name)) continue

      const full = path.join(current, name)
      if (dirent.isDirectory()) {
        if (recursive && depth < MAX_IMAGE_DEPTH && !SKIP_DIRS.has(name.toLowerCase())) {
          subdirs.push(full)
        }
        continue
      }
      if (!dirent.isFile() || !isImagePath(name)) continue

      if (files.length >= MAX_IMAGE_FILES) {
        truncated = true
        return
      }

      let size = 0
      let modified = 0
      try {
        const info = await stat(full)
        size = info.size
        modified = info.mtimeMs
        if (!showHidden && isWindowsHidden(info as unknown as Record<string, unknown>)) continue
      } catch {
        /* listed with zeroes rather than dropped */
      }
      files.push({ name, path: full, isDir: false, size, modified })
    }

    // Depth-first, one directory at a time. Fanning out with Promise.all is
    // faster on a shallow tree and opens thousands of handles on a deep one.
    for (const sub of subdirs) {
      if (truncated) return
      await walk(sub, depth + 1)
    }
  }

  await walk(dir, 0)
  return { files, truncated }
}

/**
 * Every file at or beneath a folder whose name ends one of `suffixes`.
 *
 * The same walk as `listImages` with the test swapped, and kept separate rather
 * than folded into it: the gallery's version carries sizes and modification
 * times because it draws them, and this one is answering "which of these exist"
 * for a menu, where a `stat` per file is a round trip nobody reads.
 *
 * Sorted by path, so a list of them is stable between calls — a menu whose
 * entries move about between openings is a menu you cannot learn.
 */
export async function listByExtension(dir: string, suffixes: string[]): Promise<string[]> {
  const wanted = suffixes.map((s) => s.toLowerCase())
  const found: string[] = []

  async function walk(current: string, depth: number): Promise<void> {
    if (found.length >= MAX_LISTED_FILES) return
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    const subdirs: string[] = []
    for (const dirent of dirents) {
      const name = dirent.name
      if (isHiddenEntry(name)) continue
      const full = path.join(current, name)
      if (dirent.isDirectory()) {
        if (depth < MAX_IMAGE_DEPTH && !SKIP_DIRS.has(name.toLowerCase())) subdirs.push(full)
        continue
      }
      if (!dirent.isFile()) continue
      if (!wanted.some((suffix) => name.toLowerCase().endsWith(suffix))) continue
      if (found.length >= MAX_LISTED_FILES) return
      found.push(full)
    }
    for (const sub of subdirs) {
      if (found.length >= MAX_LISTED_FILES) return
      await walk(sub, depth + 1)
    }
  }

  await walk(dir, 0)
  return found.sort((a, b) => a.localeCompare(b))
}

/** A menu is not a file manager: past this many, go and find it yourself. */
const MAX_LISTED_FILES = 200

const FILE_ATTRIBUTE_HIDDEN = 0x2
const FILE_ATTRIBUTE_SYSTEM = 0x4

function isWindowsHidden(info: Record<string, unknown>): boolean {
  // Node exposes Windows attributes only via the undocumented `attributes`
  // field on some platforms; fall back to not hiding when it is absent.
  const attributes = (info as { attributes?: number }).attributes
  if (typeof attributes !== 'number') return false
  return (attributes & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM)) !== 0
}

/**
 * Working-tree status, as absolute path -> porcelain letter.
 *
 * Unlike branch lookup this does shell out to git: reproducing status means
 * reading the index and diffing it against the tree, which is not something to
 * reimplement. It runs only on tree refresh, and failure is silent — no repo
 * simply means no markers.
 */
export function gitStatus(cwd: string): Promise<GitStatusMap> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd, timeout: 5000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({})
          return
        }
        resolve(parsePorcelain(stdout, cwd))
      }
    )
  })
}

/** Shared with the other runtimes' ports; keep the precedence rule in step. */
function parsePorcelain(stdout: string, cwd: string): GitStatusMap {
  const out: GitStatusMap = {}

  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue
    const code = line.slice(0, 2).trim()
    let file = line.slice(3).trim()
    // Renames read "old -> new"; the new path is the one on disk.
    const arrow = file.indexOf(' -> ')
    if (arrow !== -1) file = file.slice(arrow + 4)
    if (file.startsWith('"') && file.endsWith('"')) file = file.slice(1, -1)

    const letter = code.includes('?') ? '?' : code[0] || 'M'
    const full = path.resolve(cwd, file.replace(/\//g, path.sep))
    out[full] = letter

    // Mark every ancestor up to the repo root so collapsed folders still show
    // that something inside them changed.
    let parent = path.dirname(full)
    while (parent.length >= cwd.length && parent !== path.dirname(parent)) {
      if (!out[parent]) out[parent] = '·'
      if (parent === cwd) break
      parent = path.dirname(parent)
    }
  }

  return out
}
