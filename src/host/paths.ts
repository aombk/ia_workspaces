/**
 * Where the broker listens and where its shared secret lives.
 *
 * Its own module because both sides need it and they cannot share the one that
 * would otherwise hold it: `hostEntry.ts` imports node-pty, and pulling that
 * into Electron's main bundle for the sake of two path joins would be a native
 * dependency taken on for nothing.
 */
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
    }),
    tokenPath: path.join(dataDir(PLATFORM, process.env, home), 'ptyhost.token'),
  }
}
