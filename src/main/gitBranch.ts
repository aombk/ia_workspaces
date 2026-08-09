import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Resolves the current branch by reading `.git/HEAD` directly.
 *
 * Spawning `git` per workspace on a timer is a lot of process churn for one
 * string, and on Windows process creation is expensive enough to notice. HEAD
 * is a single small file and its format is stable.
 */
export function currentBranch(startDir: string): string | undefined {
  const gitDir = findGitDir(startDir)
  if (!gitDir) return undefined

  try {
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    if (ref) return ref[1]
    // Detached HEAD: show the short sha instead of nothing.
    if (/^[0-9a-f]{7,40}$/i.test(head)) return head.slice(0, 7)
  } catch {
    /* not a readable repo */
  }
  return undefined
}

/** Walks up until it finds `.git`, honouring the worktree `gitdir:` pointer. */
function findGitDir(startDir: string): string | null {
  let dir = startDir
  for (let depth = 0; depth < 64; depth++) {
    const candidate = path.join(dir, '.git')
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate
        // A worktree or submodule: `.git` is a file pointing elsewhere.
        const pointer = readFileSync(candidate, 'utf8').trim()
        const match = /^gitdir:\s*(.+)$/.exec(pointer)
        if (match) {
          const target = match[1]
          return path.isAbsolute(target) ? target : path.resolve(dir, target)
        }
      } catch {
        return null
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}
