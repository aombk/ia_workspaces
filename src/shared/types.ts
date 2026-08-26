import type { KeepAwakeMode } from './powerLock'

export type { KeepAwakeMode }

/**
 * Types shared between the main process, preload bridge and renderer.
 *
 * Nothing in this file may import Electron or Node APIs — the renderer bundles
 * it too, and keeping it runtime-free is what lets the UI layer stay portable
 * to a different shell later without touching the components.
 */

import type { InterfaceTheme, TerminalTheme } from './themes'
import type { ImageFilter, ImageLayout, ImageSort, TreeSort } from './images'

/**
 * Every shell kind on every platform, in one union.
 *
 * Not split per platform, because a workspace file is portable — saved on
 * Windows, opened on a Mac — and a value the reader cannot even name is one it
 * would have to discard. `resolveShell` walks its fallback chain instead, so a
 * `powershell` pane opened on macOS becomes a zsh pane rather than a dead tab.
 */
export type ShellKind =
  | 'powershell'
  | 'pwsh'
  | 'cmd'
  | 'wsl'
  | 'ssh'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh'
  | 'custom'

export interface ShellProfile {
  kind: ShellKind
  /** Human label for the settings dropdown and tab tooltips. */
  label: string
  /** Absolute path to the executable, resolved at startup. */
  path: string
  args: string[]
  /** Whether this profile supports our OSC-based shell integration injection. */
  supportsIntegration: boolean
  available: boolean
}

export interface Workspace {
  id: string
  name: string
  /**
   * The workspace this one sits inside, or absent for a top-level one.
   *
   * A workspace contains workspaces — there is no separate "group" entity. A
   * folder you nest others under is still a workspace: it has its own cwd, its
   * own tabs and its own terminals, and nesting is just where it sits in the
   * list. One concept instead of two, and nothing to convert when a workspace
   * turns out to be the natural home for a couple of others.
   */
  parentId?: string | null
  /** Folded shut. Children keep running; the sidebar stops listing them. */
  collapsed?: boolean
  /**
   * The workspace's folder: where new terminals start, what the changes and
   * search panes look at, which branch is shown, and where `NOTES.md` lives.
   *
   * Only "Change folder…" on the workspace moves it. Browsing the docked tree
   * does not — wandering into a subfolder to read one file is not a statement
   * about which project the workspace *is*, and having it silently re-root
   * everything else was the surprise.
   */
  cwd: string
  /**
   * Where the docked tree is currently browsing, when that is not the root.
   *
   * Kept so switching workspaces and restarting come back to the folder you
   * left open. Absent means "at the root", which is also what a tree gets when
   * the root moves under it.
   */
  treeCwd?: string
  /** Accent colour token, used for the sidebar dot and active tab bar. */
  color: string
  tabs: TerminalTabState[]
  activeTabId: string | null
  /** Git branch, refreshed in the background. Not user-editable. */
  branch?: string
  /**
   * Shell every new pane here starts with, overriding the global setting.
   *
   * Per workspace because that is the grain the choice actually has: a project
   * built in WSL wants WSL panes, and the one next to it does not.
   */
  shell?: ShellKind
  /**
   * Which WSL distribution, when `shell` is `wsl`.
   *
   * A WSL workspace still stores a *Windows* path in `cwd` — the
   * `\\wsl.localhost\<distro>\…` share — so the file tree, git status, search
   * and diff all keep working with no notion of WSL at all. Only the spawn
   * translates it back to a Linux path.
   */
  wslDistro?: string
  /**
   * Which host, when `shell` is `ssh` — an alias from `~/.ssh/config`, or
   * anything else `ssh` would accept.
   *
   * The opposite of `wslDistro` in the way that matters. A WSL workspace keeps a
   * real local path in `cwd` and everything local keeps working; an SSH
   * workspace's directory is on another machine, so `cwd` here means the folder
   * to land in *there* and nothing local can read it. `isRemotePane` is what the
   * file tree, diff and compare panes check before assuming otherwise.
   */
  sshHost?: string
  /**
   * Whether this workspace shows the docked tree. Per workspace, not global —
   * a scratch workspace of shells rarely wants one, a project usually does.
   */
  treeVisible?: boolean
}

/** A pane holds either a shell or the file tree. */
/**
 * What a pane holds. Everything but `terminal` is an `AuxPane` — a pane with no
 * shell behind it, mounted through the one switch in `Terminals.ensureAux`.
 */
/**
 * The list is the source and the union is derived from it, rather than the
 * other way round. A persisted document has to be checked against these names
 * at runtime, and a hand-written second copy of the list is a copy that goes
 * out of date silently: a kind missing from the runtime check is not rejected,
 * it is read back as a terminal and then saved that way, so the tab is gone on
 * the next write. `Set<PaneKind>` is perfectly happy to be short, so the
 * compiler cannot catch it. Derived, it cannot happen.
 */
export const PANE_KINDS = [
  'terminal',
  'files',
  'reader',
  'search',
  'editor',
  'diff',
  'history',
  'ports',
  'tokens',
  'browser',
  'compare',
  'images',
  'monitor',
  'runbook',
  'focus',
  'day',
  'canvas',
] as const

export type PaneKind = (typeof PANE_KINDS)[number]

/**
 * How the editor pane shows the file it has open.
 *
 * Chosen from the tab's right-click menu and remembered per pane, because which
 * one you want is a property of what you are doing with *this* file, not a
 * global preference. Absent — the ordinary case — means the extension decides,
 * so opening a `.json` gets you the JSON view without being asked.
 *
 * `markdown` formats the text as you type, with the syntax still visible and
 * still editable. `code` is the same idea with a language's grammar instead of
 * markdown's. `text` is no styling at all. `preview`, `csv` and `hex` are the
 * three that are not the file's own text: a rendered document, a grid, and
 * bytes.
 */
export type EditorMode = 'markdown' | 'code' | 'text' | 'preview' | 'json' | 'csv' | 'hex'

export const EDITOR_MODES: readonly EditorMode[] = [
  'markdown',
  'code',
  'text',
  'preview',
  'json',
  'csv',
  'hex',
]

export const EDITOR_MODE_LABELS: Record<EditorMode, string> = {
  markdown: 'Markdown (live)',
  code: 'Code',
  text: 'Plain text',
  preview: 'Rendered markdown',
  json: 'JSON',
  csv: 'Table (CSV/TSV)',
  hex: 'Hex',
}

/** Modes that show something other than the file's own text, so cannot edit it. */
export const READ_ONLY_MODES: readonly EditorMode[] = ['preview', 'hex']

/**
 * The name a pane kind is written under.
 *
 * Both builds share one workspace file, and a build that does not know a kind
 * rewrites it as a terminal — so renaming one in memory would have an older
 * build quietly demolish the tabs a newer one wrote. The editor pane was
 * `notes` for its whole life until it learned to open more than one file; on
 * disk it still is, and `readPaneKind` translates on the way back in.
 */
export function wireKind(kind: PaneKind | undefined): string {
  return kind === 'editor' ? 'notes' : (kind ?? 'terminal')
}

/**
 * The inverse of `wireKind`: a name from disk back into a `PaneKind`, or null
 * for one this build does not know.
 *
 * The only place either direction is implemented. There were three copies of
 * this list before — the state loader, the workspace-file importer, and the
 * union itself — and two of them had drifted: the workspace-file importer was
 * missing `compare` and `images`, so saving a workspace and loading it turned
 * those tabs into terminals, and it took `notes` at face value rather than
 * translating it, so a saved editor pane came back as a file tree.
 *
 * Nothing about that is catchable by the compiler, which is why it is one
 * function over one list rather than a convention to keep them in step.
 */
export function readWireKind(raw: unknown): PaneKind | null {
  if (raw === 'notes') return 'editor'
  return typeof raw === 'string' && (PANE_KINDS as readonly string[]).includes(raw)
    ? (raw as PaneKind)
    : null
}

/**
 * Whether a pane has a shell behind it.
 *
 * `kind` is optional for historical reasons — a pane written before there were
 * kinds is a terminal — so "is a terminal" is not `kind === 'terminal'`, and
 * with more than two kinds it is no longer `kind !== 'files'` either. Every
 * caller that means "somewhere I can write bytes" goes through here.
 */
export function isTerminalPane(pane: { kind?: PaneKind }): boolean {
  return !pane.kind || pane.kind === 'terminal'
}

/**
 * One pane. Splitting a tab adds panes; it never adds tabs.
 */
export interface PaneState {
  id: string
  /** Defaults to 'terminal' when absent, so older documents still load. */
  kind?: PaneKind
  /** Name set by the user on the pane header. Wins over the shell's title. */
  customTitle?: string | null
  /**
   * Folder this pane was last known to be in. For a shell it is tracked live
   * via shell integration; for the file tree it is the folder being browsed.
   * Persisted either way so a restored pane reopens in the right place.
   */
  cwd: string
  /** Title reported by the shell through OSC 0/2. */
  autoTitle: string
  /**
   * The shell this pane runs, when it was chosen for this pane specifically.
   *
   * Absent is the ordinary case and means "whatever my workspace runs" — so a
   * workspace switched to WSL takes its inheriting tabs with it, while a tab you
   * deliberately made a PowerShell tab stays one. Independence in both
   * directions, and it is absence that carries it: a value here is a decision,
   * and there is no way to record a decision that was never made.
   */
  shell?: ShellKind
  /**
   * The agent conversation this pane was last running, so closing the app and
   * reopening it comes back to the same one rather than a blank prompt.
   */
  agentSession?: AgentSession
  /**
   * The last command line submitted in this pane, so a restored pane can offer
   * it back. Reported by shell integration, which is the only thing that knows
   * where the prompt ends and the user's typing begins.
   */
  lastCommand?: string
  /**
   * Which WSL distribution this pane runs, when its shell is `wsl`. Absent
   * means the workspace's, and absent there means WSL's own default.
   */
  wslDistro?: string
  /**
   * Which host this pane runs on, when its shell is `ssh`. Absent means the
   * workspace's.
   */
  sshHost?: string
  /** The file a `reader` pane is showing. Absent for every other kind. */
  file?: string
  /** How an editor pane displays its file. Absent means "ask the extension". */
  editorMode?: EditorMode
  /** Whether long lines wrap. Absent means "prose wraps, code does not". */
  wordWrap?: boolean
  /** Whether the editor draws a line-number gutter. Absent means no. */
  lineNumbers?: boolean
  /**
   * Whether the editor draws a faint rule at the character limit. Absent means
   * no — it is a guide for files written to a column, not a fact about text.
   */
  columnGuide?: boolean
  /**
   * Whether this editor writes as you type. Absent means yes, except in hex,
   * where bytes are never written without being asked for.
   */
  autosave?: boolean
  /**
   * The page a `browser` pane is on, updated as you navigate so reopening it
   * comes back where you were rather than at the default. Absent for every
   * other kind, and on a host with no browser to open.
   */
  url?: string
  /**
   * The two files a `compare` pane is diffing, in that order: `compareLeft` is
   * the "before" side, so additions are what the right file has and the left
   * does not.
   *
   * Kept separate from `file` rather than reusing it for the left side. A
   * compare pane is not a file pane that happens to have a second path — it is
   * meaningless with only one — and a half-populated `file` would let a pane
   * restore into a state it cannot render.
   */
  compareLeft?: string
  compareRight?: string
  /**
   * How an `images` pane arranges and orders what it shows. Absent means "the
   * setting", so a pane you never touched follows the default as it changes and
   * one you did keeps what you set.
   */
  imageLayout?: ImageLayout
  imageSort?: ImageSort
  imageSortDesc?: boolean
  imageRecursive?: boolean
  imageFit?: boolean
  imageFilter?: ImageFilter
  /**
   * The seed behind the random order and the board's scatter.
   *
   * Persisted because a shuffle you liked is worth keeping, and because without
   * it every reopen — and every re-render — would deal a different hand. This is
   * the difference between "random" as an arrangement and "random" as a twitch.
   */
  imageSeed?: number
  /**
   * Where images have been dragged on the board, keyed by absolute path, in
   * fractions of the canvas rather than pixels so a resized pane keeps the
   * arrangement instead of pushing everything off the edge.
   *
   * Only what you moved yourself is recorded. Anything untouched is placed by
   * the packing each time, so a folder that gains a file does not need every
   * position rewritten — and a board you never dragged costs nothing in the
   * workspace file.
   */
  imageBoard?: Record<string, BoardPlacement>
}

