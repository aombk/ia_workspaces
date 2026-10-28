/**
 * How much room a project takes, and getting some of it back.
 *
 * Three ways, in the order they cost you something:
 *
 * - **Compress** — APFS can store a file compressed and hand it back whole to
 *   anything that reads it, so a project compressed in place opens, builds and
 *   runs exactly as before. Nothing is lost and nothing has to be put back.
 *   Files are written uncompressed again as they change, which is why it suits
 *   a project you are resting rather than one you are in. `afsctool` does the
 *   work; macOS ships the capability but no command for it.
 * - **Clean** — delete what the project's own tools put back (`shared/space.ts`
 *   says which). The cost is the install or rebuild when you come back.
 * - **History** — a `.git` can be most of an old project. Compacting it is
 *   lossless; keeping only recent commits, or none, is not, and every such
 *   operation writes a bundle of the full history first and checks it reads
 *   back before touching anything.
 *
 * Nothing here pushes. A shortened history is a local fact until somebody
 * force-pushes it, and that is not a decision a button in this pane makes.
 */
import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterBackgroundFetch } from './git'
import { gitArgs, gitEnv } from './gitEnv'
import { toolPath } from './toolPath'
import { isKept, matchRegenerable, MAX_KEPT_COMMITS, normRel, parseKeepList } from '../shared/space'
import type { SpaceCompressor, SpaceGitInfo, SpaceRegenerable, SpaceReport, SpaceResult } from '../shared/types'

/** Directory reads in flight at once. More only queues on the disk. */
const WALK_CONCURRENCY = 48

/** Long enough for `gc` on a large repository, short enough to end a hang. */
const LONG_MS = 60 * 60 * 1000

interface Tally {
  bytes: number
  apparent: number
  files: number
}

const tally = (): Tally => ({ bytes: 0, apparent: 0, files: 0 })

/**
 * Folders with an operation running. One at a time per folder: measuring a
 * tree that is being compressed, or deleting from one being repacked, gives an
 * answer that was never true.
 */
const busy = new Set<string>()

async function exclusive<T>(dir: string, fn: () => Promise<T>, whenBusy: T): Promise<T> {
  const key = path.resolve(dir)
  if (busy.has(key)) return whenBusy
  busy.add(key)
  try {
    return await fn()
  } finally {
    busy.delete(key)
  }
}

const BUSY: SpaceResult = { ok: false, error: 'Something else is already running on this folder.' }

/**
 * Walks a tree and adds up what it takes.
 *
 * Blocks rather than lengths, because the question is what the disk is giving
 * up — a compressed file is small in blocks and unchanged in length, and that
 * difference is the whole of what compressing bought. Hard links are counted
 * once (pnpm's store is made of them). Symlinks are never followed: a link to
 * your home folder is not part of the project.
 */
async function walk(
  root: string,
  visit: (dir: string, names: string[]) => Promise<'skip' | Tally> | 'skip' | Tally,
  base: Tally,
  seen: Set<string>,
  newest: { at: number | null }
): Promise<void> {
  const queue: { dir: string; into: Tally; counted: boolean }[] = [{ dir: root, into: base, counted: true }]
  let running = 0

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (running < WALK_CONCURRENCY && queue.length) {
        const job = queue.shift()!
        running++
        void readOne(job).finally(() => {
          running--
          if (!queue.length && running === 0) resolve()
          else pump()
        })
      }
      if (!queue.length && running === 0) resolve()
    }

    const readOne = async (job: { dir: string; into: Tally; counted: boolean }) => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await fs.readdir(job.dir, { withFileTypes: true })
      } catch {
        return
      }
      const names = entries.map((e) => e.name)
      await Promise.all(
        entries.map(async (entry) => {
          const full = path.join(job.dir, entry.name)
          if (entry.isDirectory()) {
            // Only the project's own folders are asked about. Everything under
            // `.git` or a `node_modules` belongs to it, whatever it is called.
            const into = job.into === base ? await visit(full, names) : job.into
            if (into === 'skip') return
            queue.push({ dir: full, into, counted: job.counted && into === job.into })
            return
          }
          let st: import('node:fs').Stats
          try {
            st = await fs.lstat(full)
          } catch {
            return
          }
          if (st.nlink > 1) {
            const key = `${st.dev}:${st.ino}`
            if (seen.has(key)) return
            seen.add(key)
          }
          // Not blocks on Windows: Node does report them there, but as the
          // allocation — every small file rounded up to a whole cluster, one
          // under a few hundred bytes as nothing at all. `compact`, which
          // `measure` asks for the real total, counts data, so a folder
          // measured in blocks came out larger than the project holding it.
          // The length is the same unit `compact` uses for a file it has not
          // compressed.
          job.into.bytes +=
            process.platform !== 'win32' && typeof st.blocks === 'number' ? st.blocks * 512 : st.size
          job.into.apparent += st.size
          job.into.files++
          // Only what you wrote counts as the project changing: a rebuild
          // touching `build/` this morning does not make a year-old project
          // active, and neither does a `.DS_Store`.
          if (job.counted && entry.name !== '.DS_Store' && (newest.at === null || st.mtimeMs > newest.at)) {
            newest.at = st.mtimeMs
          }
        })
      )
    }

    pump()
  })
}

