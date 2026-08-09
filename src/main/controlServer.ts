import net from 'node:net'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PaneSummary, TreeSnapshot } from './controlSurface'
import type { AgentChoice, PaneAgentState } from '../shared/types'

/**
 * The control channel between a pane's shell and the app.
 *
 * Every pane's shell gets `IAW_PANE_ID`, `IAW_PIPE` and `IAW_TOKEN`, so
 * `iaw` — including when run from an agent hook — acts on the exact pane it is
 * running in rather than on our guess from terminal output.
 *
 * It started as a notification drop. It now also carries declared agent state,
 * and one method that writes into a pane's input. That last one is why the
 * token exists: a notification arriving from the wrong process is noise, but
 * typing into somebody's shell is not, and the pipe is reachable by anything
 * running as this user. The token is handed out only through a pane's own
 * environment (and the pid map, which is equally user-private).
 */

export type Method =
  | 'ping'
  | 'notify'
  | 'report-agent'
  | 'answer-agent'
  | 'agent-state'
  | 'session'
  | 'ask'
  | 'tree'
  | 'list-panes'
  | 'send'
  | 'send-key'
  | 'read-screen'

export interface ControlRequest {
  method: Method
  paneId?: string
  title?: string
  body?: string
  /** `session`: the agent conversation id this pane is now running. */
  sessionId?: string
  blocked?: string
  unblocked?: boolean
  choices?: AgentChoice[]
  runStart?: boolean
  runEnd?: boolean
  runDepth?: number
  seq?: number
  model?: string
  contextPct?: number
  tokens?: string
  ttl?: number
  choice?: string
  /** `ask`: what to put in front of the human. */
  question?: string
  /** `ask`: how long to hold the connection open, in milliseconds. */
  timeout?: number
  /** `send`: the literal text to type into the pane. */
  text?: string
  /** `send-key`: a key name from the vocabulary in `agentState.ts`. */
  key?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  /** `read-screen`: how many lines of the tail to return. */
  lines?: number
}

export interface ControlResponse {
  ok: boolean
  error?: string
  data?:
    | PaneAgentState[]
    | { label?: string }
    | AskResult
    | TreeSnapshot
    | PaneSummary[]
    | { text: string }
}

/** What `ask` resolves to once a human has picked, or given up on it. */
export interface AskResult {
  /** The chosen choice's id, or empty when nobody answered. */
  choice: string
  label: string
  /** Why it ended, so a caller can tell a decision from a shrug. */
  outcome: 'answered' | 'abandoned'
}

/**
 * Handlers may answer later.
 *
 * Every verb but `ask` answers immediately, and returning a plain object stays
 * the normal case. `ask` is the reason for the promise: it holds its caller —
 * an agent hook, usually, with the agent itself waiting behind it — until a
 * human picks an answer.
 *
 * `onAbort` is how a handler learns the caller gave up and hung up. Without it
 * a hook killed at the keyboard would leave its pane blocked on a question
 * nobody is listening for the answer to.
 */
export type ControlHandler = (
  req: ControlRequest,
  ctx: { onAbort(fn: () => void): void }
) => ControlResponse | Promise<ControlResponse>

export interface ControlServer {
  /** What child shells should be given as `IAW_PIPE`. */
  address: string
  token: string
  close(): void
}

/** A request bigger than this is not one of ours. */
const MAX_LINE = 64 * 1024

export function startControlServer(runtime: string, handle: ControlHandler): ControlServer {
  const token = randomBytes(24).toString('hex')

  const server = net.createServer((socket) => {
    let buffer = ''
    // Responses are chained rather than written as they resolve: a handler may
    // now answer later, and two requests on one connection must still come back
    // in the order they were asked or a client cannot tell them apart.
    let queue: Promise<void> = Promise.resolve()
    // Run when the caller hangs up, so a handler still holding the request can
    // let go of it. Registered per request; cleared once it has answered.
    const aborts = new Set<() => void>()

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > MAX_LINE) {
        socket.destroy()
        return
      }
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line) continue
        queue = queue.then(async () => {
          const mine = new Set<() => void>()
          const res = await respond(line, token, handle, (fn) => {
            mine.add(fn)
            aborts.add(fn)
          })
          for (const fn of mine) aborts.delete(fn)
          if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n')
        })
      }
    })

    const abandon = () => {
      for (const fn of aborts) {
        try {
          fn()
        } catch {
          /* an abort handler must not take the connection down with it */
        }
      }
      aborts.clear()
    }
    socket.on('close', abandon)
    socket.on('error', () => {
      abandon()
      socket.destroy()
    })
  })

  server.on('error', (err) => console.error('[control] server failed', err))

  const pipeName = `\\\\.\\pipe\\iaw-${runtime}-${process.pid}`
  let address = pipeName

  try {
    server.listen(pipeName)
  } catch {
    address = ''
  }

  // A named pipe can be refused outright — some hardened policies and sandboxes
  // deny the namespace. Loopback TCP on an ephemeral port is the same trust
  // boundary (the token still gates every call) and keeps the CLI working.
  server.once('error', (err: NodeJS.ErrnoException) => {
    if (address !== pipeName) return
    if (err.code !== 'EACCES' && err.code !== 'EPERM' && err.code !== 'EADDRINUSE') return
    try {
      server.listen(0, '127.0.0.1', () => {
        const info = server.address()
        if (info && typeof info === 'object') address = `tcp:127.0.0.1:${info.port}`
      })
    } catch {
      /* no control channel this run; the app itself still works */
    }
  })

  return {
    get address() {
      return address
    },
    token,
    close: () => server.close(),
  }
}

