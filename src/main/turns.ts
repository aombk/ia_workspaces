/**
 * What you asked the agent, and what it did about it — one record per prompt.
 *
 * The sibling of `tokenUsage.ts`, over the same files and deliberately at a
 * different altitude. That one answers "which project is eating the tokens" and
 * throws the conversation away; this one keeps the conversation and throws
 * almost nothing away, because the questions it exists for are *"what did I ask
 * about this in June"*, *"which files has this agent been reading"* and *"what
 * did that last turn actually cost"*. Three features, one record, because they
 * are three readings of the same fact and a second scan of 66 MB to answer the
 * second question would be a second scan that can disagree with the first.
 *
 * **A human turn, not a message.** One prompt can produce forty replies and
 * four hundred tool calls and it is still one thing you asked for. Everything
 * between one human prompt and the next is summed onto it.
 *
 * **A human prompt is marked, not guessed at.** Claude Code writes
 * `origin: {kind: "human"}` on the lines you typed, and writes something else on
 * the ones it generated for itself — the task notifications, the slash-command
 * plumbing, the "[Request interrupted by user]" markers, the image companions.
 * That field is the whole filter, and it matters that it is a field: the
 * alternative is a list of magic strings that somebody else's release can
 * invalidate silently, which is how a prompt search quietly starts returning
 * `<command-name>/clear</command-name>` as something you said. Transcripts
 * written before the field existed fall back to that list of strings, because
 * for those there is nothing else — but they are a fixed, finite set of files
 * that will never grow again.
 *
 * **Nothing here is summarised and nothing is sent anywhere.** No model is
 * asked to describe a turn: every field is either copied out of the transcript
 * or added up from it. The one exception is `cost`, which is an estimate from
 * published rates and is named as such wherever it is drawn — Claude Code
 * records its own figure per *conversation* (`reportedCost`), and where it has,
 * that is the one to believe.
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readAppended, sessionOf, transcriptFiles, transcriptsRoot } from './transcripts'
import { priceOf, usageTotals } from './tokenUsage'
import type { ConversationRecord, AgentTurn, TokenTotals, TurnIndex } from '../shared/types'

/** Our own record of what has already been read, beside the app's other state. */
const CACHE_NAME = 'agent-turns.json'

/**
 * Bumped when what a record *means* changes rather than what it holds.
 *
 * A cache written by a build that filtered prompts differently is not stale, it
 * is a different question's answer — and mixing the two produces a prompt list
 * that is right for some months and wrong for others, which is worse than one
 * that is wrong throughout because nobody can see where the line is.
 */
const CACHE_VERSION = 2

/**
 * How much of a prompt is kept.
 *
 * Enough that searching finds it and reading it tells you what you meant, and
 * not so much that a pasted stack trace costs a megabyte of index. What is
 * dropped is marked, so a clipped prompt reads as clipped rather than as a
 * prompt that ended oddly.
 */
const PROMPT_LIMIT = 4000

/**
 * How many file paths one turn keeps.
 *
 * A turn that read three hundred files was a search, and the list is not what
 * anybody wanted from it. The first forty are the ones it started with, which
 * is the useful end.
 */
const FILE_LIMIT = 40

/** What one transcript contributed, remembered between runs. */
interface FileCache {
  size: number
  mtimeMs: number
  offset: number
  turns: AgentTurn[]
  /** The conversation's own facts, which arrive on lines of their own. */
  title: string | null
  cwd: string
  reportedCost: number | null
  /** The last reply counted, so its other blocks are not counted again. */
  lastMessageId: string | null
}

type Cache = Record<string, FileCache>

let cache: Cache | null = null
let cachePath: string | null = null
/** One scan at a time; a second caller waits for the first rather than racing it. */
let inFlight: Promise<TurnIndex> | null = null

/**
 * The index, scanning only what has changed since the last one.
 *
 * `dataDir` is the app's own state folder, where the offsets and the records
 * are remembered so a restart does not re-read every transcript on the disk.
 */