async function readKeepList(dir: string): Promise<string[]> {
  try {
    return parseKeepList(await fs.readFile(path.join(dir, '.devpark'), 'utf8'))
  } catch {
    return []
  }
}

/**
 * Measures a project folder: the total, its `.git`, and each regenerable
 * folder in it.
 *
 * Regenerable folders are measured but not searched for more of the same — a
 * `node_modules` is full of folders called `build` and `dist`, all of which go
 * with it.
 */
export async function measure(dir: string): Promise<SpaceReport> {
  const root = path.resolve(dir)
  const report: SpaceReport = {
    dir: root,
    measuredAt: Date.now(),
    bytes: 0,
    apparentBytes: 0,
    files: 0,
    gitBytes: 0,
    regenerables: [],
    newest: null,
  }
  try {
    const st = await fs.stat(root)
    if (!st.isDirectory()) return { ...report, error: 'Not a folder.' }
  } catch {
    return { ...report, error: 'This folder does not exist.' }
  }

  const keep = await readKeepList(root)
  const main = tally()
  const git = tally()
  const found: { rel: string; full: string; label: string; suggested: boolean; t: Tally }[] = []
  const seen = new Set<string>()
  const newest = { at: null as number | null }

  await walk(
    root,
    async (full, siblings) => {
      const name = path.basename(full)
      if (name === '.git' && path.dirname(full) === root) return git
      const rule = matchRegenerable(name, siblings, (file) => existsSync(path.join(full, file)))
      if (!rule) return main
      const t = tally()
      found.push({ rel: normRel(path.relative(root, full)), full, label: rule.label, suggested: rule.suggested, t })
      return t
    },
    main,
    seen,
    newest
  )

  const regenerables: SpaceRegenerable[] = found.map((f) => ({
    path: f.full,
    rel: f.rel,
    label: f.label,
    bytes: f.t.bytes,
    apparentBytes: f.t.apparent,
    suggested: f.suggested,
    kept: isKept(f.rel, keep),
  }))
  regenerables.sort((a, b) => b.bytes - a.bytes)

  const all = [main, git, ...found.map((f) => f.t)]
  report.bytes = all.reduce((sum, t) => sum + t.bytes, 0)
  report.apparentBytes = all.reduce((sum, t) => sum + t.apparent, 0)
  report.files = all.reduce((sum, t) => sum + t.files, 0)
  report.gitBytes = git.bytes
  report.gitApparentBytes = git.apparent
  report.regenerables = regenerables
  report.newest = newest.at
  // On Windows the walk could only add up lengths; `compact` knows what the
  // folder really occupies once anything in it is compressed.
  if (process.platform === 'win32') {
    const onDisk = await windowsOnDisk(root)
    if (onDisk !== null) report.bytes = onDisk
  }
  return report
}

/**
 * One folder's total, for the file tree's size column.
 *
 * Kept briefly and shared, because a tree asks for every folder it shows and
 * asks again on each re-read; a minute is long enough to make that free and
 * short enough that a size you are watching shrink does not look stuck.
 */
const DIR_SIZE_TTL_MS = 60_000
const dirSizes = new Map<string, { at: number; bytes: Promise<number> }>()

