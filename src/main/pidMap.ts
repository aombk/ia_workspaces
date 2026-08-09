import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { platformKind, processTableCommand } from '../shared/platform'

const PLATFORM = platformKind(process.platform)

/**
 * Maps a pane's shell process to the pane, so `iaw` can find itself when the
 * environment didn't survive.
 *
 * `IAW_PANE_ID` is injected into every shell we spawn, and that is the fast
 * path. It stops working the moment something re-launches a process without
 * inheriting the environment — Claude Code does not propagate its own env to
 * MCP servers it starts, and a task runner or a detached child can drop it too.
 * The process *tree* survives all of that, so a descendant that has lost the
 * variables can still walk up until it recognises an ancestor as one of our
 * shells.
 *
 * Security note: the entry carries the pipe token, which means any process
 * running as this user can read it. That is the same access such a process
 * already has to the environment block of a shell it owns, so this adds no
 * exposure — but it is the reason the directory is written under the user's own
 * AppData and never anywhere shared.
 */

export interface PaneIdentity {
  paneId: string
  workspaceId: string
  pipe: string
  token: string
}

interface Entry extends PaneIdentity {
  pid: number
  startedAt: number
}

export class PidMap {
  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* the fast path still works without this */
    }
  }

  register(pid: number, identity: PaneIdentity): void {
    if (!pid || pid < 1) return
    const entry: Entry = { ...identity, pid, startedAt: Date.now() }
    try {
      writeFileSync(this.fileFor(pid), JSON.stringify(entry), 'utf8')
    } catch {
      /* best effort */
    }
  }

  unregister(pid: number): void {
    if (!pid) return
    try {
      unlinkSync(this.fileFor(pid))
    } catch {
      /* already gone */
    }
  }

  /** Removes every entry — the owning app is going away, so none are valid. */
  clear(): void {
    try {
      rmSync(this.dir, { recursive: true, force: true })
      mkdirSync(this.dir, { recursive: true })
    } catch {
      /* best effort */
    }
  }

  private fileFor(pid: number): string {
    return path.join(this.dir, `${pid}.json`)
  }
}

/**
 * Resolves the pane a CLI invocation belongs to by walking its ancestry.
 *
 * Stops at the first ancestor that is a registered shell. The walk is bounded
 * because a corrupt table could otherwise produce a cycle, and it reads the
 * process table exactly once because doing it per level would mean spawning
 * PowerShell six times to answer one question.
 */
export function resolveByAncestry(dir: string, startPid = process.pid): PaneIdentity | null {
  let entries: Map<number, PaneIdentity>
  try {
    entries = readEntries(dir)
  } catch {
    return null
  }
  if (!entries.size) return null

  const parents = readProcessTable()
  if (!parents) return null

  let pid = startPid
  for (let depth = 0; depth < 24 && pid > 0; depth++) {
    const hit = entries.get(pid)
    if (hit) return hit
    const parent = parents.get(pid)
    if (parent === undefined || parent === pid) return null
    pid = parent
  }
  return null
}

function readEntries(dir: string): Map<number, PaneIdentity> {
  const out = new Map<number, PaneIdentity>()
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const entry = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Entry
      if (entry?.pid && entry.paneId && entry.pipe) out.set(entry.pid, entry)
    } catch {
      /* a half-written entry is simply skipped */
    }
  }
  return out
}

/**
 * pid -> parent pid for every process, in one shot.
 *
 * Node exposes only `process.ppid`, which is one level. WMIC would be cheaper
 * but Windows is removing it, so Windows uses CIM — slow enough to matter (a
 * few hundred milliseconds), which is exactly why this only runs after the
 * environment-variable path has already failed. POSIX answers the same question
 * with `ps` in single-digit milliseconds, so the fallback is barely a fallback
 * there.
 *
 * Both commands are asked to print `pid ppid` per line and nothing else, so the
 * parsing below is shared rather than branched.
 */
function readProcessTable(): Map<number, number> | null {
  const { file, args } = processTableCommand(PLATFORM)
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const map = new Map<number, number>()
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\d+)\s+(\d+)$/.exec(line.trim())
      if (m) map.set(Number(m[1]), Number(m[2]))
    }
    return map.size ? map : null
  } catch {
    return null
  }
}
