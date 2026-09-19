/**
 * Where to look for programs this app did not spawn a shell for.
 *
 * A GUI process on macOS does not inherit your shell's PATH. Launched from
 * Finder or the Dock it gets launchd's, which is `/usr/bin:/bin:/usr/sbin:/sbin`
 * and nothing else — no Homebrew, no `~/.local/bin`, none of the places
 * anything is actually installed. Started from a terminal it inherits yours and
 * everything is found. So the same build behaves differently depending on how
 * it was opened, which is the shape of bug that gets reported as "this used to
 * work".
 *
 * What it cost here: `gh` lives in `/opt/homebrew/bin`, the publish panel asks
 * `gh auth status` to decide whether it can make a project for you in one
 * click, and from the packaged app that question answered ENOENT. The button
 * quietly fell back to "make an empty one on GitHub and paste the address",
 * with `gh` installed and signed in the whole time.
 *
 * Panes are unaffected and always were: a terminal runs a login shell, which
 * reads the same profile this asks about.
 *
 * ## Both sources, not either
 *
 * The login shell is asked because it knows where *this* user installed things,
 * whatever that is. The fixed list is kept because a shell can fail, hang, or
 * be a login shell that never reads a profile — and Homebrew being at one of
 * two well-known paths is not a guess. Merging both costs a `stat` per folder
 * and removes a whole class of "works on my machine".
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * How long the login shell gets to answer.
 *
 * It is one `printf` after whatever the profile does, and the profile is the
 * slow part — a heavy one can take a second. Past this we stop waiting and use
 * the fixed list, because nothing here is worth delaying a launch over.
 */
const SHELL_TIMEOUT_MS = 3000

/**
 * The places programs land that a GUI PATH leaves out.
 *
 * Homebrew first in both spellings — Apple silicon and Intel — then the two
 * per-user folders, then MacPorts. Ordered after the inherited PATH rather than
 * before it: a system git must go on winning over anything shadowing it here.
 */
function knownDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    '/opt/local/bin',
  ]
}

/**
 * Joins the sources into one PATH: inherited first, then the shell's, then the
 * known folders, keeping the first mention of each and dropping what is not
 * there.
 *
 * Order is the whole contract. The inherited PATH leads because a process's own
 * environment is the most specific statement anyone has made about it — an app
 * started from a terminal with a project's tools on its PATH must go on finding
 * those. Everything else only ever adds places to look.
 *
 * Pure, and separately exported, because the ordering and the de-duplication
 * are the parts that can be wrong in a way nobody notices: a PATH with the same
 * folder three times still works.
 */
export function mergePaths(
  sources: (string | undefined)[],
  sep: string,
  exists: (dir: string) => boolean
): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const source of sources) {
    for (const entry of (source ?? '').split(sep)) {
      const dir = entry.trim()
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      if (exists(dir)) out.push(dir)
    }
  }
  return out.join(sep)
}

/** What the user's login shell says PATH is, or nothing if it will not say. */
function loginShellPath(): Promise<string | undefined> {
  const shell = process.env.SHELL
  if (process.platform === 'win32' || !shell) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    // `-lc`, not `-ilc`: a login shell reads the profile where a PATH is set,
    // and an interactive one additionally reads the file where prompts, plugins
    // and greetings live. We want the answer, not the session.
    execFile(
      shell,
      ['-lc', 'printf %s "$PATH"'],
      { timeout: SHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        // A shell that fails is not an error here — it is one of two sources,
        // and the other one needs nothing.
        resolve(error ? undefined : stdout.trim() || undefined)
      }
    )
  })
}

/**
 * The resolved PATH, once it is known.
 *
 * Held as the promise rather than the value so that everything asking during
 * startup waits on the one shell call instead of starting another.
 */
let resolved: Promise<string> | null = null

/** The best answer available synchronously. See `toolPath`. */
let current = process.env.PATH

/**
 * Works out the PATH and remembers it. Safe to call more than once.
 *
 * Called at startup so the answer is ready long before anything asks: the first
 * question is a publish panel being opened, which is a user action minutes
 * later at the earliest.
 */
export function primeToolPath(): Promise<string> {
  if (!resolved) {
    resolved = loginShellPath().then((shellPath) => {
      current = mergePaths(
        [process.env.PATH, shellPath, knownDirs(os.homedir()).join(path.delimiter)],
        path.delimiter,
        existsSync
      )
      return current
    })
  }
  return resolved
}

/**
 * The PATH to spawn other people's programs with.
 *
 * Synchronous, and honest about it: before `primeToolPath` has finished this is
 * the inherited PATH, which is exactly what the app used to use everywhere. A
 * caller that happens to run first is therefore no worse off than before, and
 * every caller after the first shell call is better off.
 */
export function toolPath(): string | undefined {
  return current
}

/** For tests: forget everything worked out so far. */
export function resetToolPath(): void {
  resolved = null
  current = process.env.PATH
}
