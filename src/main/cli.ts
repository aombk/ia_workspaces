import net from 'node:net'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveByAncestry, type PaneIdentity } from './pidMap'
import type { ControlRequest, ControlResponse, Method } from './controlServer'
import type { AgentChoice, PaneAgentState } from '../shared/types'

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
]

/** How long `ask` waits by default, and the most it will ever wait. */
const ASK_TIMEOUT_DEFAULT_S = 120
const ASK_TIMEOUT_MAX_S = 3600

export function isCliVerb(arg: string | undefined): boolean {
  return Boolean(arg) && VERBS.includes(arg as Method)
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

  const request = buildRequest(verb, args, identity)
  if ('error' in request) {
    process.stderr.write(`iaw: ${request.error}\n`)
    return 1
  }

  // `ask` parks on the far end until a human answers, so it must not be held
  // to the ordinary reply deadline — its whole job is to wait.
  const deadline = verb === 'ask' ? askTimeoutMs(args) + 10_000 : undefined
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
