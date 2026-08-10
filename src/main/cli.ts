import net from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveByAncestry, type PaneIdentity } from './pidMap'
import type { ControlRequest, ControlResponse, Method } from './controlServer'
import type { AgentChoice, PaneAgentState } from '../shared/types'
import { hostPaths } from '../host/paths'
import {
  FRAME_JSON,
  FrameReader,
  PROTOCOL_VERSION,
  decodeJson,
  encodeJson,
  type HostMessage,
  type SessionSummary,
} from '../host/protocol'

/**
 * `iaw` — the command a pane's shell (or an agent hook running inside it) uses
 * to talk back to the app.
 *
 * The same executable is the app and the CLI, so this runs instead of booting a
 * window when the first argument is a known verb.
 */

const USAGE = `iaw — talk to the ia_workspaces pane you are running in

  iaw notify --title T --body B         raise an alert on this pane
  iaw session [--id ID]                 record the agent conversation this pane
                                        is running, so reopening the app can
                                        resume it. With no --id the id is read
                                        from the hook JSON on stdin.
  iaw report-agent [options]            declare what this agent is doing
  iaw ask --question Q --choices C      ask, and wait here for the answer
  iaw answer-agent [--pane ID] --choice C   answer a blocked pane
  iaw agent-state [--pane ID]           print declared state as JSON
  iaw ping                              check the app is listening

  --quiet on any verb turns "there was nothing to talk to" into silence and a
  zero exit. The installed agent hooks use it: they fire whether or not this app
  is running, and an optional notification that could not be delivered is not a
  failure worth putting in front of you.

looking around
  iaw tree                              every workspace, tab and pane, as JSON
  iaw list-panes [--pane ID]            the same panes, flat — no --pane for all
  iaw read-screen [--lines N]           what a pane has printed lately, as text
  iaw send --text "npm test"            type into a pane (add --enter to run it)
  iaw send-key <key> [--ctrl] [--alt]   send one key, e.g. send-key c --ctrl
  iaw events [--after N] [--follow]     what has happened, as JSON

the session host

  iaw host                              is it running, and what is it holding
  iaw host stop                         stop it — ends every shell it holds

  Shells outlive the app because a small background process owns them. It is
  this app's own executable re-run as Node, so it shows up under the same name
  and holds that file open — which is what stops an installer replacing it.
  It exits by itself once it holds nothing; stop it by hand when you want to
  install an update without waiting.

reaching another machine's instance
  iaw bridge [--port N]                 relay this app's control channel onto
                                        127.0.0.1:N, so the whole CLI works
                                        against it through an ssh -L tunnel
  iaw token                             print the token a remote caller needs

  The relay binds to loopback only and adds no authority of its own: every
  request still carries the token, and the app still refuses without it. What
  it does change is who can try — anything able to reach that port can attempt
  calls, and "send" will type into a shell for whoever holds the token. Forward
  it over ssh rather than exposing the port, and treat the token as the password
  it is.

events options
  --after N             only events after this seq (from a previous reply)
  --boot ID             the boot the cursor came from, so a restart is detected
  --categories a,b      pane, agent, alert, activity, host
  --lines N             most events to return (default 500)
  --follow [SECONDS]    wait for one rather than returning an empty page
  --cursor-file PATH    read --after/--boot from here, and write them back

  A reader that keeps its place gets reconnection for free: point
  --cursor-file at a file and loop. "gap": true in the reply means the ring had
  already discarded what you asked for and events were missed — which is worth
  knowing, and is why it is reported rather than papered over.

ask options
  --question "text"     what the human is being asked
  --choices '<json>'    the answers, same shape as report-agent's
  --choices @<file>     the same, read from a file
  --timeout SECONDS     give up after this long (default 120, max 3600)
  --json                print {"choice","label","outcome"} instead of the bare id

  ask blocks until somebody picks an answer, then prints the chosen id and
  exits 0. Nobody answering — a timeout, or the pane closing — prints nothing
  and exits 2, so a caller can tell a decision from a shrug. The answer comes
  back down this connection rather than being typed into the terminal, so it
  does not matter what the pane is showing or whether it is even on screen.

report-agent options
  --blocked "reason"    parked on a human until answered
  --choices '<json>'    answers to offer: [{"id","label","key"|"text","isDefault"}]
  --choices @<file>     the same, read from a file — use this from a hook, where
                        cmd.exe eats the quotes out of inline JSON
  --unblocked           the human answered
  --run-start           a turn began   (refcount: nested subagents nest)
  --run-end             a turn ended
  --run-depth N         set the refcount outright
  --seq N               drop replayed reports older than this
  --model M  --context-pct N  --tokens T  --ttl MS

The pane is taken from IAW_PANE_ID, or found by walking up the process tree
when something dropped the environment. --pane overrides both.
`