/** One hand-placed image on the board, in fractions of the canvas. */
export interface BoardPlacement {
  x: number
  y: number
  /** Width as a fraction of canvas width; height follows the aspect ratio. */
  w: number
}

/**
 * A resumable agent conversation, as reported by the agent itself.
 *
 * The id is Claude Code's own session id, taken from the `SessionStart` hook —
 * not inferred from the folder. Two panes open on the same project are two
 * different conversations, and "the newest session in this folder" would
 * collapse them into one.
 */
export interface AgentSession {
  tool: 'claude'
  id: string
  /** When it was last reported, so a stale id can be aged out. */
  at: number
  /**
   * Absolute path to this conversation's transcript, as the hook reported it.
   *
   * An id is a claim; the transcript is the conversation. Claude Code issues
   * the id at `SessionStart` — before a single word has been said — and writes
   * the file only once the conversation has a first user turn, so a session
   * that is started and abandoned leaves an id pointing at nothing. Checking
   * the file is what tells the two apart, and it is checked rather than
   * derived because the folder a transcript lives in is Claude Code's own
   * encoding of a path, not ours to reimplement.
   *
   * Absent on sessions recorded by a build that predates this; those are taken
   * at their word and age out on the TTL.
   */
  transcript?: string
  /**
   * An id this pane reported that is not yet evidence of anything.
   *
   * `SessionStart` hands out an id before the conversation exists, so one that
   * has written nothing may not displace a real conversation — a pane where
   * Claude Code was opened and never spoken to must not forget the session it
   * was having. But a claim that is refused and *thrown away* is how a pane
   * ends up resuming the conversation before last: start a new one, or `/clear`
   * into one, and the pane keeps pointing at the old id for as long as nothing
   * else displaces it.
   *
   * So it is kept beside the record instead. The moment its transcript is on
   * disk the claim has become a conversation and takes the record's place —
   * checked whenever the record is read, because a file appearing is not an
   * event anything fires a hook for. See `acceptSession`.
   */
  pending?: {
    id: string
    /** Where the conversation will be written. Required — it is the proof. */
    transcript: string
    /** When it was claimed. Becomes the record's `at` on promotion. */
    at: number
  }
}

/**
 * How long a recorded session stays resumable. A conversation you last touched
 * a fortnight ago is not what you expect a pane to reopen into.
 */
export const AGENT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

/** One metered window of Claude Code usage. */
export interface UsageBucket {
  id: string
  label: string
  /** Percent of the limit consumed, one decimal. */
  percent: number
  /** ISO timestamp the window resets at, or null when it is not metered. */
  resetsAt: string | null
}

export interface UsageReport {
  /**
   * `ok` alone carries numbers. The rest are all "we do not know", kept
   * distinct so the panel can say *why* rather than showing a plausible zero.
   */
  /**
   * `locked` is macOS only: the login was found, in the keychain, and the
   * keychain would not hand it over. A distinct answer from `signed-out`
   * because the two want opposite things from the reader — one means log in,
   * the other means you already are and a permission dialog was dismissed.
   */
  status: 'ok' | 'signed-out' | 'expired' | 'unmetered' | 'error' | 'locked'
  buckets: UsageBucket[]
}

/**
 * Every class of token a turn can spend, kept apart because they are priced
 * apart. Adding them up is what "tokens" means on screen; see `totalOf`.
 */
export interface TokenTotals {
  input: number
  output: number
  /** Written to the five-minute cache — 1.25x the input price. */
  cacheWrite5m: number
  /** Written to the one-hour cache — 2x. */
  cacheWrite1h: number
  /** Served from cache — a tenth of the input price. */
  cacheRead: number
  /** Assistant turns counted, which is how many API calls this represents. */
  messages: number
}

/** What one folder has spent, across every conversation ever held in it. */
export interface ProjectTokenUsage {
  /** The folder itself, as Claude Code recorded it — a real path, not a slug. */
  cwd: string
  totals: TokenTotals
  /** Split by model, which is what makes a cost estimate possible at all. */
  byModel: Record<string, TokenTotals>
  /** Total tokens per local day, `YYYY-MM-DD`, for the last month only. */
  days: Record<string, number>
  /** What this would have cost on the API. See `MODEL_PRICES`. */
  cost: number
  /**
   * That cost split by token class, so the figure can be checked rather than
   * taken on trust — each line maps to one column of the published price table.
   */
  costs: CostBreakdown
  /** Models with no published price. Their tokens count; their cost cannot. */
  unpricedModels: string[]
  lastAt: number | null
}

/** What one conversation has spent, addressed by the id a pane records. */
export interface SessionTokenUsage {
  id: string
  cwd: string
  totals: TokenTotals
  cost: number
  lastAt: number | null
}

/**
 * One machine's totals for one project, as written into the shared folder.
 *
 * Totals only — no prompts, no replies, no filenames. See `tokenShare.ts` for
 * why this is what travels and the transcripts are not.
 */
export interface MachineTotals {
  /** Stable per machine, and the key that stops one counting itself twice. */
  machine: string
  /** That machine's hostname, for reading. Never matched on. */
  label: string
  /** The project key both machines agree on — a git remote, or a folder name. */
  project: string
  /** Where the project lives *on that machine*, which is rarely where it lives here. */
  path: string
  /** What that machine calls the workspace. */
  name: string
  totals: TokenTotals
  cost: number
  /**
   * The cost split by class, published alongside the total.
   *
   * Not redundant with `cost`, and the reason is what the stats table does with
   * it: the five rows have to add up to the figure at the bottom. Publishing
   * only the total meant a pooled table whose token counts came from every
   * machine and whose dollars came from this one, which is a table that visibly
   * does not add up. Absent on records written before this existed — treated as
   * zero, so an old machine contributes its tokens and waits to be updated.
   */
  costs?: CostBreakdown
  /** When that machine last wrote this, so a stale one can say so. */
  at: number
}

/** One workspace's totals, on their way out to the shared folder. */
export interface TokenPublishEntry {
  cwd: string
  name: string
  totals: TokenTotals
  cost: number
  /** Split by class, so a pooled stats table still adds up. See `MachineTotals`. */
  costs: CostBreakdown
}

/** Everything the share folder knows, plus which key each local folder maps to. */
export interface SharedTokens {
  /** This machine's own id, so its row can be marked as this one. Blank = sharing off. */
  machine: string
  /** Local workspace folder to project key, for the machines below. */
  keys: Record<string, string>
  /** Every machine's totals, by project key — this machine's included. */
  byProject: Record<string, MachineTotals[]>
}

/**
 * One machine's account of one project, as written into the relay folder.
 *
 * This is the whole of what Relay moves between machines: a description of a
 * repository, never the repository. No patch, no bundle, no file contents, and
 * no button anywhere that commits, pushes or pulls on another machine's behalf.
 * Relay answers "what is going on over there"; what to do about it is decided in
 * the git pane, by a person, on the machine it affects.
 *
 * Every field is a fact that machine could see at `at` and cannot see now. The
 * pane must therefore never render one in the present tense — see `stale`.
 */
export interface RelayPresence {
  /** Stable per machine, and the key that stops one appearing twice. */
  machine: string
  /** That machine's hostname, for reading. Never matched on. */
  label: string
  /** The project key every machine agrees on — a git remote, or a folder name. */
  project: string
  /** Where the project lives *on that machine*, which is rarely where it lives here. */
  path: string
  /** What that machine calls the workspace. */
  name: string
  /** The line of saves (branch) it was on, or absent when off to one side. */
  branch?: string
  /** True when it was sitting on one save rather than on a branch. */
  detached?: boolean
  /**
   * The full number of the save it was standing on.
   *
   * Full rather than short for the same reason `RepoStatus.headFull` is: this
   * one is compared, not read, and a seven-character prefix compares correctly
   * right up until a project grows two saves that share one.
   */
  head?: string
  /** Saves it had made that the copy online had not got. */
  unsent: number
  /**
   * What those saves were called, newest first, and not necessarily all of them.
   *
   * A count alone is a number to worry about; the messages are what let someone
   * recognise their own afternoon and stop worrying. Capped, because a machine
   * left offline for a fortnight must not write a novel into a synced folder.
   */
  unsentSubjects: string[]
  /** Saves the copy online had that it had not brought in. */
  behind: number
  /** Whether that copy of the project had a remote at all. */
  hasRemote: boolean
  /**
   * The branch online this one was paired with, like `origin/main`.
   *
   * Absent means the branch had never been sent, which is a third state and not
   * a tidier way of saying `unsent: 0`. A branch with no upstream has nothing to
   * be counted against, so every save on it is somewhere else's news — and
   * reporting that as "nothing unsent" would be the most confident possible way
   * to be wrong.
   */
  upstream?: string
  /**
   * Files it had changed and not saved, as paths inside the project.
   *
   * Paths, because the whole point of the overlap warning is naming the file.
   * Tracked files only: a name git already knows is a name already committed to
   * the repository's history, whereas an untracked one can be a scratch file, a
   * dump, or a secret nobody meant to write down. Those are counted, never named.
   */
  changed: string[]
  /** How many files it had that git was not tracking. Counted, never named. */
  untracked: number
  /** A rebase or merge it had stopped part-way through, if any. */
  inProgress?: RepoStatus['inProgress']
  /**
   * True when that machine had this workspace open in the app as it wrote.
   *
   * The difference between "the laptop has four changed files" and "the laptop
   * is being used right now, on this, by you, ten seconds ago" — which is the
   * difference between reassurance and a warning.
   */
  open: boolean
  /** When that machine last wrote this record. */
  at: number
}