/** Verbs that act on the whole app rather than on one pane. */
const PANELESS: ReadonlySet<Method> = new Set<Method>([
  'ping',
  'agent-state',
  'tree',
  'list-panes',
])

async function respond(
  line: string,
  token: string,
  handle: ControlHandler,
  onAbort: (fn: () => void) => void
): Promise<ControlResponse> {
  let parsed: (ControlRequest & { token?: string }) | null = null
  try {
    parsed = JSON.parse(line) as ControlRequest & { token?: string }
  } catch {
    return { ok: false, error: 'bad request' }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'bad request' }
  if (!constantTimeEqual(parsed.token ?? '', token)) return { ok: false, error: 'unauthorized' }
  // `agent-state` without a pane is a legitimate "show me every pane" query and
  // `tree` is about the whole app; the rest all act on one pane and have
  // nothing to act on without it.
  if (!PANELESS.has(parsed.method) && !parsed.paneId) return { ok: false, error: 'no pane' }

  try {
    return await handle(parsed, { onAbort })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; comparing against a same-length buffer keeps the answer uniform.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Writes the `iaw` shims and returns the folder holding them. That folder is
 * prepended to each pane's PATH, so `iaw` works inside our terminals with no
 * install step and without touching the user's system PATH.
 *
 * Two shims, because two kinds of shell look for the command. `iaw.cmd` is what
 * cmd.exe and PowerShell resolve, via PATHEXT. A POSIX shell does not consult
 * PATHEXT and will not find `iaw.cmd` under the name `iaw` — and Git Bash is
 * what Claude Code runs a hook through on Windows, so with only the .cmd every
 * `iaw notify` and `iaw session` hook died with "command not found". The
 * extensionless script is invisible to cmd.exe, which needs an extension, so
 * the two cannot shadow each other.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as a plain Node
 * runtime, which is what the CLI actually needs — it uses nothing but `net`,
 * `fs` and `path`. Booting Chromium for it would be wasteful, and worse:
 * Chromium parses the command line and treats a bare `scheme:rest` argument as
 * a URL, which makes `--blocked "permission: Bash(…)"` exit non-zero even when
 * the call succeeded. Running as Node parses nothing.
 */
/**
 * Where this runtime's `iaw` shims live.
 *
 * One folder per runtime: two copies of the app share a data
 * directory and would otherwise overwrite each other's forwarding target.
 *
 * Exported because the agent hooks we install into the user's config need the
 * absolute path, and a second copy of this join would be a second thing to keep
 * in step.
 */
export function cliShimDir(userDataPath: string, runtime: string): string {
  return path.join(userDataPath, `bin-${runtime}`)
}

/** The POSIX shim itself — what a hook command names. */
export function cliShimPath(userDataPath: string, runtime: string): string {
  return path.join(cliShimDir(userDataPath, runtime), 'iaw')
}

export function writeCliShim(
  userDataPath: string,
  runtime: string,
  execPath: string,
  cliScript: string
): string | null {
  const dir = cliShimDir(userDataPath, runtime)
  try {
    mkdirSync(dir, { recursive: true })
    const shim = [
      '@echo off',
      'setlocal',
      // The app this points at may be gone. A portable build unpacks itself
      // into a temp folder deleted when it exits, so a shim written by
      // yesterday's run names a path that no longer exists — and an agent
      // hook calling it would fail with a confusing error about a missing
      // file rather than quietly doing nothing because the app is not up.
      `if not exist "${execPath}" exit /b 0`,
      'set ELECTRON_RUN_AS_NODE=1',
      `"${execPath}" "${cliScript}" %*`,
      // `endlocal` would discard the exit code, so it is propagated explicitly.
      'endlocal & exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
    writeFileSync(path.join(dir, 'iaw.cmd'), shim, 'utf8')

    // LF endings and forward slashes: `sh` treats a CR as part of the last
    // token, and a backslash inside double quotes as an escape, so a Windows
    // path written the Windows way would survive neither.
    const posix = [
      '#!/bin/sh',
      // See the .cmd above: the shim can outlive its own executable.
      `[ -x "${execPath.replace(/\\/g, '/')}" ] || exit 0`,
      'ELECTRON_RUN_AS_NODE=1',
      'export ELECTRON_RUN_AS_NODE',
      `exec "${execPath.replace(/\\/g, '/')}" "${cliScript.replace(/\\/g, '/')}" "$@"`,
      '',
    ].join('\n')
    writeFileSync(path.join(dir, 'iaw'), posix, { encoding: 'utf8', mode: 0o755 })
    return dir
  } catch (err) {
    console.error('[control] could not write CLI shim', err)
    return null
  }
}