const VERBS: Method[] = [
  'ping',
  'notify',
  'report-agent',
  'ask',
  'answer-agent',
  'agent-state',
  'session',
  'tree',
  'list-panes',
  'send',
  'send-key',
  'read-screen',
  'events',
]

/** How long `ask` waits by default, and the most it will ever wait. */
const ASK_TIMEOUT_DEFAULT_S = 120
const ASK_TIMEOUT_MAX_S = 3600

/**
 * Verbs this process handles itself rather than forwarding.
 *
 * Kept apart from `VERBS` because those are typed as control-server methods and
 * these are not: nothing on the far end knows the words `bridge` or `token`.
 */
const LOCAL_VERBS = ['bridge', 'token', 'host'] as const
type LocalVerb = (typeof LOCAL_VERBS)[number]

export function isCliVerb(arg: string | undefined): boolean {
  return (
    Boolean(arg) &&
    (VERBS.includes(arg as Method) || LOCAL_VERBS.includes(arg as LocalVerb))
  )
}

export async function runCli(argv: string[], userDataPath: string): Promise<number> {
  const verb = argv[0] as Method
  if (!isCliVerb(verb)) {
    process.stdout.write(USAGE)
    return verb ? 1 : 0
  }

  const args = parseArgs(argv.slice(1))
  // Claude Code hands a hook its context as JSON on stdin, which is where the
  // session id lives. --id stays available so the verb is testable by hand.
  if (verb === 'session' && !args.id) {
    args.id = (await readHookField('session_id')) ?? undefined
  }
  // Before identity: this one talks to the broker rather than the app, and its
  // whole purpose is to work when the app is not running.
  if ((verb as string) === 'host') return runHost(args)

  const identity = resolveIdentity(args, userDataPath)
  if (!identity) {
    // `--quiet` is what the installed agent hooks use. A hook fires on every
    // Stop, from whatever shell the agent was started in, and this app may not
    // be running at all — reporting that as a failure puts a wall of hook
    // errors in the agent's own output for something entirely optional. A
    // notification nobody can receive is not an error; it is nothing happening.
    if (args.quiet) return 0
    process.stderr.write('iaw: not running inside an ia_workspaces terminal\n')
    return 1
  }

  // Handled here, because the far end has never heard of them.
  if ((verb as string) === 'token') {
    process.stdout.write(identity.token + '\n')
    return 0
  }
  if ((verb as string) === 'bridge') return runBridge(identity, args)

  const request = buildRequest(verb, args, identity)
  if ('error' in request) {
    process.stderr.write(`iaw: ${request.error}\n`)
    return 1
  }

  // `ask` parks on the far end until a human answers, so it must not be held
  // to the ordinary reply deadline — its whole job is to wait.
  // Two verbs park on the far end rather than answering at once, and neither
  // may be held to the ordinary reply deadline — waiting is their whole job.
  // `ask` waits for a human; `events --follow` waits for something to happen.
  const followMs = request.value.follow
  const deadline =
    verb === 'ask'
      ? askTimeoutMs(args) + 10_000
      : followMs
        ? followMs + 10_000
        : undefined
  const res = await send(identity, request.value, deadline)
  if (!res.ok) {
    // Same bargain as above: a pane that has since closed, or an app that has
    // since quit, is not something an agent hook should shout about.
    if (args.quiet) return 0
    process.stderr.write(`iaw: ${res.error ?? 'failed'}\n`)
    return 1
  }

  if (verb === 'agent-state' || verb === 'tree' || verb === 'list-panes') {
    process.stdout.write(JSON.stringify(res.data ?? [], null, 2) + '\n')
  } else if (verb === 'events') {
    const page = res.data as
      | { boot?: string; cursor?: number; gap?: boolean; events?: unknown[] }
      | undefined
    // The cursor is written back before printing, so a reader whose pipe closes
    // mid-write — `iaw events | head` — still records where it got to rather
    // than replaying the same page on its next run.
    writeCursorFile(args['cursor-file'], page?.boot, page?.cursor)
    process.stdout.write(JSON.stringify(page ?? { events: [] }, null, 2) + '\n')
  } else if (verb === 'read-screen') {
    const text = (res.data as { text?: string } | undefined)?.text ?? ''
    // No trailing newline of our own when the capture already ends in one.
    process.stdout.write(text.endsWith('\n') || !text ? text : text + '\n')
  } else if (verb === 'answer-agent') {
    const label = (res.data as { label?: string } | undefined)?.label
    process.stdout.write(`answered${label ? `: ${label}` : ''}\n`)
  } else if (verb === 'ask') {
    const result = res.data as
      | { choice?: string; label?: string; outcome?: string }
      | undefined
    if (!result?.choice) {
      // Nothing on stdout: a caller reading this to decide something must not
      // be handed an empty string that looks like an answer.
      process.stderr.write('iaw: nobody answered\n')
      return 2
    }
    process.stdout.write(
      (args.json ? JSON.stringify(result) : result.choice) + '\n'
    )
  }
  return 0
}

