/**
 * SSH panes: which hosts exist, and what to run on one.
 *
 * The sibling of `wsl.ts`, and deliberately much smaller — because SSH needs
 * none of the path translation WSL does. A WSL workspace is tractable *because*
 * Windows exposes each distribution at `\\wsl.localhost\…`, so the file tree,
 * git status and search all keep working on ordinary local paths. There is no
 * such share for a machine across the network: an SSH pane's directory is a
 * path on somebody else's filesystem, and nothing local can read it.
 *
 * So this file does two things and stops: it lists the hosts you have already
 * configured, and it builds the command that lands you in one.
 */

/**
 * A host from `~/.ssh/config`.
 *
 * Deliberately not a settings panel of our own. Anyone who uses SSH already has
 * this file, and it already holds the user name, port, identity file, jump host
 * and every other option — all of which `ssh` reads for itself. Re-asking for
 * them here would be a worse copy of a thing that already works, and one that
 * would silently disagree with the real config the first time it was edited.
 */
export interface SshHost {
  /** The `Host` alias, which is also what gets passed to `ssh`. */
  alias: string
  /** `HostName`, when the alias is not itself the address. For display only. */
  hostName?: string
  /** `User`, for display only — `ssh` applies it from the config itself. */
  user?: string
}

/**
 * Host aliases out of an `~/.ssh/config`, in file order.
 *
 * A deliberately shallow parse. It reads `Host`, and picks up `HostName` and
 * `User` only to label the menu entry — everything else is left to `ssh`, which
 * is the only thing that needs to understand it. That also means an `Include`
 * we do not follow costs a menu entry rather than a broken connection: the host
 * can still be typed in by hand, and `ssh` will resolve it correctly.
 *
 * Patterns are skipped. `Host *.internal` is a rule for other entries, not a
 * machine you can connect to, and offering it as one would produce a pane that
 * fails the moment it opens.
 */
export function parseSshConfig(text: string): SshHost[] {
  const hosts: SshHost[] = []
  let current: SshHost | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    // `Key value`, or `Key=value` — ssh_config accepts both.
    const match = /^(\w+)[\s=]+(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()

    if (key === 'host') {
      current = null
      // One line can declare several aliases; the first concrete one is the
      // name worth showing, and the rest are alternates for the same machine.
      for (const alias of value.split(/\s+/)) {
        if (!alias || alias.includes('*') || alias.includes('?') || alias === '!') continue
        current = { alias }
        hosts.push(current)
        break
      }
      continue
    }

    if (!current) continue
    if (key === 'hostname') current.hostName = value
    else if (key === 'user') current.user = value
  }

  return hosts
}

/** `user@host` when the config named a user, else the alias. For menus only. */
export function sshHostLabel(host: SshHost): string {
  const target = host.hostName && host.hostName !== host.alias ? host.hostName : host.alias
  return host.user ? `${host.alias} (${host.user}@${target})` : host.alias
}

/**
 * The argv for an SSH pane.
 *
 * `-t` forces a TTY. Without it `ssh` allocates one only when its own stdin is a
 * terminal, and ours is a pipe — so the remote shell would start in
 * non-interactive mode with no prompt, no job control and no line editing, which
 * looks exactly like a hung pane.
 *
 * A remote directory turns the call into a login shell started inside it.
 * `exec` matters: without it the shell is a child of the `cd`, so exiting leaves
 * a process behind and the pane does not close. `-l` goes here, to the remote
 * shell, and not to `ssh`, which would reject it.
 *
 * `$SHELL` rather than a named shell, because the remote machine's idea of the
 * user's shell is the correct one and we cannot know it from here.
 */
export function sshArgs(host: string, remotePath?: string): string[] {
  const args = ['-t', host]
  if (remotePath) {
    // Single quotes around the path, with any embedded quote closed and
    // reopened — the remote sh parses this string, and an unescaped quote in a
    // directory name would otherwise end the command and run the rest.
    const quoted = `'${remotePath.replace(/'/g, `'\\''`)}'`
    args.push(`cd ${quoted} && exec $SHELL -l`)
  }
  return args
}
