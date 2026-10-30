/**
 * The PATH a Windows pane should start with, read from the registry.
 *
 * A process inherits its PATH from whoever started it, and the app is started
 * by Explorer, whose copy can be wrong for the whole session. The case that
 * prompted this: Explorer's environment carried the machine PATH and *none* of
 * the user PATH — all 35 entries gone, `AppData\Roaming\npm` and `.local\bin`
 * among them — while the registry had every one. Explorer builds that block at
 * logon, and a long machine PATH is known to make it drop the user half without
 * a word. Every pane inherited the loss, so `claude` was "not recognized" here
 * and found at once in Windows Terminal, which rebuilds its environment from
 * the registry for exactly this reason. Nothing in the pane said why.
 *
 * Re-read on every spawn rather than once, so something installed while the
 * app is open is found in a later tab without a restart — the other half of
 * what Windows Terminal does. The read runs in the background and the spawn
 * takes the last answer, because a shell must not wait on `reg.exe`.
 *
 * The inherited PATH still leads (see `mergePaths`): an app started from a
 * terminal with a project's tools on its PATH must go on finding those. The
 * registry only ever adds what was missing.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mergePaths } from './toolPath'

const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
const USER_KEY = 'HKCU\\Environment'

/**
 * How long `reg.exe` gets. It answers in tens of milliseconds; past this the
 * pane opens with what it inherited rather than waiting.
 */
const REG_TIMEOUT_MS = 2000

/**
 * The `Path` value out of `reg query <key> /v Path` output, or nothing.
 *
 * The line is `    Path    REG_EXPAND_SZ    C:\a;C:\b`, with the value free to
 * hold spaces of its own, so it is split on the type and not on whitespace.
 */
export function parseRegPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line)
    if (m) return m[1].trim() || undefined
  }
  return undefined
}

/**
 * `%NAME%` expanded the way Windows does: case-insensitively, and an unknown
 * name left exactly as written rather than becoming empty.
 */
export function expandWindowsVars(value: string, env: Record<string, string | undefined>): string {
  const lower = new Map<string, string>()
  for (const [name, v] of Object.entries(env)) if (v !== undefined) lower.set(name.toLowerCase(), v)
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => lower.get(name.toLowerCase()) ?? whole)
}

function queryPath(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, '/v', 'Path'],
      { windowsHide: true, timeout: REG_TIMEOUT_MS },
      // A key with no Path, or a reg.exe that fails, is one source missing —
      // never a reason to fail the spawn.
      (error, stdout) => resolve(error ? undefined : parseRegPath(stdout))
    )
  })
}

/**
 * The inherited PATH with whatever the registry has that it lacks appended,
 * machine entries before user ones as Windows orders them.
 */
export async function registryMergedPath(
  inherited: string | undefined,
  env: Record<string, string | undefined>
): Promise<string> {
  const [machine, user] = await Promise.all([queryPath(MACHINE_KEY), queryPath(USER_KEY)])
  const expand = (v: string | undefined) => (v === undefined ? undefined : expandWindowsVars(v, env))
  return mergePaths([inherited, expand(machine), expand(user)], ';', existsSync)
}

/** The last answer, or nothing before the first read has finished. */
let latest: string | undefined
let reading = false

/** Starts a background read unless one is already running. */
export function refreshPanePath(): void {
  if (reading) return
  reading = true
  registryMergedPath(process.env.PATH, process.env)
    .then((p) => {
      latest = p
    })
    .finally(() => {
      reading = false
    })
}

/**
 * The PATH to give a new pane, and a nudge to re-read for the one after it.
 * Undefined until the first read lands — the pane then inherits as before.
 */
export function panePath(): string | undefined {
  const current = latest
  refreshPanePath()
  return current
}