/**
 * One workspace, on its way out to the relay folder.
 *
 * Only what the main process cannot work out for itself. The repository's state
 * is deliberately *not* here: `relay.ts` asks git directly, because sending a
 * whole `RepoStatus` — every changed file, every unsent hash — across the bridge
 * once a minute per workspace to have most of it thrown away is a lot of copying
 * to save a call that is already cached.
 */
export interface RelayPublishEntry {
  cwd: string
  name: string
  /** Whether this is the workspace on screen right now, in a window with focus. */
  open: boolean
  /**
   * Commands run in this project, for the machines that want to recall them.
   *
   * Absent unless sharing commands is switched on *and* a passphrase is set —
   * both, because this is the one payload that is dangerous in the clear and
   * there must be no path that publishes it unencrypted. Already redacted by
   * the time it arrives here; `shareCrypto.ts` does the sealing.
   */
  commands?: string[]
}

/** Everything the relay folder knows, plus which key each local folder maps to. */
export interface Relay {
  /** This machine's own id, so its rows can be told apart. Blank = relay off. */
  machine: string
  /** Local workspace folder to project key, for the records below. */
  keys: Record<string, string>
  /** Every machine's account, by project key — this machine's included. */
  byProject: Record<string, RelayPresence[]>
  /**
   * What every other machine has run in each project, by project key.
   *
   * Empty unless commands are being shared and this machine's passphrase can
   * read what the others wrote. A machine whose passphrase differs contributes
   * nothing and is not an error — see `unseal`.
   */
  commandsByProject: Record<string, { machine: string; label: string; commands: string[] }[]>
  /**
   * Why there is nothing to show, when there is nothing to show.
   *
   * A blank pane has three quite different causes — the feature is off, the
   * folder cannot be reached, or no other machine has ever written — and a
   * person who cannot tell them apart will assume the middle one and go
   * looking for a fault that is not there.
   */
  problem?: 'off' | 'unreachable'
}

export interface TokenReport {
  /**
   * `none` is not an error: it means Claude Code has never written a transcript
   * on this machine. Kept distinct from `ok` with an empty list so the panel can
   * say "nothing to count yet" rather than drawing an empty chart.
   */
  status: 'ok' | 'none'
  projects: ProjectTokenUsage[]
  sessions: SessionTokenUsage[]
  scannedAt: number
}

/**
 * The four classes of token, and what each is called where it is published.
 *
 * Worth naming precisely, because "I spent a million tokens" is a sentence with
 * no single meaning and this is why. Anthropic's pricing table has five columns,
 * not two, and every one of them is billed at its own rate. These are the names
 * it uses, so a figure here can be checked against the page it came from.
 */
export const TOKEN_CLASS_LABELS = {
  input: 'base input',
  cacheWrite5m: '5m cache writes',
  cacheWrite1h: '1h cache writes',
  cacheRead: 'cache hits & refreshes',
  output: 'output',
} as const

/**
 * Dollars, one field per column of the published price table.
 *
 * Five, not four: a five-minute cache write and an hour's are different columns
 * at different prices, and merging them into one "cache writes" line — which an
 * earlier version of this did — hides the fact that one costs 1.6x the other.
 */
export interface CostBreakdown {
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
}

/** A blank set of dollar figures. */
export function zeroCosts(): CostBreakdown {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }
}

/**
 * The cache price multipliers, relative to a model's base input price.
 *
 * Not per-model: every model on the list charges 1.25x base input to write a
 * five-minute cache entry, 2x for an hour, and 0.1x to read one back. Verified
 * against platform.claude.com/docs/en/about-claude/pricing — "Prompt caching
 * uses the following pricing multipliers relative to base input token rates".
 */
export const CACHE_MULTIPLIERS = { write5m: 1.25, write1h: 2, read: 0.1 } as const

/**
 * What a million tokens costs, per model, in US dollars.
 *
 * Two warnings travel with every number this produces, and the UI says both out
 * loud rather than leaving them here.
 *
 * The first is that **a subscription does not bill per token.** Claude Code is
 * signed in to an account with limits, not a meter — see `usage.ts`. So this is
 * what the same work would have cost on the API: the right number for "which
 * project is expensive", and not a bill anyone will ever receive.
 *
 * The second is that **prices change and this table does not.** It is a
 * hard-coded copy of what Anthropic published, so a model released after this
 * build has no entry — and an absent entry is reported as absent rather than
 * guessed at, which is why `unpricedModels` exists.
 *
 * Verified against platform.claude.com/docs/en/about-claude/pricing on
 * 18 August 2026. Two things that table says and this one cannot: US-pinned
 * inference costs 1.1x across every class, and the Batch API halves input and
 * output. Neither applies to Claude Code, which is why neither is modelled.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  // $2/$10. This began as introductory pricing due to end on 31 August 2026;
  // the scheduled rise to $3/$15 was cancelled and this is now the standard
  // price. The old figure was in here until the pricing page was re-read.
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
}

/**
 * The price for a model id as a transcript recorded it.
 *
 * Exact match first, then the longest key that the id starts with. The second
 * pass is what handles dated snapshots — a transcript can say
 * `claude-sonnet-4-5-20250929`, and the price of that is the price of
 * `claude-sonnet-4-5`. Longest wins so `claude-opus-4-1` is never served by a
 * shorter `claude-opus-4`.
 */
export function priceFor(model: string): { input: number; output: number } | null {
  const exact = MODEL_PRICES[model]
  if (exact) return exact
  let best: { key: string; price: { input: number; output: number } } | null = null
  for (const [key, price] of Object.entries(MODEL_PRICES)) {
    if (!model.startsWith(key)) continue
    if (!best || key.length > best.key.length) best = { key, price }
  }
  return best?.price ?? null
}

/**
 * What the machine is doing, from what the OS hands to any process.
 *
 * The line this type is drawn along: **nothing here needs a driver, a helper, a
 * sensor daemon or an administrator.** CPU load, memory, uptime, free space and
 * network throughput are counters every OS keeps for everyone, and they are
 * therefore true on all three platforms with no setup and no install.
 *
 * Temperatures are the other side of that line, and how many you get depends
 * entirely on the machine. There is no portable way to read one: on Windows it
 * takes a signed kernel driver (which is what HWiNFO and LibreHardwareMonitor
 * *are*), and on Apple Silicon it takes `powermetrics` under sudo. So three
 * things are read where they are free and nothing is read where it is not —
 * every sensor Linux publishes under `hwmon`, an NVIDIA card through the
 * `nvidia-smi` that ships with its driver, and LibreHardwareMonitor's own
 * readings on Windows *if the user already runs it*. On a Windows machine with
 * none of that, there are no temperatures, and `sources.temperatureNote` says
 * so in a sentence rather than leaving an empty row to be mistaken for a bug.
 *
 * Every optional reading is `null` rather than `0` when it could not be taken,
 * and `sources` says which probes answered. A monitor that renders "0 °C" for
 * "no sensor" is worse than one that renders nothing — see `UsageReport`, which
 * refuses to show a plausible zero for the same reason.
 */
export interface SystemStats {
  /** When this sample was taken, so a stale one can be shown as stale. */
  at: number
  cpu: CpuStats
  memory: MemoryStats
  /** Seconds since the machine booted. */
  uptimeSeconds: number
  /** This app's own footprint, summed over its processes. */
  app: AppFootprint
  disks: DiskStats[]
  /** How hard the hardware under those volumes is working. Empty until sampled twice. */
  diskIo: DiskIoStats[]
  /** The storage stack's verdict per drive, where one is free to obtain. */
  health: DiskHealth[]
  /** Whatever could be read without a driver — usually nothing but Linux. */
  temperatures: TemperatureStats[]
  networks: NetworkStats[]
  /** Empty when nothing could answer — not a zeroed entry. */
  gpus: GpuStats[]
  battery: BatteryStats | null
  /** macOS's own verdict on how hot it is, where degrees are unobtainable. */
  thermalPressure: ThermalPressure | null
  /** Which optional probes answered, so the panes can say why a row is missing. */
  sources: {
    /** The tool that answered for GPUs, or null if none is installed. */
    gpu: string | null
    /** True once the platform probe has answered at least once. */
    platform: boolean
    /** What answered for disk throughput, or null where nothing did. */
    diskIo: string | null
    /** What answered for drive health. */
    health: string | null
    /** What answered for temperatures. Null on most Windows and macOS machines. */
    temperature: string | null
    /**
     * Why there are no temperatures, in a sentence, when there are none.
     *
     * The difference between a monitor that is broken and one that is telling
     * the truth about a machine that will not say. "Windows does not give a CPU
     * temperature to a program without a driver" is a complete answer; an empty
     * row is not, and invites a bug report that has no fix.
     */
    temperatureNote: string | null
  }
}

export interface CpuStats {
  model: string
  cores: number
  /**
   * Percent busy across all cores since the previous sample, or null on the
   * very first one — there is no delta to divide by yet, and 0% would be a lie
   * told at exactly the moment somebody is looking hardest.
   */
  load: number | null
  /** Per-core percentages, same rule. Empty until the second sample. */
  perCore: number[]
}

/**
 * Where the memory went, which is a harder question than "how much is left".
 *
 * `used` was `total - free` for a long time and that is the wrong subtraction
 * on every modern OS: it counts the standby cache — pages held only because
 * nothing else wanted the space yet — as memory that is gone, when it is handed
 * back the instant anything asks. On a 15 GB machine that is the difference
 * between reporting 88% and reporting 78%, and the smaller number is the true
 * one.
 *
 * The two fields under it are the ones that actually answer "where has it all
 * gone", and neither is visible in any process list:
 *
 * - **committed** is what every program has been *promised*. It routinely
 *   exceeds physical memory and that is not a fault: a promise is a ledger
 *   entry, and memory that is committed but never touched is stored nowhere at
 *   all — neither in RAM nor in the page file. What matters is this against
 *   `commitLimit`, not against `total`: Windows refuses an allocation the
 *   moment the ledger is full, so a program that runs out does not slow down,
 *   it fails.
 * - **kernel** is the driver pools. It belongs to no process, so it is missing
 *   from Task Manager's list entirely, and a leaky driver hides there.
 */