export function dirSize(dir: string): Promise<number> {
  const key = path.resolve(dir)
  const hit = dirSizes.get(key)
  if (hit && Date.now() - hit.at < DIR_SIZE_TTL_MS) return hit.bytes
  const bytes = sizeOf(key)
  dirSizes.set(key, { at: Date.now(), bytes })
  if (dirSizes.size > 5000) dirSizes.delete(dirSizes.keys().next().value!)
  return bytes
}

/** On-disk size of one tree, for "how much did that free". */
async function sizeOf(dir: string): Promise<number> {
  const t = tally()
  await walk(dir, () => t, t, new Set(), { at: null })
  return t.bytes
}

// ------------------------------------------------------------------ compress

function findTool(name: string): string | null {
  for (const dir of (toolPath() ?? '').split(path.delimiter)) {
    if (!dir) continue
    const full = path.join(dir, name)
    if (existsSync(full)) return full
  }
  return null
}

/**
 * Windows' own compressor: `compact.exe`, in System32 on every install.
 * Looked up by full path, because a PATH lookup is a way for some other
 * `compact` to answer instead.
 */
function compactExe(): string | null {
  const full = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'compact.exe')
  return existsSync(full) ? full : null
}

/** Whether in-place compression can run here. */
export function compressor(): SpaceCompressor {
  if (process.platform === 'win32') return compactExe() ? 'ready' : 'missing'
  if (process.platform !== 'darwin') return 'unsupported'
  return findTool('afsctool') ? 'ready' : 'missing'
}

/**
 * The totals `compact` prints last: how much data, stored in how many bytes.
 *
 * Read by shape rather than by wording, because the wording is in the
 * system's language — "1,234 total bytes of data are stored in 567 bytes" in
 * English, other words and other separators elsewhere. The totals are the line
 * whose first number is largest: the file count line and the ratio line both
 * have two numbers too, and both are small.
 */
export function parseCompactSummary(text: string): { data: number; stored: number } | null {
  let best: { data: number; stored: number } | null = null
  for (const line of text.split(/\r?\n/)) {
    const numbers = (line.match(/\d[\d,.\u00a0\u202f' ]*\d|\d/g) ?? []).map((n) => Number(n.replace(/\D/g, '')))
    if (numbers.length !== 2) continue
    const [data, stored] = numbers
    if (stored > data) continue
    if (!best || data > best.data) best = { data, stored }
  }
  return best
}

/**
 * How much a folder really takes on Windows, by asking `compact` to report on
 * it. Null where it cannot say — the walker's figure stands then.
 */
async function windowsOnDisk(dir: string): Promise<number | null> {
  const exe = compactExe()
  if (!exe) return null
  const res = await exec(exe, ['/s', '/a', '/q', '/i'], { cwd: dir })
  return parseCompactSummary(res.out)?.stored ?? null
}

function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {}
): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? { ...process.env, PATH: toolPath() },
        timeout: opts.timeout ?? LONG_MS,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: stdout ?? '', err: (stderr ?? '').trim() || (error?.message ?? '') })
      }
    )
    // Closed even with nothing to say, so a command that reads stdin when it
    // has nothing else to go on finishes instead of waiting for us.
    child.stdin?.end(opts.input ?? '')
  })
}

/**
 * Compresses a folder in place with LZFSE.
 *
 * `-S` works smallest-first, which is the order that keeps working on a disk
 * that is almost full — each compressed file is briefly written alongside the
 * original. Files that do not get smaller are left as they are; `afsctool`
 * checks each one after writing it.
 */
export function compress(dir: string): Promise<SpaceResult> {
  return exclusive(
    dir,
    async () => {
      if (process.platform === 'win32') return compressWindows(dir)
      const tool = process.platform === 'darwin' ? findTool('afsctool') : null
      if (!tool) {
        return {
          ok: false,
          error:
            process.platform === 'darwin'
              ? 'afsctool is not installed. Install it with: brew install afsctool'
              : 'In-place compression is only available on macOS and Windows.',
        }
      }
      const before = await sizeOf(dir)
      const threads = Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length))
      const res = await exec(tool, ['-c', '-T', 'LZFSE', `-j${threads}`, '-S', path.resolve(dir)])
      const after = await sizeOf(dir)
      // afsctool exits non-zero when any single file could not be compressed —
      // a locked file, one being written — while having done all the others.
      // What was freed is the honest result either way.
      if (!res.ok && after >= before) return { ok: false, error: res.err || 'afsctool failed.' }
      return { ok: true, freedBytes: Math.max(0, before - after) }
    },
    BUSY
  )
}

