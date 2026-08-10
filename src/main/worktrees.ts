/**
 * Git worktrees, for running an agent per branch.
 *
 * The design decision worth stating is what is *not* here: no new persisted
 * state, and no new concept in the workspace model. A worktree is simply a
 * workspace whose folder happens to be one. Everything that already works on a
 * folder — the file tree, the changes pane, search, the branch under the
 * workspace name, which shell new panes get — works on it unchanged, because
 * `findGitDir` has always followed the `gitdir:` pointer a worktree leaves in
 * place of a `.git` directory.
 *
 * That leaves exactly two things missing, and they are what this module adds:
 * making one, and knowing at removal time that a folder *is* one so the user
 * can be offered the cleanup rather than left with a stale registration.
 *
 * Every operation shells out to `git`. Reading `.git` directly is right for the
 * branch — one small file on a timer — and wrong for this: `worktree add`
 * writes several files, updates the parent repository's administrative area and
 * has to be undone correctly, which is precisely the sort of thing to leave to
 * the tool that owns the format.
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import type { Worktree } from '../shared/types'

/** Long enough for a slow disk, short enough not to hang the UI on a lock. */
const GIT_TIMEOUT_MS = 20_000

function git(cwd: string, args: string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, out: stdout })
        // git's own message is far better than anything we would compose —
        // "contains modified or untracked files, use --force to delete it" is
        // exactly what the user needs to read.
        const message = (stderr || stdout || err.message).trim()
        resolve({ ok: false, error: message.replace(/^fatal:\s*/i, '') })
      }
    )
  })
}

/**
 * Every worktree of the repository containing `cwd`.
 *
 * Empty when the folder is not in a repository at all, which is the same answer
 * as "no worktrees" for every caller here and avoids making them tell the two
 * apart before they can ask.
 */
export async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const res = await git(cwd, ['worktree', 'list', '--porcelain'])
  if (!res.ok) return []
  return parseWorktrees(res.out)
}

/**
 * Parses `git worktree list --porcelain`.
 *
 * Records are separated by a blank line and the *first* record is always the
 * main checkout — which is the only way to identify it, since nothing in the
 * output says so and it is the one entry that must never be offered for
 * removal.
 */
export function parseWorktrees(stdout: string): Worktree[] {
  const out: Worktree[] = []
  let current: Partial<Worktree> | null = null

  const flush = () => {
    if (current?.path) {
      out.push({
        path: current.path,
        branch: current.branch,
        head: current.head,
        main: out.length === 0,
        locked: current.locked ?? false,
        prunable: current.prunable ?? false,
      })
    }
    current = null
  }

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const space = line.indexOf(' ')
    const key = space === -1 ? line : line.slice(0, space)
    const value = space === -1 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      flush()
      current = { path: path.normalize(value) }
    } else if (current) {
      if (key === 'HEAD') current.head = value
      else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'locked') current.locked = true
      else if (key === 'prunable') current.prunable = true
      // `detached` needs no field: a record with a HEAD and no branch is one.
    }
  }
  flush()
  return out
}

/** The worktree containing this folder, or null. Never the main checkout. */
export async function worktreeAt(cwd: string): Promise<Worktree | null> {
  const all = await listWorktrees(cwd)
  const here = path.resolve(cwd)
  // The deepest match rather than the first: worktrees can be nested inside the
  // main checkout's directory tree, and the main checkout's path is a prefix of
  // everything in that case.
  let best: Worktree | null = null
  for (const wt of all) {
    if (wt.main) continue
    const root = path.resolve(wt.path)
    if (here === root || here.startsWith(root + path.sep)) {
      if (!best || root.length > path.resolve(best.path).length) best = wt
    }
  }
  return best
}

/**
 * Creates a worktree, and the branch to go with it unless it already exists.
 *
 * `-b` fails outright when the branch is already there, and a caller who typed
 * the name of an existing branch almost certainly meant "check that one out
 * here" rather than "fail". So existence decides which form is used, and a
 * branch already checked out *somewhere else* is refused by git with a message
 * that says where — which is the right answer and not one to paper over.
 */
export async function addWorktree(
  repoCwd: string,
  opts: { branch: string; dir: string; from?: string }
): Promise<{ ok: true; path: string; created: boolean } | { ok: false; error: string }> {
  const branch = opts.branch.trim()
  if (!branch) return { ok: false, error: 'a branch name is required' }
  // Refused here rather than by git, because git's own message for these is
  // about ref formats and mentions nothing the user typed.
  if (/[\s~^:?*[\\]/.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    return { ok: false, error: `"${branch}" is not a usable branch name` }
  }

  const target = path.resolve(opts.dir)
  const exists = await git(repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const args = exists.ok
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, ...(opts.from ? [opts.from] : [])]

  const res = await git(repoCwd, args)
  if (!res.ok) return { ok: false, error: res.error }
  return { ok: true, path: target, created: !exists.ok }
}

/**
 * Removes a worktree registration and its directory.
 *
 * Without `force`, git refuses when the checkout has modified or untracked
 * files — which is the behaviour to keep. This is the one operation here that
 * can destroy work, so the decision to override belongs to the person who can
 * see what is in there, and the refusal carries git's own explanation.
 */
export async function removeWorktree(
  repoCwd: string,
  dir: string,
  force = false
): Promise<{ ok: boolean; error?: string }> {
  const res = await git(repoCwd, [
    'worktree',
    'remove',
    ...(force ? ['--force'] : []),
    path.resolve(dir),
  ])
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

/**
 * A default folder for a new worktree: a sibling of the repository, named for
 * the branch.
 *
 * A sibling rather than a child, because a worktree inside the repository is a
 * directory git itself has to be told to ignore, and everything that walks the
 * tree — our own file tree and search included — would otherwise show the same
 * project twice.
 */
export function suggestWorktreeDir(repoRoot: string, branch: string): string {
  const safe = branch.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree'
  return path.join(path.dirname(path.resolve(repoRoot)), `${path.basename(repoRoot)}-${safe}`)
}

/** The repository's main checkout, which is where `worktree` commands are run. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const res = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!res.ok) return null
  const common = res.out.trim()
  if (!common) return null
  // `--git-common-dir` names the shared administrative directory, which for the
  // main checkout is `<root>/.git`. Its parent is the checkout itself.
  return path.dirname(path.normalize(common))
}
