/**
 * The broker process itself.
 *
 * Started detached by the app and outliving it — that is the whole feature.
 * Nothing here imports Electron: it runs as plain Node (the packaged build
 * re-executes the app binary with `ELECTRON_RUN_AS_NODE`, exactly as the `iaw`
 * CLI already does) so that quitting the app takes Chromium down and leaves
 * this holding the shells.
 *
 * A machine restart still ends every session, here as under tmux — nothing can
 * carry a process across a reboot. What changes is everything short of one.
 */
import { spawn } from '@lydell/node-pty'
import { startHostServer } from './server'
import { hostPaths } from './paths'
import type { PtyLike, SpawnSpec } from './sessions'

function nodePtySpawner(spec: SpawnSpec): PtyLike {
  const pty = spawn(spec.file, spec.args, {
    name: 'xterm-256color',
    cols: spec.cols,
    rows: spec.rows,
    cwd: spec.cwd,
    env: spec.env,
  })
  return {
    get pid() {
      return pty.pid
    },
    write: (data) => pty.write(data),
    resize: (cols, rows) => pty.resize(cols, rows),
    kill: () => pty.kill(),
    onData: (cb) => pty.onData(cb),
    // node-pty reports a code-less exit as null despite its types; the session
    // table only ever stores what it is given, so it is normalised here.
    onExit: (cb) =>
      pty.onExit(({ exitCode, signal }) =>
        cb({ exitCode: (exitCode as number | null) ?? -1, signal })
      ),
  }
}

export function main(): void {
  const { address, tokenPath } = hostPaths()

  process.on('uncaughtException', (err) => {
    // A broker that dies takes every shell with it, so nothing here is allowed
    // to be fatal by accident. Logged and survived; the alternative is losing
    // an afternoon's work to a stray EPIPE.
    console.error('[ptyhost] uncaught', err)
  })

  const server = startHostServer({
    address,
    tokenPath,
    spawner: nodePtySpawner,
    onIdleExit: () => process.exit(0),
    onListening: () => console.log(`[ptyhost] listening on ${address} pid=${process.pid}`),
    onListenError: (err) => {
      // Another broker already owns the address. That is the ordinary outcome
      // of two app instances starting at once rather than a fault: the loser
      // exits quietly and the winner serves them both. Exit 0, because a
      // non-zero code here would have the client conclude the broker is
      // unavailable when in fact one is running perfectly well.
      const expected = err.code === 'EADDRINUSE' || err.code === 'EACCES'
      if (!expected) console.error('[ptyhost] could not listen', err)
      server.close()
      process.exit(expected ? 0 : 1)
    },
  })

  process.on('exit', () => server.close())
}

// `require.main` rather than a bare call, so the module can be imported by the
// tests without starting a real broker.
if (require.main === module) main()