export function readTurnIndex(dataDir: string): Promise<TurnIndex> {
  if (inFlight) return inFlight
  inFlight = scan(dataDir).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function scan(dataDir: string): Promise<TurnIndex> {
  cachePath = path.join(dataDir, CACHE_NAME)
  if (!cache) cache = await loadCache(cachePath)

  const root = transcriptsRoot()
  let files: string[]
  try {
    files = await transcriptFiles(root)
  } catch {
    // No `~/.claude/projects` at all: Claude Code has never run here. That is an
    // answer, not a failure — and a different one from "we could not look".
    return { status: 'none', turns: [], conversations: [], scannedAt: Date.now() }
  }

  const live = new Set(files)
  let touched = false

  for (const file of files) {
    try {
      if (await readFileInto(file)) touched = true
    } catch {
      // One unreadable transcript contributes what it contributed last time.
    }
  }

  // Conversations the user has deleted stop being listed, and stop being
  // remembered. Otherwise the index is a museum of every prompt ever typed into
  // a transcript that no longer exists.
  for (const known of Object.keys(cache)) {
    if (!live.has(known)) {
      delete cache[known]
      touched = true
    }
  }

  if (touched) void saveCache()

  return build(files)
}

/** A transcript nothing has been read from yet. */
function blank(): FileCache {
  return {
    size: 0,
    mtimeMs: 0,
    offset: 0,
    turns: [],
    title: null,
    cwd: '',
    reportedCost: null,
    lastMessageId: null,
  }
}

/**
 * Reads whatever has been appended to one transcript since last time.
 *
 * The turn under construction is the *last* one in the file's record, which is
 * what makes an append cheap: a conversation that has grown by one reply
 * reopens its final turn and adds to it, rather than rebuilding a thousand.
 */
async function readFileInto(file: string): Promise<boolean> {
  const own = sessionOf(file)
  let entry = cache![file] ?? blank()

  const read = await readAppended(
    file,
    cache![file],
    (line) => {
      // Cheap before expensive. Every line that could matter carries one of
      // these: an assistant reply has `output_tokens`, any user message has
      // `"user"` as its role, an edit's result has `structuredPatch`, and the
      // two conversation-level facts name themselves. Everything else — the
      // attachments, the mode changes, the queue bookkeeping — is skipped
      // without being parsed, and on a first scan that is most of the file.
      if (
        !line.includes('"output_tokens"') &&
        !line.includes('"user"') &&
        !line.includes('"structuredPatch"') &&
        !line.includes('"ai-title"') &&
        !line.includes('"cost-state"')
      )
        return
      take(entry, line, own)
    },
    () => {
      entry = blank()
    }
  )
  if (!read) return false

  entry.offset = read.scanned.offset
  entry.size = read.scanned.size
  entry.mtimeMs = read.scanned.mtimeMs
  cache![file] = entry
  return true
}

/** One transcript line, folded into the record it belongs to. */
function take(entry: FileCache, line: string, own: string): void {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return
  }

  // Only an *explicitly different* id is refused. Forking a session copies the
  // history into a new file, and the copies keep the id of the conversation they
  // came from — kept, they would list every prompt twice. Absent is accepted: a
  // format that stops writing the field must not silently empty the index.
  const said = row?.sessionId ?? row?.session_id
  if (typeof said === 'string' && said && said !== own) return

  if (row?.type === 'ai-title') {
    // The name Claude Code gave the conversation itself. Taking the latest, since
    // it renames as the conversation turns out to be about something else.
    if (typeof row.aiTitle === 'string' && row.aiTitle.trim()) entry.title = row.aiTitle.trim()
    return
  }

  if (row?.type === 'cost-state') {
    if (typeof row.totalCostUSD === 'number' && Number.isFinite(row.totalCostUSD)) {
      entry.reportedCost = row.totalCostUSD
    }
    return
  }

  const at = Date.parse(row?.timestamp ?? '')
  const when = Number.isFinite(at) ? at : null
  const cwd = typeof row?.cwd === 'string' && row.cwd ? row.cwd : ''
  if (cwd && !entry.cwd) entry.cwd = cwd

  if (row?.type === 'user') {
    const said = human(row)
    if (said) {
      // A new human turn closes whatever was open. Nothing is done to close it —
      // its `endedAt` was set by the last reply that landed in it.
      entry.turns.push({
        session: own,
        file: '',
        n: entry.turns.length + 1,
        prompt: said.text.slice(0, PROMPT_LIMIT),
        clipped: said.text.length > PROMPT_LIMIT,
        at: when ?? 0,
        endedAt: null,
        cwd,
        branch: typeof row.gitBranch === 'string' && row.gitBranch ? row.gitBranch : null,
        model: null,
        totals: zero(),
        context: 0,
        tools: {},
        read: [],
        edited: [],
        images: said.images,
      })
      return
    }
    // Not a prompt, but possibly the result of an edit — which is the only place
    // the *size* of a change is recorded, and the only authoritative statement of
    // which file was actually written.
    edited(entry, row?.toolUseResult)
    return
  }

  if (row?.type !== 'assistant') return

  const turn = entry.turns[entry.turns.length - 1]
  // Replies before the first human prompt belong to no turn. That is a session
  // that was resumed or compacted, and its opening lines are not something
  // anybody asked for.
  if (!turn) return

  // One line per content block, all carrying the same reply's usage — see the
  // long note in `tokenUsage.take`. The tool calls below are counted from every
  // line, because each block is a real distinct call; only the usage repeats.
  const messageId = row?.message?.id
  const counted = typeof messageId === 'string' && messageId && messageId === entry.lastMessageId
  if (typeof messageId === 'string' && messageId) entry.lastMessageId = messageId

  const one = counted ? null : usageTotals(row?.message?.usage)
  if (one) {
    add(turn.totals, one)
    // The context the model was carrying, which is a level rather than a sum:
    // the last reply's is the turn's, and adding them would produce a number
    // several times the size of any window that exists.
    turn.context = one.input + one.cacheRead + one.cacheWrite5m + one.cacheWrite1h
    if (typeof row?.message?.model === 'string') turn.model = row.message.model
    if (when !== null) turn.endedAt = when
  }

  const content = row?.message?.content
  if (!Array.isArray(content)) return
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue
    const name = typeof block.name === 'string' ? block.name : '?'
    turn.tools[name] = (turn.tools[name] ?? 0) + 1
    // Reads are recorded from the *call*, since a read has no result worth
    // parsing; writes are recorded from the result instead, which is the only
    // place that says how big the change was and whether it happened at all.
    if (name === 'Read') {
      const target = block.input?.file_path
      if (typeof target === 'string' && target && !turn.read.includes(target)) {
        if (turn.read.length < FILE_LIMIT) turn.read.push(target)
      }
    }
  }
}

