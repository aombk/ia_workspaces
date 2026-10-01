/**
 * Where the broker listens and where its shared secret lives.
 *
 * Its own module because both sides need it and they cannot share the one that
 * would otherwise hold it: `hostEntry.ts` imports node-pty, and pulling that
 * into Electron's main bundle for the sake of two path joins would be a native
 * dependency taken on for nothing.
 */
import { lstatSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDir, ipcAddress, ipcRuntimeDir, platformKind } from '../shared/platform'

const PLATFORM = platformKind(process.platform)

export function hostPaths(): { address: string; tokenPath: string } {
  const home = os.homedir()
  return {
    // One broker per user, under a stable name — the opposite of the control
    // server, which is scoped by pid because each app instance runs its own.
    // A client that finds this address occupied has found the broker, not a
    // conflict.
    address: ipcAddress(PLATFORM, 'ptyhost', {
      runtime: ipcRuntimeDir(PLATFORM, process.env, home),
      tmp: os.tmpdir(),
      // Per-user, so the short-path fallback is not one name in a directory
      // every account on the machine can write to. See `ipcAddress`.
      uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    }),
    tokenPath: path.join(dataDir(PLATFORM, process.env, home), 'ptyhost.token'),
  }
}

/**
 * Makes sure a socket's directory exists and is ours alone to put things in.
 *
 * The broker's address is a well-known name, and a name in a directory anyone
 * can write to is a name anyone can take first: a squatter listening there
 * would be handed the broker token by every client that connected. Created
 * 0700 when it is ours to create; when it already exists it must belong to this
 * user and not be world-writable. Group-writable is allowed, because a umask of
 * 002 with a private group per user is an ordinary Linux setup, and the group
 * is then nobody but us.
 *
 * Throws an `EACCES` error when the directory fails the check. A no-op on
 * Windows, where the address is a named pipe and has no directory.
 */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivate(dir, true)
}

/**
 * Whether a path — the socket, or the directory holding it — is this user's.
 *
 * Used by the client before it hands over the token: a socket somebody else
 * created is not our broker, whatever its name says.
 */
export function isOwnedByUs(target: string, directory = false): boolean {
  try {
    assertPrivate(target, directory)
    return true
  } catch {
    return false
  }
}

function assertPrivate(target: string, directory: boolean): void {
  if (typeof process.getuid !== 'function') return
  const st = lstatSync(target)
  const problem =
    st.uid !== process.getuid()
      ? 'is owned by another user'
      : directory && !st.isDirectory()
        ? 'is not a directory'
        : directory && st.mode & 0o002
          ? 'is world-writable'
          : null
  if (!problem) return
  const err = new Error(`${target} ${problem}; refusing to use it for the session host`) as NodeJS.ErrnoException
  err.code = 'EACCES'
  throw err
}
