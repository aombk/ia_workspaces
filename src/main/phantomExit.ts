import { execFile } from 'node:child_process'
import { hasQuirk, isWindows, platformKind } from '../shared/platform'

const PLATFORM = platformKind(process.platform)

/**
 * A PTY that says its shell exited while the shell is still running.
 *
 * node-pty's Windows backend raises `exit` from two different places. One is
 * the real thing: the shell ended and ConPTY reports its code. The other fires
 * when the conout socket closes — the agent's exit handler runs with no exit
 * code at all, which reaches us as `exitCode` null and no signal, while
 * `powershell.exe` and whatever agent it is hosting are still very much alive.
 *
 * Believing that second one is expensive. We drop the session, unregister the
 * pid, tell the renderer the pane's shell is gone — and nothing ever reaps the
 * process, so it keeps holding its port, its memory and, if it is an agent, its
 * API quota, with no pane left pointing at it. It does not even show up in the
 * running-processes panel, because that panel walks down from the pids of live
 * panes and this pane is no longer one.
 *
 * The guard is one-sided and costs nothing in the normal case: before believing
 * a code-less exit, ask the OS whether the pid is still there. If it is, this
 * was the transport closing rather than a death, and we reap the tree ourselves
 * instead of leaving it orphaned.
 *
 * The pane still ends up with a dead shell either way. Reattaching to the live
 * ConPTY is not on the table — by the time we see the exit, node-pty has
 * already destroyed the socket we would need — so the win here is not
 * resurrection, it is not leaking the process.
 *
 *
 */

/**
 * Is this pid still present?
 *
 * Signal 0 performs the existence and permission check without delivering
 * anything. `EPERM` means the process exists but belongs to someone else, which
 * counts as alive — the question is whether the pid is still occupied, and
 * reading "not yours" as "gone" is what would let a genuine orphan through.
 * `ESRCH` is the only real absence.
 *
 * Windows caveat: `kill(pid, 0)` can succeed for a pid whose process has
 * already exited, so this leans towards "alive". Both callers are built for
 * that — a false positive here costs one wasted probe and a reap of a pid that
 * is already gone, which is a no-op.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Is this exit a phantom — the transport died but the process did not?
 *
 * True only when all of:
 *  - there is no exit code. A real exit always records one.
 *  - there is no signal. A killed process reports what killed it, and that is a
 *    genuine death; only the code-less *and* signal-less shape is anomalous.
 *  - the pid is known and still answers.
 *
 * Not gated on Windows even though every observed case is ConPTY: on any
 * platform a real exit carries either a code or a signal, so code-less plus
 * signal-less plus still-running is just as much a lie elsewhere, and gating it
 * would only hide the same bug on the runtimes we test least.
 *
 * `alive` is a parameter so the decision can be tested without real processes.
 */
export function isPhantomExit(
  exitCode: number | null | undefined,
  signal: number | null | undefined,
  pid: number | undefined,
  alive: (pid: number) => boolean
): boolean {
  if (exitCode !== null && exitCode !== undefined) return false
  if (signal !== null && signal !== undefined) return false
  if (pid === undefined || pid === null) return false
  if (!Number.isInteger(pid) || pid <= 0) return false
  return alive(pid)
}

/**
 * How sure are we that the process behind this pid is the one we spawned?
 *
 * A pid is not an identity. Windows hands them out again quickly, so "pid 20516
 * is alive" says nothing about *which* process is alive, and killing a tree on
 * that basis is how you take out somebody else's work.
 *
 *  - `start-time`  — the OS says this process was created about when we spawned
 *    ours. Two processes cannot occupy one pid at the same instant, so agreeing
 *    on the clock is strong evidence they are the same one.
 *  - `heuristic`   — the creation time could not be read, but the image is still
 *    the shell we launched. Weak: any `powershell.exe` passes. Accepted only so
 *    that a machine where the probe does not work still gets its orphans reaped.
 *  - `unconfirmed` — a creation time was read and disagrees, or nothing
 *    corroborates the pid at all. Never kill on this.
 *
 * A creation time that was read is authoritative: when it disagrees, the image
 * name must not be allowed to overrule it, because that disagreement *is* the
 * recycled-pid case — a fresh `powershell.exe` wearing our old number.
 */
export type ReapIdentity = 'start-time' | 'heuristic' | 'unconfirmed'

/**
 * How far apart our spawn timestamp and the OS creation time may be and still
 * count as the same process.
 *
 * We stamp `Date.now()` immediately before handing the shell to ConPTY, so
 * under any normal load the two agree within a few hundred milliseconds. The
 * allowance is generous because the cost of being too tight is refusing to reap
 * a real orphan, while the cost of being too loose is killing a process that
 * happened to start within seconds of ours — so the window is small enough that
 * a recycled pid, which can only be issued after our shell died, has to have
 * died and been reissued inside it.
 */