export interface MemoryStats {
  total: number
  /** Bytes in use — total minus what the OS calls *available*, not free. */
  used: number
  free: number
  /**
   * Free plus everything reclaimable. The number worth worrying about, and the
   * one Task Manager calls "Available". Null where the platform will not say.
   */
  available: number | null
  /** What has been promised to programs, which may be more than exists. */
  committed: number | null
  /** The ceiling on that promise — physical memory plus the page file. */
  commitLimit: number | null
  /** Driver pools, paged and non-paged together. Belongs to no process. */
  kernel: number | null
}

/** What this app costs, which in a terminal with twenty panes is a fair question. */
export interface AppFootprint {
  processes: number
  /** Percent of one core, summed across the app's processes. */
  cpu: number
  /** Resident bytes, summed. */
  memory: number
  /**
   * The same numbers, split by what each process is for.
   *
   * A total on its own cannot be acted on. An Electron app is five or six
   * processes doing entirely different jobs, and which one is holding the
   * memory decides what to do about it: the graphics process answers to the
   * "draw with the processor" setting, a renderer answers to scrollback, and
   * the main process answers to neither. Measured here, the graphics process
   * alone held a third of a gigabyte — a fact worth being able to see rather
   * than having to go and find with a process explorer.
   */
  parts: AppProcessGroup[]
}

/** One kind of process this app runs, and what all of them cost together. */
export interface AppProcessGroup {
  /** Electron's own name for the job: `browser`, `renderer`, `gpu`, `utility`. */
  type: string
  count: number
  /** Percent of one core, summed over the group. */
  cpu: number
  /** Resident bytes, summed over the group. */
  memory: number
}

export interface DiskStats {
  /** `C:` on Windows, a mount point elsewhere. */
  mount: string
  /** The volume's own name, when it has one. */
  label: string
  total: number
  free: number
}

/**
 * How hard a physical disk is being worked, as opposed to how full it is.
 *
 * A separate list from `DiskStats` because they are not the same things: that
 * one is volumes — `C:`, `/home` — and this one is the hardware underneath, and
 * on any machine with a partitioned disk or a spanned volume the two do not
 * line up. "Which of my drives is being hammered" cannot be answered per
 * volume, and that is the question this exists for.
 */
export interface DiskIoStats {
  /**
   * The counter's own name — `0 C:` on Windows, `nvme0n1` or `disk0` elsewhere.
   *
   * Ugly on Windows and kept that way, because it is the key the rates are
   * matched on between samples and a name that changes is a rate that resets.
   * `label` is the one to put on screen.
   */
  name: string
  /** The drive's product name, when the platform will connect the two. */
  label: string | null
  /** Bytes per second since the previous sample; null on the first. */
  readPerSec: number | null
  writePerSec: number | null
  /**
   * Percent of the interval the disk spent working, when the platform counts it.
   *
   * Worth more than the byte rates on a slow disk: a drive can be at 100% busy
   * while moving very little, which is exactly what a queue of small random
   * writes looks like and exactly when a machine feels stuck.
   */
  busyPercent: number | null
  readTotal: number
  writeTotal: number
}

/**
 * Whether a drive is in trouble, from whatever would say so without an
 * administrator.
 *
 * Deliberately coarse. The detailed figures — wear, reallocated sectors, hours
 * powered on, temperature — all live behind elevation on Windows and behind
 * root on Linux, and this app does not ask for either. What is left is still
 * the thing worth knowing: the storage stack's own verdict on each drive, which
 * on Windows is free and takes 64ms, and which turns from Healthy to Warning
 * before a disk dies rather than after.
 */
export interface DiskHealth {
  name: string
  /** The verdict, when there is one. `unknown` is a real and common answer. */
  status: 'ok' | 'warning' | 'bad' | 'unknown'
  kind: 'ssd' | 'hdd' | 'unknown'
  size: number | null
  /** Degrees Celsius, where a sensor source is running. */
  temperature: number | null
  /**
   * Percent of the drive's rated write life used up.
   *
   * The figure that says a solid-state drive is wearing out, and the one
   * Windows keeps behind an administrator. It arrives from a sensor source
   * instead — see `lhm.ts` — and is null without one.
   */
  wearPercent: number | null
  /** Hours the drive has been powered, which is the other half of its age. */
  powerOnHours: number | null
  /**
   * What the sensor source calls this drive, when that is not what the storage
   * stack calls it.
   *
   * Only ever different when there is an enclosure in the way: Windows reports
   * the USB bridge — `ADATA ED600` — and the sensor source reports the disk
   * inside it, `Samsung SSD 870 QVO 8TB`. Both are true of different things, so
   * neither replaces the other and the panel shows both.
   */
  model?: string
}

/**
 * One temperature, from whatever could be read without a driver.
 *
 * Almost always empty on Windows and macOS, and that is the honest outcome
 * rather than a gap to be filled: see `SystemStats` for why. On Linux the
 * kernel publishes CPU and NVMe temperatures to any process that can read a
 * file, so there they simply work.
 */
export interface TemperatureStats {
  /** `Core (Tctl/Tdie)`, `Composite Temperature` — whatever the sensor calls itself. */
  name: string
  celsius: number
  /**
   * What is being measured, because what counts as hot is not the same for
   * each: a processor at 75 is working, a drive at 75 is throttling itself and
   * losing endurance, and memory sits somewhere between.
   */
  kind: 'cpu' | 'gpu' | 'disk' | 'memory' | 'other'
  /** The hardware it belongs to, so a drive's reading can find its row. */
  device?: string
}

export interface NetworkStats {
  name: string
  /**
   * The addresses this interface is answering on, IPv4 first because that is
   * the one you can read off the screen and type somewhere else. Empty for an
   * interface that carries traffic without holding an address of its own.
   *
   * Loopback and IPv6 link-local are left out. Both are always present and
   * neither is ever the answer to "what is this machine's address".
   */
  addresses: string[]
  /** Bytes per second since the previous sample; null on the first. */
  rxPerSec: number | null
  txPerSec: number | null
  /** Cumulative counters since boot, which is what the rates are derived from. */
  rxTotal: number
  txTotal: number
}

export interface GpuStats {
  name: string
  /** Percent busy, or null when the source does not report it. */
  load: number | null
  /** Degrees Celsius. The one temperature available without a driver. */
  temperature: number | null
  memoryUsed: number | null
  memoryTotal: number | null
  /** Watts. */
  power: number | null
}

export interface BatteryStats {
  /** 0-100. */
  percent: number
  /** True while on mains. Null when the platform would not say. */
  charging: boolean | null
  /** Seconds left on the current charge, when the OS estimates one. */
  secondsLeft: number | null
  /**
   * How much of its designed capacity the battery has lost to age.
   *
   * The one figure that says whether the battery itself is still any good, as
   * opposed to how full it happens to be. Windows does not report it — this
   * comes from a sensor source, and is null without one.
   */
  wearPercent: number | null
  /** Watts going in or out right now. Positive charging, negative discharging. */
  rateWatts: number | null
  /** Watt-hours left, and what the pack holds now and when it was new. */
  remainingWh: number | null
  fullWh: number | null
  designWh: number | null
  /**
   * Full charge cycles the pack has been through.
   *
   * The other half of `wearPercent`, and on a Mac the number Apple itself puts
   * in System Information. A pack can read as unworn and still be old; a cycle
   * count says which of the two you are looking at.
   */
  cycleCount: number | null
}

/**
 * How close the machine is to throttling itself, in the OS's own words.
 *
 * Not a temperature and deliberately not presented as one. macOS will not give
 * a program a number in degrees without a native helper, but it will say
 * whether it is *comfortable*, which is the question a temperature is usually
 * standing in for. `nominal` is fine, `serious` and `critical` mean the machine
 * is already slowing itself down. Null on every other platform, which has no
 * equivalent.
 */
export type ThermalPressure = 'nominal' | 'fair' | 'serious' | 'critical'

/**
 * Where the weather and air readings come from.
 *
 * `open-meteo` is the default because it needs no key and no signup, so the
 * blocks work as soon as they know where you are. `openweathermap` is there
 * because the Rainmeter skin uses it and somebody who already has a key should
 * not have to abandon it.
 */
export type WeatherProvider = 'open-meteo' | 'openweathermap'

export const WEATHER_PROVIDERS: readonly { id: WeatherProvider; label: string; needsKey: boolean }[] = [
  { id: 'open-meteo', label: 'Open-Meteo (no key needed)', needsKey: false },
  { id: 'openweathermap', label: 'OpenWeatherMap', needsKey: true },
]

/**
 * A place worth keeping, so the blocks can be pointed somewhere else and back.
 *
 * Home and wherever the people you work with are is the ordinary case, and it
 * was two rounds of retyping a coordinate pair before this existed.
 *
 * The name is the identity: saving a place already on the list under the same
 * name moves the pin rather than adding a second entry, because two lines
 * reading `Athens` differing in the fourth decimal is not a list anybody can
 * use. Coordinates stay strings — they are what was typed, and rounding
 * somebody's input on the way past is not this list's business.
 */
export interface WeatherPlace {
  place: string
  lat: string
  lon: string
}

export interface Weather {
  /** The name you gave the place, or the provider's if it offers one. */
  place: string
  /** `clear sky`, `light rain` — the provider's own phrase. */
  description: string
  /** Degrees Celsius. */
  temperature: number | null
  feelsLike: number | null
  /** Percent. */
  humidity: number | null
  /** Hectopascals. */
  pressure: number | null
  /** Kilometres per hour, whichever provider answered. */
  windSpeed: number | null
  /** Degrees clockwise from north — where the wind is coming *from*. */
  windDegrees: number | null
}

/**
 * The air, in µg/m³ plus whatever index the provider computes.
 *
 * The index needs its scale carried with it, because the two providers use
 * different ones: Open-Meteo reports the European index, which runs from 0 to
 * past 100, and OpenWeatherMap reports 1 to 5. A bare number would be
 * unreadable and, worse, would look fine.
 */
export interface AirQuality {
  index: number | null
  scale: 'european' | 'owm'
  pm2_5: number | null
  pm10: number | null
  o3: number | null
  no2: number | null
  so2: number | null
  co: number | null
  nh3: number | null
}

/** What to ask, and of whom. */
/** One coin's price, and how it has moved. */
export interface CoinPrice {
  /** CoinGecko's id, which is what was asked for. */
  id: string
  /** The ticker, which is what goes on screen. */
  symbol: string
  price: number
  /** Percent over 24 hours, or null where the source did not say. */
  change24h: number | null
}

export interface CryptoReading {
  coins: CoinPrice[]
  /** The currency the prices are in, lower case as the API wants it. */
  currency: string
  at: number
  /** Why there is nothing, when there is nothing. */
  error?: string
}

export interface WeatherRequest {
  provider: WeatherProvider
  lat: number
  lon: number
  /** Only OpenWeatherMap needs one. Open-Meteo ignores it. */
  key?: string
  /** What to call the place, since a coordinate is not a name. */
  place?: string
}