/**
 * Where a follower left off, so reconnection is a flag rather than a client.
 *
 * The boot id travels with the cursor because a cursor alone is meaningless
 * against a different process — a reader holding seq 900 across a restart would
 * otherwise be told "nothing new" by a log that has only reached 12.
 */
function readCursorFile(file: string | undefined): { cursor: number; boot?: string } | null {
  if (!file) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { cursor?: number; boot?: string }
    return typeof parsed.cursor === 'number' ? { cursor: parsed.cursor, boot: parsed.boot } : null
  } catch {
    // Absent or unreadable means "start from the beginning", which is the right
    // answer for a first run and a harmless one for a corrupt file.
    return null
  }
}

function writeCursorFile(file: string | undefined, boot: string | undefined, cursor: number | undefined): void {
  if (!file || typeof cursor !== 'number') return
  try {
    writeFileSync(file, JSON.stringify({ boot, cursor }) + '\n', 'utf8')
  } catch {
    // A cursor we cannot persist costs a replay, not a run.
  }
}

/** The ask deadline in milliseconds, clamped to something sane. */
function askTimeoutMs(args: Args): number {
  const raw = Number(args.timeout)
  const seconds =
    Number.isFinite(raw) && raw > 0 ? Math.min(raw, ASK_TIMEOUT_MAX_S) : ASK_TIMEOUT_DEFAULT_S
  return Math.round(seconds * 1000)
}

// ------------------------------------------------------------------ identity

/**
 * Environment first, because it is exact and free.
 *
 * The tree walk is the fallback for the case the environment cannot cover:
 * Claude Code does not pass its own environment to MCP servers it spawns, and a
 * detached child or a task runner can lose it too. Those processes are still
 * *descendants* of the pane's shell, which is what the pid map records.
 */
/**
 * Reports on the session broker, and stops it.
 *
 * Talks to the broker directly rather than through the app: it is a separate
 * process with its own socket and its own token, and the whole point of it is
 * that it is there when the app is not.
 *
 * `stop` exists because of a problem the broker creates. It is this app's own
 * executable re-run as Node, so it appears in Task Manager under the same name
 * as the app and — the part that actually bites — it holds that executable open,
 * which stops an installer replacing it. Quitting the app is no longer enough
 * to release it, and "kill the thing that looks like your app" is not an
 * instruction anybody should have to work out for themselves.
 *
 * Stopping ends every shell it holds. There is no gentler version: the shells
 * are its children and they go with it. So it says how many first.
 */
