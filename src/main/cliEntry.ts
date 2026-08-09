import os from 'node:os'
import { runCli } from './cli'
import { dataDir as platformDataDir, platformKind } from '../shared/platform'

/**
 * The `iaw` entry point, run as plain Node rather than as an Electron app.
 *
 * The shim invokes this with `ELECTRON_RUN_AS_NODE=1`, which turns the bundled
 * Electron binary into a Node runtime and skips Chromium entirely. That is not
 * only faster — it is the only way to get the exit code right.
 *
 * Booting the full Electron binary for a CLI call means Chromium parses the
 * command line first, and it treats any bare argument shaped like `scheme:rest`
 * as a URL to open. `iaw report-agent --blocked "permission: Bash(rm -rf)"` is
 * exactly that shape, and the process then exits non-zero *after* having done
 * the work correctly — so a Claude Code hook sees a failure for a call that
 * succeeded. Running as Node means no command line parsing happens at all.
 *
 * This file must never import `electron`: doing so would pull Chromium back in
 * and reintroduce the problem.
 */

// Computed rather than hardcoded, and from the same function `main.ts` uses:
// the two used to spell the path out separately, which is a drift waiting to
// happen — and a `iaw` that looks in the wrong place cannot find a single pane.
const dataDir = platformDataDir(platformKind(process.platform), process.env, os.homedir())

runCli(process.argv.slice(2), dataDir).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`iaw: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
)