export interface WeatherReading {
  weather: Weather | null
  air: AirQuality | null
  /** When this was fetched, so the block can say how old it is. */
  at: number
  /**
   * What went wrong, or `no-location` / `no-key` when nothing was asked at all.
   *
   * Those two are not failures and are not logged as such — they are the state
   * a block is in before it has been told where you are, and the block says
   * what to do about it rather than looking broken.
   */
  error: string | null
}

/** A process running under one of this app's panes. */
export interface ProcessInfo {
  pid: number
  parentPid: number
  name: string
  /** Full command line, capped. Empty when the OS would not hand it over. */
  commandLine: string
  /** TCP ports this process is listening on. */
  ports: number[]
  /** The pane whose shell it descends from. */
  paneId: string
  /** How deep below the pane's own shell, for indenting. */
  depth: number
}

/** One matching line from a workspace search. */
export interface SearchHit {
  /** Absolute path. */
  path: string
  line: number
  /** The matching line, trimmed and capped — this is drawn, not re-read. */
  text: string
}

/** One row in the file tree. */
export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  /** Epoch milliseconds. */
  modified: number
}

/**
 * Porcelain status letters keyed by absolute path: 'M' modified, 'A' added,
 * 'D' deleted, '?' untracked. Directories inherit the strongest status of
 * anything beneath them.
 */
export type GitStatusMap = Record<string, string>

/**
 * How panes are arranged inside a tab. A leaf is a single pane; a split holds
 * children laid out along one axis with fractional sizes that sum to 1.
 */
export type PaneNode =
  | { kind: 'leaf'; paneId: string }
  | { kind: 'split'; direction: 'row' | 'column'; sizes: number[]; children: PaneNode[] }

/** A horizontal tab within a workspace. */
export interface TerminalTabState {
  id: string
  /** Title set explicitly by the user via rename. Wins over the pane title. */
  customTitle: string | null
  panes: PaneState[]
  layout: PaneNode
  activePaneId: string
}

export type NotificationTrigger =
  | 'bell'
  | 'osc'
  | 'command-finished'
  | 'idle'
  | 'exit'
  | 'cli'
  | 'blocked'

export interface TerminalAlert {
  /** The pane that raised it — panes, not tabs, own shells. */
  paneId: string
  workspaceId: string
  trigger: NotificationTrigger
  title: string
  body: string
}

/** An alert once the renderer has recorded it for the notification panel. */
export interface NotificationRecord extends TerminalAlert {
  id: string
  at: number
  read: boolean
  /** Resolved at record time so the panel still reads well after a rename. */
  where: string
}

export interface NotificationSettings {
  enabled: boolean
  sound: boolean
  soundName: SoundName
  volume: number
  /** Only notify when the app window is unfocused or the pane isn't visible. */
  onlyWhenUnattended: boolean
  onBell: boolean
  onCommandFinished: boolean
  /** Commands shorter than this many seconds never notify on finish. */
  minCommandSeconds: number
  onIdle: boolean
  idleSeconds: number
  onExit: boolean
  /** Flash the taskbar button when a background pane needs attention. */
  flashTaskbar: boolean
}

export type SoundName = 'chime' | 'ping' | 'knock' | 'rise'

export interface Settings {
  shell: ShellKind
  customShellPath: string
  customShellArgs: string
  /** Inject OSC reporting into the shell for cwd tracking + command markers. */
  shellIntegration: boolean
  /**
   * The interface theme: app chrome, and the window properties that go with it
   * — transparency, backdrop, corner rounding, workspace markers.
   */
  themeId: string
  /**
   * The terminal theme, contributing its palette and nothing else: the five
   * core colours and the sixteen ANSI slots.
   *
   * Separate because these are the two things nobody publishes together. Every
   * shared colour scheme in the world — Ghostty, Windows Terminal, iTerm — is a
   * terminal palette with no opinion about a sidebar, which is why importing
   * one has to *invent* a chrome palette by mixing its background and
   * foreground. Splitting the selection means an imported scheme can be worn by
   * the terminal without dictating the app around it.
   *
   * Core and ANSI stay together on purpose: they are tuned against each other,
   * and a background from one scheme under an ANSI set from another is how text
   * ends up invisible.
   *
   * Absent means "same theme as the interface", which is what every existing
   * install has been doing.
   */
  terminalThemeId?: string
  /** Saved terminal palettes, including everything imported from Ghostty or WT. */
  customTerminalThemes?: TerminalTheme[]
  /** Saved interface themes: chrome, plus the window properties beside it. */
  customThemes: InterfaceTheme[]
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorBlink: boolean
  cursorStyle: 'block' | 'underline' | 'bar'
  scrollback: number
  /**
   * Lines kept for a pane you have not looked at in a while. 0 never trims.
   *
   * The largest thing this app holds is terminal buffers, and they only ever
   * grow: xterm allocates lines as output arrives and never gives them back
   * until the pane is closed. At two hundred columns a full ten-thousand-line
   * buffer is roughly twenty-four megabytes, per pane, for as long as the app
   * is open — and a session that visits twenty panes is holding twenty of them.
   *
   * So a pane nobody has looked at for half an hour keeps this many lines
   * instead. **This discards them**: the lines are gone from that pane, not
   * paged out, and switching back does not bring them back. That is why it is a
   * number you choose rather than something clever done behind your back, and
   * why the default is generous rather than tight.
   *
   * The trade is honest in the usual case: the panes holding the most are the
   * ones you opened once, watched a build in, and never returned to.
   */
  hiddenScrollback: number
  /**
   * Minutes an off-screen agent pane may idle before its shell is released.
   *
   * The largest thing this app *causes* is not its own memory, it is the agents
   * running in it: `claude.exe` sits at around half a gigabyte per pane and
   * brings a per-session MCP server and a conhost with it, so three panes
   * nobody is looking at were 1.5 GB of a 15 GB machine. Idle, resumable, and
   * expensive is an unusual combination, and it is worth acting on.
   *
   * After this many minutes off screen, such a pane's shell is ended. The pane
   * itself stays exactly where it was, with its screen, and says what happened;
   * the next key you press starts a shell and types `claude --resume <id>`, the
   * same line a restored pane types after the app restarts.
   *
   * Only ever agent panes — see `mayRelease`, which holds every condition and
   * the reason for each. 0 never releases anything.
   */
  idleAgentRelease: number
  /**
   * Whether a working agent keeps the machine awake.
   *
   * The problem it solves is the one that costs a whole night: an agent is
   * given a long job, the machine is left to get on with it, and it suspends
   * ten minutes later with the job a tenth done. Nothing is lost, but nothing
   * happened either, and you do not find out until the morning.
   *
   * `'ac'` is the default and is the reason this is three values rather than a
   * checkbox. On a desktop it is indistinguishable from `'on'`, because a
   * desktop is always on mains. On a laptop it does the thing you would have
   * chosen anyway: hold the machine up while it is plugged in, and never hold
   * a battery open on its behalf. A flat battery in a bag is a worse outcome
   * than a job that waited.
   *
   * What holds the machine awake is `'working'` and only `'working'` — see
   * `shared/powerLock.ts`, which owns the decision and explains why an agent
   * parked on a permission prompt deliberately does not count.
   */
  keepAwake: KeepAwakeMode
  /**
   * Draw with the processor instead of the graphics card.
   *
   * Off, because the card is faster at what a terminal does and every machine
   * with one should use it. On, for the machine where the *memory* matters more
   * than the speed: measured here, the GPU process alone held 267 MB of a
   * 15 GB machine, and switching it off gives most of that back. Terminals then
   * draw through xterm's DOM renderer, which is slower — noticeably so on a
   * full-screen program repainting constantly, and not at all at a prompt.
   *
   * Also the thing to try when the graphics driver is unstable. This app has
   * seen a `VIDEO_MEMORY_MANAGEMENT_INTERNAL` bugcheck on a machine running it,
   * and while the cause of that was ours — a WebGL context per pane, never
   * released, past the limit Chromium allows — a driver that keeps falling over
   * is a driver worth taking out of the picture.
   *
   * Read once, before the window exists, because that is the only moment
   * Electron accepts it. Changing it needs a restart, and the setting says so.
   */
  useSoftwareRendering: boolean
  /**
   * Which coins the crypto block shows, and in what.
   *
   * Written the way people talk — `btc, eth, ltc` — and turned into the ids the
   * API wants in `parseCoins`, which also passes anything it does not recognise
   * straight through so an unusual coin still works.
   */
  cryptoCoins: string
  /** Three letters: `eur`, `usd`, `gbp`. Whatever CoinGecko will quote in. */
  cryptoCurrency: string
  /** Folder a workspace created from the + button starts in. Blank = home. */
  newWorkspaceDir: string
  /**
   * The page a new browser pane opens on.
   *
   * A setting rather than a constant because the answer is personal and it
   * changes: it is the dev server you usually run, or the docs you always have
   * open. Blank falls back to the built-in default.
   */
  browserHome: string
  /** Ctrl+C copies when there is a selection instead of sending SIGINT. */
  copyOnSelectionCtrlC: boolean
  confirmCloseRunning: boolean
  /** Show the current git branch beside each workspace. */
  showGitBranch: boolean
  /**
   * Show how many tabs each workspace holds, beside its name.
   *
   * Off by default: it is a number that changes constantly and answers a
   * question nobody asks, and the sidebar is calmer without it.
   */
  showTabCount: boolean
  /**
   * Mark a workspace when another machine has work in it you have not seen.
   *
   * On by default, unlike the other two, because it is not a preference about
   * what a list looks like — it is the whole of what Relay reports, and it only
   * ever appears when there is something to report. Off is for somebody who
   * works on one machine and does not want to be told about it.
   *
   * Needs a shared folder set to show anything at all. See `relay.ts`.
   */
  showRelayWarning: boolean
  /**
   * A folder every machine you work from can see — a synced drive, a share.
   *
   * One folder for the two features that need one: token totals pooled across
   * machines (`tokenShare.ts`) and Relay (`relay.ts`). Each makes its own
   * subfolder inside it, so what they write stays separable even though what
   * they are pointed at is not.
   *
   * Blank, which is off, and blank is also the entire switch. There is no
   * companion toggle, which means the two states a toggle makes possible — on
   * with nowhere to write, off with a path sitting there looking live — simply
   * do not exist. Off is the honest default: this reads and writes files
   * somewhere the user chose, and nothing should start doing that on its own.
   *
   * Was `tokenShareDir`, when only one feature used it. `normalize` in
   * `state.ts` carries the old key over.
   */
  sharedDir: string
  /**
   * What leaves the app when a file is dragged out of it.
   *
   * `file` starts an operating-system drag, so the file itself arrives in
   * FileZilla, an upload box or a mail attachment. `path` puts the location on
   * the drag as text, which is what every part of *this* app reads and what a
   * terminal wants typed at a prompt.
   *
   * `auto`, the default, is `file` for anything that is a real file on this
   * machine and `path` for anything that is not — a folder inside WSL has a
   * Windows path that looks like a location and is not one the rest of the
   * desktop can open, and starting a file drag for it would hand other programs
   * something they cannot use.
   *
   * A setting rather than a decision, because the right answer depends on what
   * somebody spends the day dragging *into*, and both answers are defensible.
   */
  fileDrag: 'auto' | 'file' | 'path'
  /**
   * Publish the commands you run to the shared folder, for the other machines.
   *
   * Off, and off is not merely the default — this is the one thing Relay can
   * publish that is dangerous in the clear, so it is opt-in and it does nothing
   * at all without a passphrase. A command line carries bearer tokens,
   * connection strings and whatever somebody pasted, and a synced folder keeps
   * version history that outlives any deletion.
   *
   * Commands are redacted for the obvious shapes and then encrypted; neither is
   * a guarantee and both are described where the setting is. See
   * `shareCrypto.ts`.
   */
  shareCommands: boolean
  /**
   * Extra columns beside each name in the file tree: how big a file is, and
   * when it last changed.
   *
   * Both off by default. The tree is a place to find a file and open a shell
   * next to it, not a file manager, and two columns of numbers is what turns a
   * narrow pane into something you have to read rather than glance at. They are
   * switched from the tree's own menu, where the folder you are looking at is.
   */
  treeShowSize: boolean
  treeShowModified: boolean
  /**
   * How the file tree orders each folder. Folders lead whatever this says.
   *
   * A setting rather than per-pane state: "newest first" is how you are working
   * that afternoon, not a property of one folder, and two trees side by side
   * sorted differently is a bug report waiting to happen.
   */
  treeSort: TreeSort
  treeSortDesc: boolean
  /**
   * What a new images pane starts as. Each pane then owns its own — you might
   * want one folder as a contact sheet and another as a board.
   */
  imageLayout: ImageLayout
  imageSort: ImageSort
  imageSortDesc: boolean
  /**
   * How images are resampled. `smooth` for photographs, `pixel` for pixel art,
   * where the blur a default filter adds is the thing being examined.
   */
  imageFilter: ImageFilter
  /** Include images in subfolders, not just the folder itself. */
  imageRecursive: boolean
  /**
   * Shrink the arrangement until all of it fits without scrolling.
   *
   * Off by default: with a hundred images "fits" means postage stamps, and the
   * useful default is a readable size you scroll through. It is the toggle you
   * reach for with a dozen references open at once, which is the PureRef case.
   */
  imageFit: boolean
  /**
   * Show Claude Code's 5-hour and 7-day limit usage in the status bar.
   *
   * Reads Anthropic's usage endpoint with the OAuth token Claude Code is
   * already signed in with, every few minutes. On by default because it is the
   * number you want before starting something long, and off is one switch away.
   */
  showUsageMonitor: boolean
  /**
   * Show this machine's load, memory, disk and network under the usage rows.
   *
   * Four lines rather than the whole monitor pane: the question the sidebar
   * answers is "is the machine coping", and the pane is there for "with what".
   * Off by default, unlike the usage rows above it — those come from a network
   * call this app makes anyway, and this one starts a small process every few
   * seconds, which is not a thing to switch on for somebody without asking.
   */
  showSystemMonitor: boolean
  /**
   * Keep each pane's screen on disk so a restored pane comes back with what it
   * was showing. Only reached when the shell itself did not survive — see
   * `keepSessionsAlive`.
   */
  restoreScrollback: boolean
  /**
   * Whether shells outlive the app.
   *
   * On, the pseudo-terminals are owned by the session broker rather than by
   * this process, so quitting detaches and reopening reattaches to the same
   * live shells. Off, they run in-process and end with the window, which is
   * what this app did before the broker existed.
   *
   * Worth offering rather than assuming: a background process holding shells
   * open is exactly the kind of thing somebody may not want on a shared or
   * locked-down machine, and "my terminals keep running after I quit" is a
   * surprise if you did not ask for it.
   */
  keepSessionsAlive: boolean
  /**
   * What an editor does when the file under it changes on disk.
   *
   * `auto` re-reads a pane with nothing unsaved in it, which is what a file
   * changed by a build, a formatter or another program should look like: the
   * new text, without being asked about it. `ask` puts a bar up instead, for
   * anyone who would rather nothing moved under them.
   *
   * A pane *with* unsaved edits always asks, whatever this says. Both versions
   * matter then, and there is no answer the app can pick that is not a guess
   * about which one somebody wants to keep.
   */
  refreshChangedFiles: 'ask' | 'auto'
  /**
   * Re-enter the agent conversation a pane was in when it comes back, by
   * running `claude --resume <id>` at its first prompt. Needs the Claude Code
   * integration, which is what reports the session id in the first place.
   */
  resumeAgentSessions: boolean
  /**
   * Program that "Open in editor" hands a file to. Blank means whatever Windows
   * associates with the extension.
   *
   * The reader pane is read-only on purpose — editing means save semantics,
   * encodings, conflict handling and eventually a language server — so this is
   * how a file gets edited: by the editor you already use.
   */
  externalEditor: string
  /**
   * Where the weather and air blocks look, and which service answers.
   *
   * Empty coordinates mean the blocks say so and ask nothing of the network —
   * see `readWeather`. The key is only read by the provider that needs one.
   */
  weatherProvider: WeatherProvider
  weatherPlace: string
  weatherLat: string
  weatherLon: string
  weatherKey: string
  /**
   * Places kept to switch between, in the order they were saved.
   *
   * Separate from the three fields above, which are the one in *use*: a saved
   * place is a bookmark, and the block reads from the location, not from the
   * list. That split is what lets somebody try a coordinate without disturbing
   * the places they keep, and it is why nothing here needed migrating — a
   * document written before this has no list and one location, which is exactly
   * what it had before.
   *
   * The provider and the key are not part of a place. A key belongs to an
   * account and a provider is a preference about who to ask; neither changes
   * because you looked at a different city.
   */
  weatherPlaces: WeatherPlace[]
  /** "Open in ia_workspaces" on folder right-click. Writes to HKCU. */
  explorerContextMenu: boolean
  /** Which glyph marks a nested workspace. See `NestingMarker`. */
  nestingMarker: NestingMarker
  /**
   * Whether we may write outside our own data folder — currently `~/.claude`.
   * Asked once; `declined` is remembered so we stop asking, and switching back
   * to `declined` undoes whatever was installed.
   */
  agentIntegration: ConsentState
  /**
   * Look for a newer release once, shortly after the window opens.
   *
   * A check that runs on every launch is the only kind that catches an update
   * you were not already looking for, which is the point — but it is also a
   * network call the app makes without being asked, so it is a switch.
   */
  checkUpdatesAtStartup: boolean
  notifications: NotificationSettings
}

