/**
 * How many tokens each project has spent, counted from Claude Code's own
 * transcripts.
 *
 * The sibling of `usage.ts`, and deliberately its opposite. That one asks
 * Anthropic what is left of your *account's* limits — a network call, nothing
 * stored. This one answers "which project is eating them", and never leaves the
 * machine: Claude Code writes every conversation to
 * `~/.claude/projects/<mangled-cwd>/<session-id>.jsonl`, one JSON object per
 * line, and every assistant line carries the exact token counts the API
 * returned. Nothing is estimated and nothing is sent anywhere.
 *
 * Three decisions are worth stating outright, because each one is a bug that
 * was available to write instead.
 *
 * **Attribution is by the line's own `cwd`, not by the folder name.** The
 * folder is Claude Code's encoding of a path — `C--rootCloud-dev-ia-workspaces`
 * — and that encoding is lossy: case, separators and punctuation all collapse
 * into the same dash. Every line records the real path verbatim, so that is
 * what is counted, and a session that ran in a subfolder is attributed to the
 * subfolder rather than guessed at.
 *
 * **Reading is incremental, because the files are large and append-only.** 193
 * MB across seventy-odd transcripts on the machine this was written on, and one
 * of them 23 MB on its own. A cache keyed by size and mtime remembers the byte
 * offset already parsed, so the first scan reads everything once and every scan
 * after it reads only what has been appended since. Lines are streamed rather
 * than slurped: a transcript is not a thing to hold in memory on a laptop that
 * is already short of it.
 *
 * **A line whose `sessionId` names a *different* conversation is not counted.**
 * Forking a session copies the history into a new file, and the copies keep the
 * id of the conversation they came from — counted again, they would double the
 * bill. Only an explicitly foreign id is refused, never a missing one, so a
 * format that stops writing the field degrades to counting everything rather
 * than silently reporting zero. A plausible zero is the one answer this must
 * never give.
 */
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CACHE_MULTIPLIERS,
  priceFor,
  zeroCosts,
  type ProjectTokenUsage,
  type SessionTokenUsage,
  type TokenReport,
  type TokenTotals,
} from '../shared/types'

/** Where Claude Code keeps its transcripts, on every platform it runs on. */
function projectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** Our own record of what has already been read, beside the app's other state. */
const CACHE_NAME = 'token-usage.json'

/**
 * Bumped whenever what the cache *means* changes, rather than what it holds.
 *
 * The daily figures were once throughput and are now new tokens. A cache
 * written under the old meaning is not wrong so much as in different units, and
 * appending new-unit days to old-unit days would produce numbers that are
 * neither — visibly plausible, quietly incoherent, and impossible to spot. So a
 * cache from another version is discarded and the transcripts re-read, which
 * costs one slow scan exactly once.
 */
const CACHE_VERSION = 2

/**
 * How many days of per-day detail travel to the renderer.
 *
 * The cache keeps every day for as long as the transcript exists; the report
 * carries a month, which is all any tooltip asks for. The full history would be
 * thousands of numbers repainted every poll to answer a question nobody has.
 */
const REPORT_DAYS = 30

/** A blank set of counters. */
function zero(): TokenTotals {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 0 }
}

function add(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input
  into.output += from.output
  into.cacheWrite5m += from.cacheWrite5m
  into.cacheWrite1h += from.cacheWrite1h
  into.cacheRead += from.cacheRead
  into.messages += from.messages
}

/** Every class of token, added up: the true throughput, cache reads included. */
export function totalOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}

/**
 * The tokens that are *new* — everything except reading the cache back.
 *
 * This is the number the panel leads with, and the reason is measurable: on
 * this author's own machine cache reads were 97.5% of the total. Every turn
 * re-sends the whole conversation, so a project with 43M of genuinely new
 * material and six thousand replies reports 2.4 *billion* if you count the
 * re-reads — a real quantity that no reader has a mental slot for, and one that
 * invites the question "does that make any sense?" rather than answering it.
 *
 * The re-reads are not hidden: they are a tenth of the price precisely because
 * they are re-reads, they are in the breakdown, and they are what the cost
 * figure is mostly made of. They are just the wrong thing to put on a badge.
 */