/**
 * The same on Windows, with `compact /exe:lzx`.
 *
 * `/exe` is the compression Windows uses for its own system files, not the
 * older "compress this folder" attribute: a better ratio, no cost when a file
 * is written, and — exactly like APFS compression — a file you change is
 * simply stored uncompressed again. LZX is its strongest setting, which suits
 * a project that is resting. Not available on a Dev Drive (ReFS), which
 * `compact` says itself.
 */
async function compressWindows(dir: string): Promise<SpaceResult> {
  const exe = compactExe()
  if (!exe) return { ok: false, error: 'compact.exe was not found in System32.' }
  const before = (await windowsOnDisk(dir)) ?? (await sizeOf(dir))
  // `/i` carries on past files that are open elsewhere; `/a` includes hidden
  // ones, which is where `.git` lives.
  const res = await exec(exe, ['/c', '/s', '/a', '/i', '/q', '/exe:lzx'], { cwd: path.resolve(dir) })
  const after = await windowsOnDisk(dir)
  if (after === null) return res.ok ? { ok: true } : { ok: false, error: res.err || res.out.trim() || 'compact failed.' }
  if (!res.ok && after >= before) return { ok: false, error: res.err || res.out.trim() || 'compact failed.' }
  return { ok: true, freedBytes: Math.max(0, before - after) }
}

// ------------------------------------------------------------------- clean

/**
 * Deletes regenerable folders.
 *
 * Every path is checked again here, against the same rules that offered it:
 * inside the project, not the project itself, a regenerable folder by name and
 * marker, and not on the project's keep list. A path that fails any of those is
 * refused rather than skipped, because a request this pane did not draw is not
 * one to half-honour.
 */
export function clean(dir: string, paths: readonly string[]): Promise<SpaceResult> {
  return exclusive(dir, () => cleanNow(dir, paths), BUSY)
}

async function cleanNow(dir: string, paths: readonly string[]): Promise<SpaceResult> {
  const root = path.resolve(dir)
  const keep = await readKeepList(root)
  const targets: string[] = []
  for (const raw of paths) {
    const full = path.resolve(raw)
    const rel = path.relative(root, full)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: `${raw} is not inside ${root}.` }
    if (isKept(normRel(rel), keep)) return { ok: false, error: `${normRel(rel)} is on this project's keep list.` }
    let siblings: string[]
    try {
      const st = await fs.lstat(full)
      if (!st.isDirectory()) return { ok: false, error: `${normRel(rel)} is not a folder.` }
      siblings = await fs.readdir(path.dirname(full))
    } catch {
      continue // Already gone, which is what was asked for.
    }
    if (!matchRegenerable(path.basename(full), siblings, (f) => existsSync(path.join(full, f)))) {
      return { ok: false, error: `${normRel(rel)} is not something a tool puts back.` }
    }
    targets.push(full)
  }

  let freed = 0
  for (const target of targets) {
    const size = await sizeOf(target)
    try {
      await fs.rm(target, { recursive: true, force: true })
      freed += size
    } catch (err) {
      return { ok: false, freedBytes: freed, error: `Could not delete ${target}: ${(err as Error).message}` }
    }
  }
  return { ok: true, freedBytes: freed }
}

/** Clean, then compress what is left. A project put away without being taken apart. */
export function park(dir: string, paths: readonly string[]): Promise<SpaceResult> {
  return (async () => {
    const cleaned = await clean(dir, paths)
    if (!cleaned.ok) return cleaned
    if (compressor() !== 'ready') return cleaned
    const squeezed = await compress(dir)
    return {
      ok: squeezed.ok,
      error: squeezed.error,
      freedBytes: (cleaned.freedBytes ?? 0) + (squeezed.freedBytes ?? 0),
    }
  })()
}

// --------------------------------------------------------------------- git

function git(cwd: string, args: string[], extra: { env?: Record<string, string>; input?: string } = {}) {
  return exec('git', gitArgs(args), { cwd, env: gitEnv(extra.env), input: extra.input })
}