const CLOCK_SLACK_MS = 5_000

export function classifyReapIdentity(opts: {
  /** `Date.now()` from just before the spawn. */
  spawnedAt: number
  /** Epoch milliseconds the OS reports, or null when it could not be read. */
  currentStartTime: number | null
  looksLikeOurShell: boolean
}): ReapIdentity {
  if (opts.currentStartTime !== null) {
    return Math.abs(opts.currentStartTime - opts.spawnedAt) <= CLOCK_SLACK_MS
      ? 'start-time'
      : 'unconfirmed'
  }
  return opts.looksLikeOurShell ? 'heuristic' : 'unconfirmed'
}

/** Is this identity strong enough to authorise killing the tree? */
export function mayReap(identity: ReapIdentity): boolean {
  return identity !== 'unconfirmed'
}

/**
 * What the OS says about a pid: when its process started, and what it is
 * running. Null on any failure at all — a probe error, a timeout, output we
 * cannot parse, or a process that has since gone. Callers must read null as
 * "we do not know", never as a match, because the entire point is to withhold
 * the kill when we are unsure.
 *
 * `Get-CimInstance` rather than `wmic`: wmic is deprecated and absent from
 * current Windows 11 builds, and the ports panel already reaches for CIM, so
 * this is the same dependency rather than a second one.
 */
export function probeProcess(
  pid: number
): Promise<{ startedAt: number; name: string } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null)
  // Answering null stands the whole phantom check down, which is right: a POSIX
  // pty reports the child's real wait status, so there is no code-less exit to
  // second-guess and nothing for this probe to disambiguate.
  if (!hasQuirk(PLATFORM, 'phantomExit')) return Promise.resolve(null)

  const script =
    `$ErrorActionPreference='SilentlyContinue'\n` +
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"\n` +
    `if ($p) { "$([DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds()) $($p.Name)" }`

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const match = /^(\d+)\s+(.+)$/.exec(String(stdout).trim())
        if (!match) {
          resolve(null)
          return
        }
        resolve({ startedAt: Number(match[1]), name: match[2].trim() })
      }
    )
  })
}

/**
 * Kill the process and everything under it.
 *
 * `/T` because the shell is rarely the thing worth killing — the agent, the
 * dev server and the build it started are its children, and they are what would
 * otherwise be left holding the port. `/F` because a process we have already
 * lost the console for has no way to be asked nicely.
 *
 * Best effort: an already-dead pid is a no-op, and a failure here is logged
 * rather than surfaced, since the pane is going away either way.
 */
export function reapTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve()

  // POSIX has the same job to do and a cheaper way to do it. node-pty makes the
  // shell a process group leader, so a negative pid signals the whole group —
  // the shell, the agent it is hosting, and the dev server that agent started —
  // in one call, with no process to spawn. Which is `taskkill /T /F`, spelled
  // the way the platform spells it.
  if (!isWindows(PLATFORM)) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // Already gone, or never a group leader. Either way there is nothing
      // left to reap and the pane is going away regardless.
    }
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    execFile(
      'taskkill.exe',
      ['/PID', String(pid), '/T', '/F'],
      { timeout: 8000, windowsHide: true },
      () => resolve()
    )
  })
}

/**
 * The whole sequence, for a PTY exit that looked like a phantom: work out
 * whether we are sure enough about the pid, and reap it if we are.
 *
 * Returns what happened, so the caller can log it and tell the pane something
 * truthful rather than "exited with code 0".
 */
export async function reapPhantom(opts: {
  pid: number
  spawnedAt: number
  /** The executable we launched, e.g. `powershell.exe`. */
  shellImage: string
}): Promise<{ identity: ReapIdentity; reaped: boolean }> {
  const probe = await probeProcess(opts.pid)

  // Gone between the exit and the probe: nothing to reap, and nothing was
  // orphaned after all. Reported as proven so the caller logs a clean outcome.
  if (!probe && !isPidAlive(opts.pid)) return { identity: 'start-time', reaped: false }

  const identity = classifyReapIdentity({
    spawnedAt: opts.spawnedAt,
    currentStartTime: probe ? probe.startedAt : null,
    looksLikeOurShell: probe
      ? probe.name.toLowerCase() === basename(opts.shellImage).toLowerCase()
      : false,
  })

  if (!mayReap(identity)) return { identity, reaped: false }
  await reapTree(opts.pid)
  return { identity, reaped: true }
}

function basename(file: string): string {
  const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return cut === -1 ? file : file.slice(cut + 1)
}