export function newOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h
}

/** What one transcript contributed, remembered between runs. */
interface FileCache {
  size: number
  mtimeMs: number
  /** Bytes already parsed. Only whole lines count towards it. */
  offset: number
  /** Totals per folder, then per model. A session that never `cd`s has one of each. */
  byCwd: Record<string, Record<string, TokenTotals>>
  /** New tokens per local day, `YYYY-MM-DD` — the headline figure, not the throughput. */
  days: Record<string, number>
  /** Most recent line's timestamp, in ms. */
  lastAt: number | null
}

type Cache = Record<string, FileCache>

let cache: Cache | null = null
let cachePath: string | null = null
/** One scan at a time; a second caller waits for the first rather than racing it. */
let inFlight: Promise<TokenReport> | null = null

/**
 * The report, scanning only what has changed since the last one.
 *
 * `dataDir` is the app's own state folder, where the offsets are remembered so
 * a restart does not re-read 193 MB.
 */
export function readTokenUsage(dataDir: string): Promise<TokenReport> {
  if (inFlight) return inFlight
  inFlight = scan(dataDir).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function scan(dataDir: string): Promise<TokenReport> {
  cachePath = path.join(dataDir, CACHE_NAME)
  if (!cache) cache = await loadCache(cachePath)

  const root = projectsDir()
  let files: string[]
  try {
    files = await transcripts(root)
  } catch {
    // No `~/.claude/projects` at all: Claude Code has never run here. That is
    // an answer, not a failure — and a different one from "we could not look".
    return { status: 'none', projects: [], sessions: [], scannedAt: Date.now() }
  }

  const live = new Set(files)
  let touched = false

  for (const file of files) {
    try {
      if (await readFileInto(file)) touched = true
    } catch {
      // One unreadable transcript is not a reason to report nothing. It simply
      // contributes what it contributed last time, or nothing at all.
    }
  }

  // Transcripts the user has deleted stop being counted, and stop being
  // remembered. Otherwise the cache is a museum of every conversation ever had.
  for (const known of Object.keys(cache)) {
    if (!live.has(known)) {
      delete cache[known]
      touched = true
    }
  }

  if (touched) void saveCache()

  return build(files)
}

/** Every `*.jsonl` one level under `projects/`, which is where they all live. */
async function transcripts(root: string): Promise<string[]> {
  const out: string[] = []
  for (const dir of await readdir(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const inside = path.join(root, dir.name)
    let entries
    try {
      entries = await readdir(inside, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path.join(inside, entry.name))
    }
  }
  return out
}

/**
 * Reads whatever has been appended to one transcript since last time.
 *
 * Returns whether anything changed, so an idle poll writes no cache file.
 */
async function readFileInto(file: string): Promise<boolean> {
  const info = await stat(file)
  const known = cache![file]

  // Untouched since the last scan. Size *and* mtime, because a file rewritten
  // to the same length is a file to re-read.
  if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return false

  // Shrunk, which means rewritten rather than appended to. The offsets we hold
  // are about a file that no longer exists, so it is counted again from zero.
  const entry: FileCache =
    known && info.size >= known.offset
      ? known
      : { size: 0, mtimeMs: 0, offset: 0, byCwd: {}, days: {}, lastAt: null }

  // The conversation this file *is*, by its name. A line claiming a different
  // one is history copied in from a fork — see the note at the top.
  const own = path.basename(file, '.jsonl')

  let consumed = entry.offset
  let leftover = ''
  const stream = createReadStream(file, { start: entry.offset, encoding: 'utf8' })

  for await (const chunk of stream) {
    const text = leftover + (chunk as string)
    const lines = text.split('\n')
    // The last piece may be half a line the writer has not finished. It is held
    // back, and its bytes are not counted as read.
    leftover = lines.pop() ?? ''
    for (const line of lines) {
      consumed += Buffer.byteLength(line, 'utf8') + 1
      if (!line) continue
      // Cheap before expensive: most lines in a transcript are user turns and
      // tool results, and `JSON.parse` on all 193 MB of them is the whole cost
      // of the first scan. Only lines that could carry counters are parsed.
      if (!line.includes('"output_tokens"')) continue
      take(entry, line, own)
    }
  }

  entry.offset = consumed
  entry.size = info.size
  entry.mtimeMs = info.mtimeMs
  cache![file] = entry
  return true
}

/** One transcript line, counted if it is an assistant turn of this conversation. */
function take(entry: FileCache, line: string, own: string): void {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return
  }

  const usage = row?.message?.usage
  if (!usage || typeof usage.output_tokens !== 'number') return

  // Only an *explicitly different* id is refused. Absent is counted: a format
  // that stops writing the field must not silently zero every project.
  const said = row?.sessionId
  if (typeof said === 'string' && said && said !== own) return

  const cwd = typeof row?.cwd === 'string' && row.cwd ? row.cwd : '(unknown)'
  const model = typeof row?.message?.model === 'string' ? row.message.model : '(unknown)'

  const byModel = (entry.byCwd[cwd] ??= {})
  const totals = (byModel[model] ??= zero())

  const cacheCreation = usage.cache_creation ?? {}
  // The two cache-write windows are kept apart because they are priced apart —
  // an hour's cache costs 2x input, five minutes' 1.25x. Older transcripts have
  // only the flat total, which is taken as the five-minute kind, that being what
  // Claude Code wrote before the long window existed.
  const write1h = num(cacheCreation.ephemeral_1h_input_tokens)
  const write5m = num(cacheCreation.ephemeral_5m_input_tokens)
  const writeTotal = num(usage.cache_creation_input_tokens)

  const one: TokenTotals = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheWrite1h: write1h,
    cacheWrite5m: write5m || Math.max(0, writeTotal - write1h),
    cacheRead: num(usage.cache_read_input_tokens),
    messages: 1,
  }
  add(totals, one)

  const at = Date.parse(row?.timestamp ?? '')
  if (Number.isFinite(at)) {
    const key = dayKey(at)
    // New tokens, matching what the panel shows. A day counted as throughput
    // beside a headline counted without re-reads is two units in one row.
    entry.days[key] = (entry.days[key] ?? 0) + newOf(one)
    if (entry.lastAt === null || at > entry.lastAt) entry.lastAt = at
  }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** `YYYY-MM-DD` in the machine's own timezone, which is the day the user had. */
function dayKey(ms: number): string {
  const at = new Date(ms)
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

/** The cache, folded into the shape the renderer draws. */
function build(files: string[]): TokenReport {
  const projects = new Map<string, ProjectTokenUsage>()
  const sessions: SessionTokenUsage[] = []
  const cutoff = Date.now() - REPORT_DAYS * 24 * 60 * 60 * 1000
  const earliest = dayKey(cutoff)

  for (const file of files) {
    const entry = cache![file]
    if (!entry) continue

    const session: SessionTokenUsage = {
      id: path.basename(file, '.jsonl'),
      cwd: '',
      totals: zero(),
      cost: 0,
      lastAt: entry.lastAt,
    }

    for (const [cwd, byModel] of Object.entries(entry.byCwd)) {
      let project = projects.get(cwd)
      if (!project) {
        project = {
          cwd,
          totals: zero(),
          byModel: {},
          days: {},
          cost: 0,
          costs: zeroCosts(),
          unpricedModels: [],
          lastAt: null,
        }
        projects.set(cwd, project)
      }
      for (const [model, totals] of Object.entries(byModel)) {
        add(project.totals, totals)
        add((project.byModel[model] ??= zero()), totals)
        add(session.totals, totals)
      }
      // A session's folder is whichever one it started in; a conversation that
      // wandered is still one conversation, and belongs to one project.
      if (!session.cwd) session.cwd = cwd
      if (project.lastAt === null || (entry.lastAt ?? 0) > project.lastAt) {
        project.lastAt = entry.lastAt
      }
    }

    // A file that spans two folders is rare enough that splitting its days
    // between them would be precision nobody sees; the first folder takes them.
    const dayOwner = session.cwd ? projects.get(session.cwd) : undefined
    if (dayOwner) {
      for (const [day, tokens] of Object.entries(entry.days)) {
        if (day < earliest) continue
        dayOwner.days[day] = (dayOwner.days[day] ?? 0) + tokens
      }
    }

    if (session.totals.messages) {
      session.cost = priceOf(sessionModels(entry)).cost
      sessions.push(session)
    }
  }

  for (const project of projects.values()) {
    const priced = priceOf(project.byModel)
    project.cost = priced.cost
    project.costs = priced.costs
    project.unpricedModels = priced.unpriced
  }

  const list = [...projects.values()].sort((a, b) => totalOf(b.totals) - totalOf(a.totals))
  return {
    status: list.length ? 'ok' : 'none',
    projects: list,
    sessions,
    scannedAt: Date.now(),
  }
}

function sessionModels(entry: FileCache): Record<string, TokenTotals> {
  const out: Record<string, TokenTotals> = {}
  for (const byModel of Object.values(entry.byCwd)) {
    for (const [model, totals] of Object.entries(byModel)) add((out[model] ??= zero()), totals)
  }
  return out
}

/**
 * What this would have cost on the API, split by token class.
 *
 * "Would have", said plainly, because a subscription does not bill per token —
 * see `MODEL_PRICES`. A model with no published price contributes nothing to the
 * figure and its name to the list, so the panel can say the estimate is partial
 * rather than quietly under-reporting it.
 *
 * Split by class because the total on its own is not checkable. Anthropic
 * publishes five columns and this produces four numbers that map onto them, so
 * anyone who wants to know where $1,600 came from can see that most of it was
 * cache hits at ten cents on the dollar rather than having to take it on faith.
 */
function priceOf(byModel: Record<string, TokenTotals>): {
  cost: number
  costs: ReturnType<typeof zeroCosts>
  unpriced: string[]
} {
  const costs = zeroCosts()
  const unpriced: string[] = []

  for (const [model, totals] of Object.entries(byModel)) {
    const price = priceFor(model)
    if (!price) {
      if (totalOf(totals) > 0) unpriced.push(model)
      continue
    }
    const per = (tokens: number, rate: number) => (tokens * rate) / 1_000_000
    costs.input += per(totals.input, price.input)
    costs.output += per(totals.output, price.output)
    costs.cacheWrite5m += per(totals.cacheWrite5m, price.input * CACHE_MULTIPLIERS.write5m)
    costs.cacheWrite1h += per(totals.cacheWrite1h, price.input * CACHE_MULTIPLIERS.write1h)
    costs.cacheRead += per(totals.cacheRead, price.input * CACHE_MULTIPLIERS.read)
  }

  return {
    cost:
      costs.input + costs.cacheWrite5m + costs.cacheWrite1h + costs.cacheRead + costs.output,
    costs,
    unpriced,
  }
}

async function loadCache(file: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.version !== CACHE_VERSION || typeof parsed.files !== 'object') return {}
    return (parsed.files ?? {}) as Cache
  } catch {
    // No cache, a corrupt one, or one from a version whose numbers meant
    // something else. Either way the next scan rebuilds it from the
    // transcripts, which are the only source of truth here.
    return {}
  }
}

async function saveCache(): Promise<void> {
  if (!cachePath || !cache) return
  try {
    await writeFile(cachePath, JSON.stringify({ version: CACHE_VERSION, files: cache }), 'utf8')
  } catch {
    // Failing to remember costs one slow scan next time, and nothing else.
  }
}