/** The folder's own `.git` directory, or null. A worktree's `.git` file is not one. */
async function ownGitDir(dir: string): Promise<string | null> {
  const gitDir = path.join(path.resolve(dir), '.git')
  try {
    return (await fs.lstat(gitDir)).isDirectory() ? gitDir : null
  } catch {
    return null
  }
}

const countLines = (text: string) => text.split('\n').filter((l) => l.trim()).length

export async function gitInfo(dir: string): Promise<SpaceGitInfo> {
  const info: SpaceGitInfo = {
    repo: false,
    gitBytes: 0,
    branch: null,
    commits: 0,
    branches: 0,
    tags: 0,
    stashes: 0,
    unpushed: 0,
    remotes: [],
    worktrees: 0,
    dirty: false,
  }
  const gitDir = await ownGitDir(dir)
  if (!gitDir) return info
  info.repo = true

  const [size, branch, commits, refs, unpushed, remotes, worktrees, status] = await Promise.all([
    sizeOf(gitDir),
    git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(dir, ['rev-list', '--count', 'HEAD']),
    git(dir, ['for-each-ref', '--format=%(refname)']),
    git(dir, ['log', '--branches', '--not', '--remotes', '--format=%H']),
    git(dir, ['remote', '-v']),
    git(dir, ['worktree', 'list', '--porcelain']),
    git(dir, ['status', '--porcelain', '--untracked-files=no']),
  ])
  info.gitBytes = size
  info.branch = branch.ok ? branch.out.trim() || null : null
  info.commits = commits.ok ? Number(commits.out.trim()) || 0 : 0
  const refNames = refs.ok ? refs.out.split('\n').filter(Boolean) : []
  info.branches = refNames.filter((r) => r.startsWith('refs/heads/')).length
  info.tags = refNames.filter((r) => r.startsWith('refs/tags/')).length
  info.stashes = refNames.includes('refs/stash') ? Math.max(1, countLines((await git(dir, ['stash', 'list'])).out)) : 0
  info.unpushed = unpushed.ok ? countLines(unpushed.out) : 0
  info.worktrees = worktrees.ok ? Math.max(0, worktrees.out.split('\n').filter((l) => l.startsWith('worktree ')).length - 1) : 0
  info.dirty = status.ok && status.out.trim().length > 0

  const seen = new Set<string>()
  for (const line of remotes.ok ? remotes.out.split('\n') : []) {
    const [name, url] = line.split(/\s+/)
    if (!name || !url || seen.has(name)) continue
    seen.add(name)
    // A remote that is a folder on this machine can simply not be there any
    // more — and then this repository is the only copy of its history.
    const local = url.startsWith('/') || url.startsWith('file://') || /^[A-Za-z]:[\\/]/.test(url)
    const missing = local && !existsSync(url.replace(/^file:\/\//, ''))
    info.remotes.push({ name, url, missing })
  }
  if (!commits.ok && !/does not have any commits|unknown revision|ambiguous argument 'HEAD'/i.test(commits.err)) {
    info.error = commits.err
  }
  return info
}

/**
 * Repacks the history as tightly as git can. Keeps every commit.
 *
 * `--prune=now` drops objects nothing refers to any more — the leftovers of
 * rebases and amends that the reflog has already let go of. Reflogs are left
 * alone, so anything still in one survives.
 */
export function gitCompact(dir: string): Promise<SpaceResult> {
  return exclusive(
    dir,
    async () => {
      const gitDir = await ownGitDir(dir)
      if (!gitDir) return { ok: false, error: 'This folder has no .git of its own.' }
      // A repack rewrites the very packs a fetch is adding to.
      await afterBackgroundFetch(dir, 'compact')
      const before = await sizeOf(gitDir)
      const res = await git(dir, ['gc', '--aggressive', '--prune=now'])
      if (!res.ok) return { ok: false, error: res.err }
      return { ok: true, freedBytes: Math.max(0, before - (await sizeOf(gitDir))) }
    },
    BUSY
  )
}

/**
 * Writes every branch, tag and commit to one file and checks it reads back.
 *
 * A bundle is a repository in a file: `git clone <file>` gives the whole
 * history back. Written before anything is rewritten or removed, and the
 * operation stops if it cannot be written or does not verify.
 */
async function backup(dir: string, file: string): Promise<string | null> {
  if (!file) return 'No backup file was chosen.'
  const target = path.resolve(file)
  const made = await git(dir, ['bundle', 'create', target, '--all'])
  if (!made.ok) return `The backup could not be written: ${made.err}`
  const verified = await git(dir, ['bundle', 'verify', target])
  if (!verified.ok) return `The backup did not verify, so nothing was changed: ${verified.err}`
  return null
}

/** Refusals shared by both destructive operations. */
async function refuseRewrite(dir: string, info: SpaceGitInfo): Promise<string | null> {
  if (!info.repo) return 'This folder has no .git of its own.'
  if (info.worktrees > 0) return 'Other worktrees share this history. Remove them first.'
  const gitDir = (await ownGitDir(dir))!
  for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (existsSync(path.join(gitDir, marker))) return 'A merge, rebase or cherry-pick is in progress. Finish or abort it first.'
  }
  return null
}

/**
 * Keeps the newest `keep` commits of the current branch and drops the rest of
 * the history, every other branch, tag and stash with it.
 *
 * The kept commits are made again with `commit-tree` — same files, message,
 * author and dates — on a chain whose first commit has no parent. Along the
 * first parent, so a merge becomes an ordinary commit: what it brought in is
 * already in its files. Nothing touches the working tree or the index, because
 * the newest commit's files are exactly the files you had.
 *
 * `keep = 1` is "squash everything into one".
 */
export function gitTrim(dir: string, keep: number, backupFile: string): Promise<SpaceResult> {
  return exclusive(dir, () => trimNow(dir, keep, backupFile), BUSY)
}

async function trimNow(dir: string, keep: number, backupFile: string): Promise<SpaceResult> {
  const n = Math.floor(keep)
  if (!(n >= 1 && n <= MAX_KEPT_COMMITS)) return { ok: false, error: `Keep between 1 and ${MAX_KEPT_COMMITS} commits.` }
  // Before the backup, so the bundle holds what the fetch brought in, and the
  // refs this deletes are not being written while it deletes them.
  await afterBackgroundFetch(dir, 'trim')
  const info = await gitInfo(dir)
  const refused = await refuseRewrite(dir, info)
  if (refused) return { ok: false, error: refused }
  if (!info.branch) return { ok: false, error: 'HEAD is not on a branch. Check out the branch to keep first.' }
  if (info.commits <= n) return { ok: false, error: `There are only ${info.commits} commits; nothing to drop.` }

  const failed = await backup(dir, backupFile)
  if (failed) return { ok: false, error: failed }

  const gitDir = (await ownGitDir(dir))!
  const before = await sizeOf(gitDir)

  const SEP = '\x1f'
  const END = '\x1e'
  const log = await git(dir, [
    'log',
    '--first-parent',
    `-n${n}`,
    '--reverse',
    `--format=%H${SEP}%T${SEP}%an${SEP}%ae${SEP}%aI${SEP}%cn${SEP}%ce${SEP}%cI${SEP}%B${END}`,
  ])
  if (!log.ok) return { ok: false, error: log.err }
  const commits = log.out
    .split(END)
    .map((r) => r.replace(/^\n/, ''))
    .filter((r) => r.includes(SEP))
    .map((r) => {
      const [sha, tree, an, ae, ad, cn, ce, cd, message] = r.split(SEP)
      return { sha, tree, an, ae, ad, cn, ce, cd, message }
    })
  if (!commits.length) return { ok: false, error: 'Could not read the commits to keep.' }

  let parent: string | null = null
  for (const c of commits) {
    // One commit kept is a squash, and its message says what it stands for
    // rather than repeating whatever the last change happened to be called.
    const message =
      n === 1
        ? `Squashed history: ${info.commits} commits up to ${c.sha.slice(0, 10)}\n\nLast message:\n${c.message}`
        : c.message
    const made: { ok: boolean; out: string; err: string } = await git(
      dir,
      ['commit-tree', '--no-gpg-sign', c.tree, ...(parent ? ['-p', parent] : []), '-F', '-'],
      {
        input: message,
        env: {
          GIT_AUTHOR_NAME: c.an,
          GIT_AUTHOR_EMAIL: c.ae,
          GIT_AUTHOR_DATE: c.ad,
          GIT_COMMITTER_NAME: c.cn,
          GIT_COMMITTER_EMAIL: c.ce,
          GIT_COMMITTER_DATE: c.cd,
        },
      }
    )
    if (!made.ok) return { ok: false, error: `Rewriting stopped before changing anything: ${made.err}` }
    parent = made.out.trim()
  }

  const head = commits[commits.length - 1].sha
  const moved = await git(dir, ['update-ref', '-m', 'space: trim history', `refs/heads/${info.branch}`, parent!, head])
  if (!moved.ok) return { ok: false, error: `The branch could not be moved, so nothing changed: ${moved.err}` }

  return finishRewrite(dir, gitDir, info.branch, before)
}

/**
 * Drops every ref but the kept branch, forgets the reflogs, and repacks — the
 * three things that otherwise keep the old history alive on disk.
 */
async function finishRewrite(dir: string, gitDir: string, branch: string, before: number): Promise<SpaceResult> {
  const refs = await git(dir, ['for-each-ref', '--format=%(refname)'])
  const doomed = (refs.ok ? refs.out.split('\n') : []).filter((r) => r && r !== `refs/heads/${branch}`)
  if (doomed.length) {
    // `--no-deref`, or deleting `refs/remotes/origin/HEAD` would delete the
    // branch it points at instead of itself.
    const deleted = await git(dir, ['update-ref', '--no-deref', '--stdin'], { input: doomed.map((r) => `delete ${r}\n`).join('') })
    if (!deleted.ok) return { ok: false, error: `The history was rewritten but old refs remain: ${deleted.err}` }
  }
  for (const stale of ['ORIG_HEAD', 'FETCH_HEAD']) await fs.rm(path.join(gitDir, stale), { force: true })
  await git(dir, ['reflog', 'expire', '--expire=now', '--all'])
  const gc = await git(dir, ['gc', '--prune=now'])
  const after = await sizeOf(gitDir)
  if (!gc.ok) return { ok: false, freedBytes: Math.max(0, before - after), error: `Rewritten, but repacking failed: ${gc.err}` }
  return { ok: true, freedBytes: Math.max(0, before - after) }
}

/**
 * Deletes the folder's `.git`. The files stay; it stops being a repository.
 *
 * Backed up first unless there is nothing to back up — a repository with no
 * commits has no history to lose, and `git bundle` refuses to write an empty
 * one.
 */
export function gitRemove(dir: string, backupFile: string): Promise<SpaceResult> {
  return exclusive(
    dir,
    async () => {
      await afterBackgroundFetch(dir, 'remove-history')
      const info = await gitInfo(dir)
      const refused = await refuseRewrite(dir, info)
      if (refused) return { ok: false, error: refused }
      if (info.commits > 0) {
        const failed = await backup(dir, backupFile)
        if (failed) return { ok: false, error: failed }
      }
      const gitDir = (await ownGitDir(dir))!
      const before = await sizeOf(gitDir)
      try {
        await fs.rm(gitDir, { recursive: true, force: true })
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
      return { ok: true, freedBytes: before }
    },
    BUSY
  )
}

// ------------------------------------------------------------------- cache

/**
 * The last measurement of each folder, kept on disk.
 *
 * Measuring a large project takes seconds and a disk's worth of reads, so it
 * happens when asked rather than on a timer — and the answer is kept, so the
 * sidebar can show every workspace's size from the moment the app starts.
 */
export function spaceCache(file: string) {
  let entries: Record<string, SpaceReport> = {}
  let loaded: Promise<void> | null = null

  const load = () =>
    (loaded ??= fs
      .readFile(file, 'utf8')
      .then((text) => {
        const parsed = JSON.parse(text) as unknown
        if (parsed && typeof parsed === 'object') entries = parsed as Record<string, SpaceReport>
      })
      .catch(() => {}))

  return {
    async all(): Promise<Record<string, SpaceReport>> {
      await load()
      return entries
    },
    async measure(dir: string): Promise<SpaceReport> {
      await load()
      const report = await measure(dir)
      if (report.error) delete entries[report.dir]
      else entries[report.dir] = report
      await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {})
      await fs.writeFile(file, JSON.stringify(entries)).catch(() => {})
      return report
    },
  }
}
