/**
 * What shells this machine has, cached for the menus.
 *
 * The settings panel could afford to ask the host each time it opened. A
 * right-click menu cannot: it is built synchronously in response to the click,
 * and an await there would either show an empty menu or show one late. None of
 * these lists changes while the app is running — installing PowerShell 7 or a
 * new distribution mid-session is not a case worth a watcher — so they are read
 * once at startup and answered from memory after that.
 */
import { backend } from '../backend'
import { sshHostLabel, type SshHost } from '../shared/ssh'
import type { ShellKind, ShellProfile, ShellTarget } from '../shared/types'

let profiles: ShellProfile[] = []
let distros: string[] = []
let hosts: SshHost[] = []

export async function loadShells(): Promise<void> {
  // Independent, and a slow `wsl --list` should not hold up the other two.
  const [gotProfiles, gotDistros, gotHosts] = await Promise.all([
    backend().listShells().catch(() => [] as ShellProfile[]),
    backend().wslDistros().catch(() => [] as string[]),
    backend().sshHosts().catch(() => [] as SshHost[]),
  ])
  profiles = gotProfiles
  distros = gotDistros
  hosts = gotHosts
}

/** Only the ones actually installed, in the order the host reported them. */
export function availableShells(): ShellProfile[] {
  return profiles.filter((p) => p.available)
}

export function wslDistros(): string[] {
  return distros
}

/** Hosts from `~/.ssh/config`. Empty when there is no config to read. */
export function sshHosts(): SshHost[] {
  return hosts
}

/**
 * The human name for a shell, including which machine it is on.
 *
 * A tab labelled "SSH" when three are open on three different hosts is not
 * telling you the thing you need, which is the same reason WSL names its
 * distribution here.
 */
export function shellLabel(kind: ShellKind, target?: ShellTarget): string {
  if (kind === 'wsl') return target?.wslDistro ? `WSL · ${target.wslDistro}` : 'WSL'
  if (kind === 'ssh') return target?.sshHost ? `SSH · ${target.sshHost}` : 'SSH'
  return profiles.find((p) => p.kind === kind)?.label ?? kind
}

/** The label for one host in a shell menu. */
export function sshMenuLabel(host: SshHost): string {
  return `SSH · ${sshHostLabel(host)}`
}