async function runHost(args: Args): Promise<number> {
  const { address, tokenPath } = hostPaths()

  let token: string
  try {
    token = readFileSync(tokenPath, 'utf8').trim()
  } catch {
    process.stdout.write('no session host is running\n')
    return 0
  }

  const socket = await new Promise<net.Socket | null>((resolve) => {
    const s = connect(address)
    s.once('connect', () => resolve(s))
    s.once('error', () => {
      s.destroy()
      resolve(null)
    })
  })
  if (!socket) {
    // A token file with nothing behind it is what a crash leaves. Saying so
    // beats reporting a connection error nobody can act on.
    process.stdout.write('no session host is running\n')
    return 0
  }

  const replies = new Map<number, (m: HostMessage) => void>()
  let ref = 0
  const reader = new FrameReader((kind, payload) => {
    if (kind !== FRAME_JSON) return
    const message = decodeJson(payload) as HostMessage | null
    if (!message) return
    const settle = replies.get((message as { ref?: number }).ref ?? -1)
    if (settle) settle(message)
  }, () => socket.destroy())
  socket.on('data', (chunk) => reader.push(chunk))

  const ask = (message: Record<string, unknown>): Promise<HostMessage> =>
    new Promise((resolve) => {
      const id = ++ref
      replies.set(id, resolve)
      socket.write(encodeJson({ ...message, ref: id } as never))
      // A broker that stops mid-request is the expected outcome of `stop`, not
      // a fault: it answers and then closes, and the close can win the race.
      socket.once('close', () => resolve({ t: 'ok', ref: id }))
    })

  const hello = await ask({ t: 'hello', token, protocol: PROTOCOL_VERSION })
  if (hello.t !== 'hello') {
    process.stderr.write(`iaw: ${hello.t === 'error' ? hello.message : 'unexpected greeting'}\n`)
    socket.destroy()
    return 1
  }
  const pid = hello.pid

  const listed = await ask({ t: 'list' })
  const sessions = (listed.t === 'ok' ? (listed.data as SessionSummary[]) : []) ?? []
  const alive = sessions.filter((s) => s.alive)

  if ((args._ ?? 'status') !== 'stop') {
    process.stdout.write(
      `session host running — pid ${pid}, ${alive.length} shell${alive.length === 1 ? '' : 's'}\n` +
        `  ${address}\n` +
        (alive.length
          ? alive.map((s) => `  ${s.id}  pid ${s.pid || '—'}\n`).join('')
          : '  nothing held; it will exit on its own\n')
    )
    socket.destroy()
    return 0
  }

  await ask({ t: 'shutdown' })
  socket.destroy()
  process.stdout.write(
    alive.length
      ? `session host stopped — ended ${alive.length} shell${alive.length === 1 ? '' : 's'}\n`
      : 'session host stopped\n'
  )
  return 0
}

/** Where the relay listens when `--port` is not given. */
const BRIDGE_PORT = 7717

/**
 * Relays the app's control channel onto loopback TCP.
 *
 * The control channel is a named pipe on Windows and a unix socket on POSIX,
 * and neither travels down an `ssh -L` tunnel — that forwards TCP. So this is a
 * pipe-to-socket splice and nothing more: bytes in, bytes out, in both
 * directions, one upstream connection per inbound one.
 *
 * It deliberately adds no authority. Every request still carries the token and
 * the app still refuses without it, so the relay cannot do anything a local
 * caller could not. What it changes is *who can try*, which is why it binds to
 * 127.0.0.1 and says so: the intended use is `ssh -L 7717:127.0.0.1:7717`,
 * where the tunnel is the authentication and the port is never on a network.
 *
 * Runs until interrupted. There is nothing to poll and nothing to clean up —
 * closing the terminal takes it with it.
 */