export type ConsentState = 'unset' | 'granted' | 'declined'

/**
 * The outcome of one update check.
 *
 * `unconfigured` is a state rather than an error on purpose: no release feed
 * has been chosen for this app yet, and "nowhere to look" is a different thing
 * from "looked and it failed". The UI says so plainly instead of showing a
 * failure the user cannot act on.
 */
export type UpdateCheck =
  | { state: 'current'; current: string }
  | { state: 'available'; current: string; latest: string; url?: string }
  | { state: 'unconfigured'; current: string }
  | { state: 'error'; current: string; error: string }

/** The newest release GitHub knows about. See `main/updates.ts`. */
export interface LatestRelease {
  /** The version, with the tag's `v` removed. */
  version: string
  /** The release page, for the notice that offers to open it. */
  url: string
}

/**
 * What the host found, or why it could not look.
 *
 * A result rather than a thrown error: this crosses an IPC boundary, where an
 * exception arrives wrapped in "Error invoking remote method" with the real
 * message buried inside it — and the settings panel prints what it is given.
 * `release: null` is a repository with nothing published yet, which is an
 * answer and not a failure.
 */
export type LatestReleaseResult =
  | { ok: true; release: LatestRelease | null }
  | { ok: false; error: string }

/**
 * The glyph marking a nested workspace in the sidebar.
 *
 * `hook` (⎿) is a bracket part rather than an arrow, so it reads as structure —
 * this row belongs to the one above — instead of as movement. `curve` (⤷) and
 * `corner` (↳) are the two arrows; the corner is in far more fonts, which
 * matters because ⤷ is missing from the sidebar's own font and has to borrow
 * one. `none` is for anyone who finds the indent enough.
 */
export type NestingMarker = 'hook' | 'curve' | 'corner' | 'none'

export const NESTING_GLYPHS: Record<NestingMarker, string> = {
  hook: '⎿',
  curve: '⤷',
  corner: '↳',
  none: '',
}

export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

/** The full persisted document, written to userData/workspace.json. */
export interface PersistedState {
  version: number
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sidebarWidth: number
  sidebarCollapsed: boolean
  /** Shared by every workspace that shows a docked tree. */
  treeWidth: number
  /** Where the grip sits in each half of the git pane, shared by every git pane. */
  gitFilesWidth: number
  gitHistoryWidth: number
  /**
   * Where the machine monitor is docked, and how big it is.
   *
   * Beside the window size rather than inside a workspace, because what it
   * shows is a property of the machine and not of any project — the reason it
   * stopped being a tab. Opening a different workspace should not move it or
   * close it, and it does not.
   */
  monitorDock: MonitorDock
  monitorDockSize: number
  /**
   * Blocks of the system monitor the user has turned off, by id.
   *
   * Held as what is *hidden* rather than what is shown, so a block added in a
   * later version arrives switched on instead of invisible until somebody
   * finds the menu. The ids are `MONITOR_BLOCKS`.
   */
  monitorHidden: string[]
  /**
   * The order the blocks are drawn in, by id.
   *
   * Partial on purpose: anything not named here is drawn after whatever is, in
   * the order `MONITOR_BLOCKS` states. So a block added in a later version
   * appears at the bottom of a rearranged panel rather than vanishing, and a
   * document written before this existed needs no migration at all.
   */
  monitorOrder: string[]
  window: WindowState
  settings: Settings
}

/** Which edge the monitor is attached to, or `off` when it is not shown. */
export type MonitorDock = 'off' | 'left' | 'right' | 'top' | 'bottom'

/**
 * The blocks the system monitor can show, in the order it shows them.
 *
 * A list rather than a set of booleans so the order is stated once and the
 * right-click menu, the renderer and the persisted document cannot disagree
 * about it. `drives` is the one that costs something to collect — see
 * `readSystemStats` — so turning it off buys back a process every five seconds
 * rather than only shortening the panel.
 *
 * `drives` and `volumes` are two entries here and one block on screen. They are
 * two questions about one piece of hardware — how the disk is doing, and how
 * full the letters on it are — and people want different halves of that, so
 * each is switchable. But a volume drawn away from the drive it sits on loses
 * the thing that makes it worth grouping, so when both are on they are drawn as
 * a single block, with the letters under the drive they are on. With `drives`
 * off, `volumes` is a block of its own; with `volumes` off, the drives are
 * hardware only. See `render` in `monitorPane`.
 */
