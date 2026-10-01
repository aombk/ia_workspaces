import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
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
 * AppData and never anywhere shared, and why it is 0700 with 0600 entries: a
 * POSIX data directory is not necessarily private, and "this user" must not
 * quietly become "anyone on the machine".
 *
 * The directory is shared by every running copy of the app, so each entry
 * records which app process wrote it, and an app only ever clears its own.
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
  /**
   * The app process that registered this entry. Absent on entries written by
   * older builds, which are then judged by their shell's pid alone.
   */
  owner?: number
}

export class PidMap {
  constructor(private readonly dir: string) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      // `mode` only applies to a directory being created; one an older build
      // made is tightened here.
      chmodSync(dir, 0o700)
    } catch {
      /* the fast path still works without this */
    }
  }

  register(pid: number, identity: PaneIdentity): void {
    if (!pid || pid < 1) return
    const entry: Entry = { ...identity, pid, startedAt: Date.now(), owner: process.pid }
    try {
      writeFileSync(this.fileFor(pid), JSON.stringify(entry), { encoding: 'utf8', mode: 0o600 })
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

  /**
   * Removes this app's entries, and any nobody can still be using.
   *
   * Not the whole directory. It is shared by every copy of the app running as
   * this user, and wiping it — which this used to do at startup and at quit —
   * pulled the entries out from under another instance's live panes, so `iaw`
   * in those panes lost its fallback the moment a second window opened or
   * closed.
   *
   * What goes: entries this process wrote (it is going away, or has just
   * started and so has none that are current), entries whose owning app has
   * exited, and entries whose shell has. A shell kept alive by the broker
   * across a restart is re-registered when its pane reattaches.
   */
  clear(): void {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(this.dir, name)
      let entry: Partial<Entry> | null = null
      try {
        entry = JSON.parse(readFileSync(file, 'utf8')) as Partial<Entry>
      } catch {
        /* unreadable: nobody can resolve through it either */
      }
      const owner = typeof entry?.owner === 'number' ? entry.owner : 0
      const shell = typeof entry?.pid === 'number' ? entry.pid : 0
      const stale =
        !entry ||
        owner === process.pid ||
        (owner > 0 && !isAlive(owner)) ||
        !shell ||
        !isAlive(shell)
      if (!stale) continue
      try {
        unlinkSync(file)
      } catch {
        /* already gone */
      }
    }
  }

  private fileFor(pid: number): string {
    return path.join(this.dir, `${pid}.json`)
  }
}

/**
 * Whether a process exists. EPERM means it does and belongs to someone else —
 * alive, for this purpose; only ESRCH is proof it is gone.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
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