/**
 * A write, taken from its result rather than from the call that asked for it.
 *
 * The call says what was requested; the result says what happened, names the
 * file the tool actually resolved, and carries the patch — which is where the
 * size of the change comes from. A refused or failed edit has no patch and is
 * therefore not counted, which is the behaviour worth having: a turn that tried
 * to write a file and could not did not change it.
 */
function edited(entry: FileCache, result: any): void {
  if (!result || typeof result !== 'object') return
  const target = result.filePath
  if (typeof target !== 'string' || !target) return

  const turn = entry.turns[entry.turns.length - 1]
  if (!turn) return

  let added = 0
  let removed = 0
  // A creation is asked about first, and the order is the whole of the fix: a
  // new file carries an *empty* patch — there is nothing to diff it against —
  // alongside the content it was written with. Reading the patch first sees an
  // array, finds no hunks in it, and reports that a file which did not exist
  // ten seconds ago changed by nothing at all.
  if (result.type === 'create' && typeof result.content === 'string') {
    added = result.content ? result.content.split('\n').length : 0
  } else if (Array.isArray(result.structuredPatch) && result.structuredPatch.length) {
    for (const hunk of result.structuredPatch) {
      if (!Array.isArray(hunk?.lines)) continue
      for (const line of hunk.lines) {
        if (typeof line !== 'string') continue
        if (line.startsWith('+')) added++
        else if (line.startsWith('-')) removed++
      }
    }
  } else {
    // Neither a patch nor a creation: a read's result, or a tool whose shape we
    // do not know. Not an edit, and guessing that it was would put files in the
    // changed list that nothing changed.
    return
  }

  const already = turn.edited.find((e) => e.path === target)
  if (already) {
    already.added += added
    already.removed += removed
    return
  }
  if (turn.edited.length < FILE_LIMIT) turn.edited.push({ path: target, added, removed })
}