export const MONITOR_BLOCKS = [
  { id: 'cpu', label: 'processor, memory and temperature' },
  { id: 'gpu', label: 'graphics' },
  { id: 'network', label: 'network' },
  { id: 'drives', label: 'drives and health' },
  { id: 'volumes', label: 'volumes — size, used and free' },
  { id: 'temperatures', label: 'temperatures' },
  { id: 'claude', label: 'claude usage limits' },
  // No per-project token block here, deliberately. This panel answers "is the
  // machine coping"; how much a project has cost is a question about the
  // project, and it is answered where the project is — on the workspace itself,
  // on hover. See `tokenTooltip`.
  // What this app itself costs, split by the process doing the spending. On a
  // machine that is short of memory the next question after "what is using it"
  // is always "how much of that is you", and answering it anywhere else would
  // be this panel declining to measure the one process it is inside.
  { id: 'app', label: 'this app’s own processes' },
  { id: 'crypto', label: 'crypto prices' },
  { id: 'system', label: 'battery and uptime' },
  { id: 'weather', label: 'weather' },
  { id: 'air', label: 'air quality' },
] as const

export type MonitorBlock = (typeof MONITOR_BLOCKS)[number]['id']

/**
 * One shell the session broker is holding.
 *
 * Reported so that shells kept alive on the user's behalf are something they
 * can *see*. A background process quietly holding terminals open is a
 * reasonable thing to want and an unreasonable thing to have to take on trust —
 * and between a pane being removed and the orphan sweep noticing, this is the
 * only way to know a shell is still there.
 */
export interface HeldSession {
  /** The pane id it was started for. Still the handle used to end it. */
  id: string
  alive: boolean
  pid: number
  startedAt: number
  /** How many windows are currently showing it. */
  attached: number
}

export interface SessionHostInfo {
  /**
   * `broker` — shells outlive the app. `local` — they end with the window,
   * either by choice or because no broker could be started. `connecting` —
   * nothing has needed a shell yet, so the question has not been asked.
   */
  kind: 'broker' | 'local' | 'connecting'
  sessions: HeldSession[]
}

/** One archived pane transcript. See `src/main/vault.ts`. */
export interface VaultEntry {
  /** Absolute path to the text file, which the editor pane opens directly. */
  path: string
  label: string
  at: number
  bytes: number
}

/** One remembered command line. See `src/main/history.ts`. */
export interface HistoryEntry {
  command: string
  /** Where it was run, which is often the thing that identifies it. */
  cwd: string
  /** Epoch milliseconds of the most recent time it was submitted. */
  at: number
  /**
   * The pane it was last submitted in.
   *
   * The list is deliberately shared across panes, so this is not used to
   * partition it — it is what makes a "just this pane" filter possible without
   * a second store. Absent on entries written before it was recorded.
   */
  paneId?: string
  /**
   * How many times this exact line has been submitted in this folder.
   *
   * The list has always deduplicated — re-running a command moves it back to
   * the top rather than adding a second row — which means every entry was
   * already one-per-unique-command and had nowhere to put a count. Absent on
   * entries written before this existed, and read as 1.
   */
  runs?: number
  /** How many of those runs ended in a non-zero exit code. */
  fails?: number
  /**
   * What the most recent run exited with, once it has finished.
   *
   * Undefined means "not known", which covers three real cases and is why this
   * is not defaulted to 0: a command still running, a pane with no shell
   * integration to report the code, and every entry recorded before this field
   * existed. "Not known" and "succeeded" must not look the same.
   */
  lastCode?: number
  /** How long the most recent run took, in milliseconds. */
  lastMs?: number
  /**
   * The machine this came from, when it is not this one.
   *
   * Set only for entries assembled from what Relay read out of the shared
   * folder — never written to the history file, which is this machine's own
   * account. Its presence is what lets a recall list say where a command came
   * from, which matters when the answer is "a Mac" and you are on Windows.
   */
  elsewhere?: string
}

/**
 * A stretch of time spent on one project.
 *
 * Observed rather than entered — see `timeLog.ts` for what opens and closes
 * one, and why focus is the signal rather than keystrokes.
 */
export interface TimeSpan {
  /** The workspace's folder, which identifies the project across renames. */
  cwd: string
  /** What it was called while the time was being spent. */
  name: string
  start: number
  end: number
}

/** One checkout of a repository. See `src/main/worktrees.ts`. */
export interface Worktree {
  /** Absolute path to the checkout. */
  path: string
  /** Branch name, or undefined for a detached HEAD. */
  branch?: string
  head?: string
  /** True for the repository's own main checkout, which cannot be removed. */
  main: boolean
  locked: boolean
  /** Git thinks the directory is gone. Still registered, still removable. */
  prunable: boolean
}

/**
 * One changed file, as the changes pane needs it.
 *
 * `picked` and `changed` are deliberately separate rather than one status
 * letter, because a file can be both at once: pick it, edit it again, and part
 * of it is going into the next save while part of it is not. Git's own
 * porcelain says this with two columns, and flattening them to one is how a
 * changes pane ends up quietly lying about what is about to be saved.
 */
export interface ChangedFile {
  /** Absolute path on disk. */
  path: string
  /** Path relative to the repository root, with forward slashes, as git says it. */
  repoPath: string
  /** What is picked (staged) for the next save: git's first porcelain letter. */
  picked: GitChange
  /** What is changed and *not* picked: git's second porcelain letter. */
  changed: GitChange
  /** Git has never been told about this file. */
  untracked: boolean
  /** Both sides changed the same lines, and git is waiting for an answer. */
  conflicted: boolean
  /** Where it came from, for a rename or a copy. */
  from?: string
}

/**
 * What happened to a file, in git's porcelain letters.
 *
 * Kept as git's own letters rather than translated here: this is data, the
 * translation is presentation, and a pane that receives "M" can decide whether
 * it has room for "changed" or only for one character.
 */
export type GitChange = '' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?'

/** Where a repository stands: everything the panes' headline says. */
export interface RepoStatus {
  /** Absolute path of the repository root, or '' when this folder is not in one. */
  root: string
  /** The line of saves (branch) you are on, or undefined when off to one side. */
  branch?: string
  /** True when sitting on one save rather than on a branch — a detached HEAD. */
  detached: boolean
  /** The short number (hash) of the save you are on. */
  head?: string
  /**
   * The same number in full.
   *
   * Kept beside the short one rather than replacing it, because the two are for
   * different things: the short one is what a person reads, and the full one is
   * what gets compared against `unsent` to answer "has this actually left this
   * machine" — a comparison that a seven-character prefix would get right until
   * the day a project grew two saves sharing one.
   */
  headFull?: string
  /** The branch on GitHub this one is paired with, like `origin/main`. */
  upstream?: string
  /** Saves you have that GitHub has not. */
  ahead: number
  /** Saves GitHub has that you have not. */
  behind: number
  /** Whether the repository has a copy elsewhere (a remote) at all. */
  hasRemote: boolean
  /** The URL of `origin`, shown so "GitHub" is never a guess. */
  remoteUrl?: string
  files: ChangedFile[]
  /**
   * The saves you have made that GitHub has not got, by full number (hash).
   *
   * The count alone would have done for the headline, but not for the picture:
   * this is what lets the history pane mark the exact rows that exist only on
   * this machine, which is the single most useful thing that pane can say and
   * the one people most often get wrong about git.
   */
  unsent: string[]
  /**
   * A rebase, merge or cherry-pick that stopped part-way and is waiting.
   *
   * The panes refuse to save or send while this is set, because a save made in
   * the middle of one of these means something different from an ordinary save
   * and the buttons would be lying about what they do.
   */
  inProgress?: 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect'
  /**
   * The save you are standing on, named.
   *
   * Here so the two operations that act on it can say which one they mean —
   * "Add to 'fixed the parser'" rather than "Amend" — and undefined in a project
   * whose first save has not been made, which is the state the publish flow
   * exists for.
   */
  lastSave?: { sha: string; subject: string }
}

/**
 * Narrowing the list of saves down to the ones being looked for.
 *
 * Four separate fields rather than one search box, because they are four
 * genuinely different questions and git answers them with four different flags.
 * The one people reach for and never find is `content`: "when did this line of
 * code appear", which no amount of reading commit messages will answer.
 */
export interface HistoryFilter {
  /** Text in the save's message. */
  text?: string
  /** Who made it. */
  author?: string
  /** Only saves that touched this file, as a path inside the project. */
  path?: string
  /** Only saves where this text started or stopped appearing in the code. */
  content?: string
}

/**
 * What git is doing right now, while it is doing it.
 *
 * Every operation in the git pane used to be a button that went dead and a
 * toast some seconds later, and for a push over a slow connection that is a
 * minute of a frozen window with nothing to say whether it is working, stuck,
 * or waiting on a password prompt it cannot show. Git itself knows exactly what
 * it is doing and says so — it simply says it to a terminal that is not there.
 * This is that, carried out to the pane.
 *
 * Addressed by `cwd` rather than by an operation id, because the pane already
 * passes its own folder to every call it makes: the events for an operation
 * come back tagged with the same string that started it, and two panes on one
 * repository both light up, which is right.
 */
export interface GitProgress {
  /** The folder the operation was asked for, exactly as the caller gave it. */
  cwd: string
  /** Which operation: `send`, `bring-in`, `peek`, `pick`, `publish`. */
  op: string
  /** Git's own phase name — "Writing objects" — kept so it matches what it prints. */
  phase: string
  /** The same thing in plain words, which is what actually goes on screen. */
  plain: string
  /** 0–100, when git gives a percentage. Absent for the phases that have none. */
  percent?: number
  current?: number
  total?: number
  /** True when this phase is happening on the far end rather than here. */
  remote?: boolean
  /** The file being dealt with, for the operations that name them. */
  file?: string
  /** The last event of an operation, whether it worked or not. */
  done?: boolean
}

/**
 * A host's own command-line tool, and whether it can be used.
 *
 * Installed and signed in are separate because they need separate sentences:
 * one is "you could install this", the other is "run `gh auth login` once".
 */
export interface HostTool {
  /** The program name, which is also how the publish flow asks for it back. */
  command: string
  host: 'github' | 'gitlab'
  label: string
  installed: boolean
  signedIn: boolean
  /** What it said when it refused, for the times that is worth showing. */
  note?: string
}