function runBridge(identity: PaneIdentity, args: Args): Promise<number> {
  const port = Number(args.port) || BRIDGE_PORT
  return new Promise((resolve) => {
    const server = net.createServer((inbound) => {
      inbound.setNoDelay(true)
      const upstream = connect(identity.pipe)
      upstream.setNoDelay(true)
      // Either half failing takes the pair down: a half-open splice would leave
      // a caller waiting for a reply that can never arrive.
      const drop = () => {
        inbound.destroy()
        upstream.destroy()
      }
      inbound.on('error', drop)
      upstream.on('error', drop)
      inbound.pipe(upstream)
      upstream.pipe(inbound)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      const why =
        err.code === 'EADDRINUSE'
          ? `port ${port} is already in use — pass --port to pick another`
          : err.message
      process.stderr.write(`iaw: ${why}\n`)
      resolve(1)
    })

    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(
        `iaw: relaying ${identity.pipe} on 127.0.0.1:${port}\n` +
          `     forward it with:  ssh -L ${port}:127.0.0.1:${port} <host>\n` +
          `     then on the far side:  IAW_PIPE=tcp:127.0.0.1:${port} IAW_TOKEN=$(iaw token) iaw tree\n` +
          `     loopback only, token still required. Ctrl+C to stop.\n`
      )
    })

    const stop = () => {
      server.close()
      resolve(0)
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}

function resolveIdentity(args: Args, userDataPath: string): PaneIdentity | null {
  const pipe = args.pipe ?? process.env.IAW_PIPE
  const token = process.env.IAW_TOKEN
  const paneId = args.pane ?? process.env.IAW_PANE_ID

  if (paneId && pipe && token) {
    return { paneId, workspaceId: process.env.IAW_WORKSPACE_ID ?? '', pipe, token }
  }

  const found = resolveByAncestry(path.join(userDataPath, 'pid-map'))
  if (!found) return null
  // An explicit --pane still wins: answering another pane is the whole point of
  // answer-agent, and only the transport needs to come from our own ancestry.
  return args.pane ? { ...found, paneId: args.pane } : found
}

// ------------------------------------------------------------------- request

type Built = { value: ControlRequest & { token: string } } | { error: string }

function buildRequest(method: Method, args: Args, identity: PaneIdentity): Built {
  const base = { method, token: identity.token, paneId: identity.paneId }

  switch (method) {
    case 'ping':
      return { value: base }

    case 'notify':
      return {
        value: { ...base, title: args.title ?? 'Terminal', body: args.body ?? '' },
      }

    case 'session':
      if (!args.id) return { error: 'no session id (pass --id, or pipe the hook JSON in)' }
      return { value: { ...base, sessionId: args.id } }

    case 'ask': {
      if (!args.choices) return { error: 'ask needs --choices' }
      const parsed = parseChoices(args.choices)
      if ('error' in parsed) return parsed
      return {
        value: {
          ...base,
          question: args.question ?? '',
          choices: parsed.value,
          timeout: askTimeoutMs(args),
        },
      }
    }

    case 'answer-agent':
      return { value: { ...base, choice: args.choice } }

    case 'agent-state':
      // No --pane means every pane, which is how you find the stuck one.
      return { value: { ...base, paneId: args.pane } }

    case 'tree':
      return { value: { ...base, paneId: undefined } }

    case 'list-panes':
      // Same rule as agent-state: named pane or the lot.
      return { value: { ...base, paneId: args.pane } }

    case 'read-screen':
      return { value: { ...base, lines: Number(args.lines) || 100 } }

    case 'events': {
      const saved = readCursorFile(args['cursor-file'])
      const after = args.after !== undefined ? Number(args.after) : saved?.cursor
      // `--follow` with no cursor would return the entire ring and then claim
      // to be following from the end of it. Asking for the current position
      // first is one extra round trip and removes the surprise.
      const follow = 'follow' in args ? Math.max(1, Number(args.follow) || 30) * 1000 : undefined
      return {
        value: {
          ...base,
          after: Number.isFinite(after) ? after : undefined,
          boot: args.boot ?? saved?.boot,
          categories: args.categories,
          lines: args.lines ? Number(args.lines) : undefined,
          follow: after === undefined ? undefined : follow,
        },
      }
    }

    case 'send': {
      const text = args.text ?? args._
      if (text === undefined) return { error: 'send needs some text' }
      // Enter is opt-in. Putting a line on a prompt and running it are
      // different acts, and a caller that meant to run something can say so.
      return { value: { ...base, text: args.enter ? text + '\r' : text } }
    }

    case 'send-key': {
      const key = args.key ?? args._
      if (!key) return { error: 'send-key needs a key name' }
      return {
        value: {
          ...base,
          key,
          ctrl: Boolean(args.ctrl),
          shift: Boolean(args.shift),
          alt: Boolean(args.alt),
        },
      }
    }

    case 'report-agent': {
      const report: ControlRequest & { token: string } = { ...base }
      if ('blocked' in args) report.blocked = args.blocked === 'true' ? '' : (args.blocked ?? '')
      if (args.choices) {
        const parsed = parseChoices(args.choices)
        if ('error' in parsed) return parsed
        report.choices = parsed.value
      }
      if (args.unblocked) report.unblocked = true
      if (args['run-start']) report.runStart = true
      if (args['run-end']) report.runEnd = true
      if (args['run-depth'] !== undefined) report.runDepth = Number(args['run-depth'])
      if (args.seq !== undefined) report.seq = Number(args.seq)
      if (args.model !== undefined) report.model = args.model
      if (args['context-pct'] !== undefined) report.contextPct = Number(args['context-pct'])
      if (args.tokens !== undefined) report.tokens = args.tokens
      if (args.ttl !== undefined) report.ttl = Number(args.ttl)
      return { value: report }
    }
  }
}

/**
 * Reads the choices argument, as JSON or as `@path` to a file holding it.
 *
 * The file form exists because the main consumer is a hook command string, and
 * a Windows command line is a hostile place for JSON: `cmd.exe` strips the
 * double quotes on the way through, so the literal form only survives if every
 * layer between the hook and here escapes it correctly. Pointing at a file
 * sidesteps the quoting entirely.
 */
function parseChoices(raw: string): { value: AgentChoice[] } | { error: string } {
  let text = raw
  if (raw.startsWith('@')) {
    try {
      text = readFileSync(raw.slice(1), 'utf8')
    } catch {
      return { error: `could not read ${raw.slice(1)}` }
    }
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return { error: '--choices must be a JSON array' }
    return { value: parsed as AgentChoice[] }
  } catch {
    return {
      error: raw.startsWith('@')
        ? `${raw.slice(1)} does not contain valid JSON`
        : '--choices is not valid JSON (quotes are easily lost on a Windows command line — try --choices @<file>)',
    }
  }
}

// --------------------------------------------------------------- hook stdin

/**
 * Reads one field out of the JSON a hook is given on stdin.
 *
 * Bounded on both ends: a hook's payload is small, and a shell that leaves
 * stdin open would otherwise hang the hook — and with it the agent — forever.
 * Anything unreadable resolves to null, because a missing session id must
 * degrade to "no resume", never to a stuck Claude Code.
 */
function readHookField(field: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null)
      return
    }

    let text = ''
    let settled = false
    const done = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.pause()
      resolve(value)
    }

    const timer = setTimeout(() => done(null), 2000)

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      if (text.length > 256 * 1024) done(null)
    })
    process.stdin.on('error', () => done(null))
    process.stdin.on('end', () => {
      try {
        const value = (JSON.parse(text) as Record<string, unknown>)[field]
        done(typeof value === 'string' && value ? value : null)
      } catch {
        done(null)
      }
    })
  })
}