/**
 * Whether a user line is something a person typed, and what they typed.
 *
 * Null for everything else, and "everything else" is most of them: tool results,
 * the image companions that ride beside a prompt, the slash-command echo, the
 * interruption markers, the notifications the harness writes as if they were
 * user turns.
 */
function human(row: any): { text: string; images: number } | null {
  if (row?.isSidechain) return null

  const content = row?.message?.content
  let text = ''
  let images = 0
  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      else if (block.type === 'image') images++
      // A tool result anywhere in the content makes the line a tool result. A
      // prompt never carries one.
      else if (block.type === 'tool_result') return null
    }
    text = parts.join('\n')
  } else {
    return null
  }

  text = text.trim()
  if (!text) return null

  // The field, where the format has one. Claude Code marks what you typed —
  // including a prompt you queued while it was busy — and marks what it
  // generated as something else.
  const origin = row?.origin
  if (origin && typeof origin === 'object') {
    return origin.kind === 'human' ? { text, images } : null
  }

  // No field: a transcript from before it existed. These are the strings that
  // format used, and the set cannot grow — every new transcript has the field.
  if (row?.isMeta) return null
  if (
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command-stdout>') ||
    text.startsWith('<local-command-caveat>') ||
    text.startsWith('<system-reminder>') ||
    text.startsWith('[Request interrupted')
  )
    return null

  return { text, images }
}

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

/** The cache, folded into the shape the renderer draws. */
function build(files: string[]): TurnIndex {
  const turns: AgentTurn[] = []
  const conversations: ConversationRecord[] = []

  for (const file of files) {
    const entry = cache![file]
    if (!entry) continue

    let startedAt: number | null = null
    let lastAt: number | null = null
    for (const turn of entry.turns) {
      // The path is held once per conversation rather than once per turn: it is
      // the same string a thousand times over, and the cache is written to disk.
      //
      // Copied rather than handed over, and the counters have to be copied
      // *individually* — a spread copies the record and leaves every array and
      // object inside it pointing at the cache. The turn at the end of a live
      // conversation is still being added to, so a caller holding one from the
      // last scan would watch its own copy grow: the "before" and "after" of any
      // comparison become the same object, and the difference between them is
      // always nothing.
      turns.push({
        ...turn,
        file,
        totals: { ...turn.totals },
        tools: { ...turn.tools },
        read: [...turn.read],
        edited: turn.edited.map((e) => ({ ...e })),
      })
      if (turn.at && (startedAt === null || turn.at < startedAt)) startedAt = turn.at
      const ended = turn.endedAt ?? turn.at
      if (ended && (lastAt === null || ended > lastAt)) lastAt = ended
    }

    if (!entry.turns.length) continue
    conversations.push({
      id: sessionOf(file),
      file,
      cwd: entry.cwd,
      title: entry.title,
      startedAt,
      lastAt,
      turns: entry.turns.length,
      reportedCost: entry.reportedCost,
    })
  }

  // Newest first, which is the order every consumer wants: the prompt explorer
  // opens on what you were just doing, and a pane's own turns are read from the
  // end.
  //
  // The tie-break is not decoration. Two prompts sent inside the same
  // millisecond — a queued one released the instant the previous turn ends, and
  // every fixture a test writes in a loop — would otherwise come back in
  // whichever order the sort happened to leave them, so a list that is correct
  // would still be a list that reorders itself between two identical scans.
  turns.sort((a, b) => b.at - a.at || a.session.localeCompare(b.session) || b.n - a.n)
  conversations.sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))

  return {
    status: turns.length ? 'ok' : 'none',
    turns,
    conversations,
    scannedAt: Date.now(),
  }
}

/**
 * What one turn would have cost on the API.
 *
 * "Would have", said plainly, because a subscription does not bill per token.
 * Null for a model with no published price, so a caller can say the figure is
 * missing rather than draw a confident zero.
 */
export function turnCost(turn: AgentTurn): number | null {
  if (!turn.model) return null
  const priced = priceOf({ [turn.model]: turn.totals })
  return priced.unpriced.length ? null : priced.cost
}

async function loadCache(file: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.version !== CACHE_VERSION || typeof parsed.files !== 'object') return {}
    return (parsed.files ?? {}) as Cache
  } catch {
    // No cache, a corrupt one, or one from a version that meant something else.
    // The next scan rebuilds it from the transcripts, which are the only source
    // of truth here.
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