/** One save (commit), as the history pane draws it. */
export interface Commit {
  sha: string
  short: string
  parents: string[]
  subject: string
  body: string
  author: string
  email: string
  /** Epoch milliseconds, so the renderer can say "2 hours ago" itself. */
  at: number
  /** Branch names, tags and HEAD pointing at this save. */
  refs: CommitRef[]
}

export interface CommitRef {
  name: string
  kind: 'head' | 'branch' | 'remote' | 'tag'
}

/** One line of saves (branch), local or on the copy elsewhere. */
export interface Branch {
  name: string
  /** True for the one you are on. */
  current: boolean
  /** True for a branch that lives on GitHub rather than here. */
  remote: boolean
  upstream?: string
  ahead: number
  behind: number
  /** The newest save on it, so the list can say when it was last touched. */
  head?: string
  at?: number
  subject?: string
  /** The folder a worktree has this branch checked out in, if one does. */
  checkedOutAt?: string
}

/**
 * What came back from an operation that changes something.
 *
 * `error` carries git's own message rather than one of ours — "contains
 * modified or untracked files, use --force to delete it" is precisely what the
 * user needs to read, and nothing we compose would beat it. `hint` is the
 * plain-English sentence the pane adds *beside* it, never instead of it.
 */
export interface GitResult {
  ok: boolean
  error?: string
  hint?: string
  /** Anything git said on the way, shown when it is worth reading. */
  output?: string
}

/** One agent whose hooks Settings can install, and whether they are in place. */
export interface AgentConfigInfo {
  id: string
  label: string
  /** Absolute path to the agent's own settings file, shown so it is not a mystery. */
  path: string
  exists: boolean
  hooksInstalled: boolean
  /** A step installing cannot do for the user, if this agent has one. */
  note?: string
}

export interface SpawnRequest {
  paneId: string
  workspaceId: string
  cwd: string
  shell: ShellKind
  cols: number
  rows: number
  /** Agent conversation to pick back up once the shell has drawn a prompt. */
  resumeSession?: AgentSession
  /** Which distribution, when `shell` is `wsl`. Blank means WSL's default. */
  wslDistro?: string
  /** Which host, when `shell` is `ssh`. Blank leaves the pane unspawned. */
  sshHost?: string
}

/**
 * Where a shell that is not on this machine connects to.
 *
 * Two shells need one, for different reasons, and passing them around as a
 * single value is what stops every function that carries one from growing a
 * second parameter and a second `if`. Both fields are optional and at most one
 * is ever set — `shellTargetFor` is what guarantees that.
 */
export interface ShellTarget {
  /** Which distribution, when the shell is `wsl`. */
  wslDistro?: string
  /** Which host, when the shell is `ssh`. */
  sshHost?: string
}

/**
 * Keeps only the field the chosen shell actually uses.
 *
 * The rule this enforces is that a target belongs to the shell that asked for
 * it. Switching a pane from WSL to zsh must forget the distribution, or
 * switching back later would silently reuse a distro you last chose months ago;
 * switching from WSL to SSH must not leave both fields set, or the persisted
 * document would say two contradictory things about one pane.
 */
export function shellTargetFor(
  shell: ShellKind | undefined,
  target: ShellTarget | undefined
): ShellTarget {
  if (shell === 'wsl') return target?.wslDistro ? { wslDistro: target.wslDistro } : {}
  if (shell === 'ssh') return target?.sshHost ? { sshHost: target.sshHost } : {}
  return {}
}

/**
 * Whether this pane's shell runs on a different machine.
 *
 * The question every local-filesystem feature has to ask before it uses a
 * pane's `cwd`. WSL deliberately answers false: its directories are real local
 * paths under `\\wsl.localhost\…`, which is the whole reason the file tree and
 * git status work inside a WSL workspace without knowing what WSL is. SSH
 * answers true, and there is nothing to be done about it — the folder is on
 * another machine and no local call can reach it.
 */
export function isRemoteShell(shell: ShellKind | undefined): boolean {
  return shell === 'ssh'
}

/** Payload pushed from main to renderer for every batch of PTY output. */
export interface PtyOutput {
  paneId: string
  data: string
}

export interface PtyExit {
  paneId: string
  exitCode: number
  signal?: number
}

/** Live cwd / title updates parsed out of the PTY stream in the main process. */
export interface TerminalMeta {
  paneId: string
  cwd?: string
  title?: string
  /** Reported by the agent's SessionStart hook; recorded against the pane. */
  agentSession?: AgentSession
  /** The command line just submitted, from shell integration's OSC 133;E. */
  lastCommand?: string
}

/**
 * Whether a pane is currently producing sustained output.
 *
 * Observed from throughput alone, so it is available for every pane including
 * the ones with no shell integration. It says a pane is busy; it deliberately
 * says nothing about *why* it stopped — that is what the declared agent state
 * below is for.
 */
export type PaneActivity = 'active' | 'idle'

/** State an agent declares about itself, never inferred. */
export type AgentRunState = 'blocked' | 'working' | 'idle' | 'unknown'

/**
 * One answer a blocked agent will accept.
 *
 * The agent supplies both the label a human reads and the exact bytes that
 * pick it, because we are a relay and not an interpreter: we do not know how to
 * answer a Claude Code permission prompt or somebody's custom menu, and
 * guessing would make us depend on their UI never changing.
 */
export interface AgentChoice {
  id: string
  label: string
  /** A key name from the closed vocabulary in `agentState.ts`. */
  key?: string
  /** Literal text, as an alternative to a key. */
  text?: string
  /** Picked when an answer names no choice. */
  isDefault?: boolean
}


export interface PaneAgentState {
  paneId: string
  state: AgentRunState
  /** True while the agent is parked on a human. */
  awaitingHuman: boolean
  /** Refcount, so a nested subagent finishing can't clear the outer run. */
  runDepth: number
  blockedReason: string | null
  choices: AgentChoice[]
  /** When an answer was last relayed in, or null. */
  answeredAt: number | null
  model?: string
  contextPct?: number
  tokens?: string
  /**
   * When this pane last reported anything, as epoch milliseconds.
   *
   * Exposed for the wake lock, which cannot trust `state` on its own. Nothing
   * expires `runDepth`: an agent that is killed, or whose `runEnd` hook never
   * fires, stays `'working'` for as long as the app runs. On a badge that is a
   * cosmetic lie. On something holding a laptop open it is a flat battery by
   * morning, and an invisible one, because a machine failing to sleep is not a
   * thing anybody notices in time.
   *
   * So the lock reads this instead and stops counting a pane that has gone
   * quiet. The badge stays optimistic, which is the right behaviour for a
   * badge; the lock is made sceptical, which is the right behaviour for a lock.
   */
  updatedAt: number
}

/** Pushed whenever a pane's observed activity or declared state changes. */
export interface PaneStatus {
  paneId: string
  activity?: PaneActivity
  agent?: PaneAgentState
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  enabled: true,
  sound: true,
  soundName: 'chime',
  volume: 0.5,
  onlyWhenUnattended: true,
  onBell: true,
  onCommandFinished: true,
  minCommandSeconds: 20,
  onIdle: false,
  idleSeconds: 30,
  onExit: false,
  flashTaskbar: true,
}

export const DEFAULT_SETTINGS: Settings = {
  shell: 'powershell',
  customShellPath: '',
  customShellArgs: '',
  shellIntegration: true,
  themeId: 'graphite',
  customThemes: [],
  customTerminalThemes: [],
  fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
  fontSize: 14,
  // Must be 1: any padding between rows breaks the box-drawing characters that
  // TUIs like Claude Code draw their frames with — `│` stops meeting the `│`
  // on the row below and the border comes out as dashes.
  lineHeight: 1,
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 10000,
  hiddenScrollback: 2000,
  // Off. It ends processes, and a default that ends processes has to be one the
  // user chose — the setting explains the trade and the memory it gives back.
  idleAgentRelease: 0,
  // Mains-only. See the field: it is `'on'` on every desktop, and the safe
  // choice on every laptop, so it is the one default that needs no warning.
  keepAwake: 'ac',
  useSoftwareRendering: false,
  cryptoCoins: 'btc, eth, ltc',
  cryptoCurrency: 'eur',
  // Blank means the home folder, which is the only sensible default on a
  // machine we know nothing about.
  newWorkspaceDir: '',
  browserHome: '',
  copyOnSelectionCtrlC: true,
  confirmCloseRunning: true,
  showGitBranch: true,
  showTabCount: false,
  showRelayWarning: true,
  sharedDir: '',
  fileDrag: 'auto',
  shareCommands: false,
  treeShowSize: false,
  treeShowModified: false,
  treeSort: 'name',
  treeSortDesc: false,
  imageLayout: 'rows',
  imageSort: 'name',
  imageSortDesc: false,
  imageFilter: 'smooth',
  imageRecursive: false,
  imageFit: false,
  showUsageMonitor: true,
  showSystemMonitor: false,
  restoreScrollback: true,
  keepSessionsAlive: true,
  refreshChangedFiles: 'auto',
  resumeAgentSessions: true,
  externalEditor: '',
  weatherProvider: 'open-meteo',
  weatherPlace: '',
  weatherLat: '',
  weatherLon: '',
  weatherKey: '',
  weatherPlaces: [],
  explorerContextMenu: false,
  nestingMarker: 'hook',
  agentIntegration: 'unset',
  checkUpdatesAtStartup: true,
  notifications: DEFAULT_NOTIFICATIONS,
}

/**
 * The colours a workspace can be marked with.
 *
 * Two rows of eight. The first row is the original set and stays first, so the
 * colour a workspace was assigned by position does not move when the palette
 * grows. The second is the same hues at a different weight plus the gaps the
 * first row left — pink, indigo, teal-green, brown — chosen to stay apart from
 * each other at 8px, which is the size the sidebar dot actually is.
 */
export const WORKSPACE_COLORS = [
  '#8f8f8f',
  '#7fb069',
  '#e8873a',
  '#b48ead',
  '#e0614f',
  '#54b0ac',
  '#d9a84e',
  '#6f9ec9',
  '#c9738f',
  '#4f9d5d',
  '#c25f2c',
  '#8b7fd4',
  '#a8443c',
  '#3d8f9e',
  '#a8862f',
  '#4a72a8',
] as const

/**
 * What the clipboard is offering as a picture.
 *
 * The two are not the same thing and cannot be handled the same way. `file` is
 * an image somebody copied in Finder or Explorer, and the path is the whole
 * answer — the pasteboard's *picture* for that copy is the file's icon, which
 * is how a screenshot pasted as a generic PNG document. `pixels` is a screen
 * capture, which exists only on the clipboard and has no path to give.
 */
export interface ClipboardImage {
  /** An image file the clipboard points at, if it points at one. */
  file: string | null
  /** Whether there are pixels on the clipboard worth a paste keystroke. */
  pixels: boolean
}