// ----------------------------------------------------------------- transport

/**
 * `timeoutMs` is how long to wait for a reply. Every verb but `ask` answers at
 * once and takes the short default; `ask` is deliberately allowed to sit there,
 * because a human being slow is the expected case rather than a fault.
 */
function send(
  identity: PaneIdentity,
  request: object,
  timeoutMs = 5000
): Promise<ControlResponse> {
  return new Promise((resolve) => {
    const socket = connect(identity.pipe)
    const done = (res: ControlResponse) => {
      socket.destroy()
      resolve(res)
    }

    socket.setTimeout(timeoutMs, () => done({ ok: false, error: 'timed out' }))
    socket.on('error', (err) => done({ ok: false, error: err.message }))
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk) => {
      try {
        done(JSON.parse(chunk.toString('utf8').split('\n')[0]) as ControlResponse)
      } catch {
        done({ ok: false, error: 'bad response' })
      }
    })
  })
}

/** `tcp:host:port` is the fallback the server falls back to; the rest are pipes. */
function connect(address: string): net.Socket {
  const m = /^tcp:([^:]+):(\d+)$/.exec(address)
  return m ? net.createConnection({ host: m[1], port: Number(m[2]) }) : net.createConnection(address)
}

// ---------------------------------------------------------------------- args

type Args = Record<string, string | undefined>

/**
 * Flags, plus the first bare argument under `_`.
 *
 * The positional exists so the verbs that take one obvious value read the way
 * you would write them — `iaw send-key c --ctrl`, `iaw send "npm test"` — while
 * the explicit `--key` and `--text` stay available for anything generating the
 * command, where a value starting with a dash would otherwise be read as a flag.
 */
function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      if (out._ === undefined) out._ = arg
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) out[arg.slice(2, eq)] = arg.slice(eq + 1)
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[arg.slice(2)] = argv[++i]
    else out[arg.slice(2)] = 'true'
  }
  return out
}

export type { PaneAgentState }
