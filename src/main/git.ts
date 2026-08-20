/**
 * Everything the two git panes ask git to do.
 *
 * The existing changes pane deliberately did nothing but read: staging and
 * committing were "destructive-ish operations with a lot of edge cases", and
 * there was a shell one pane away that already did them properly. That was the
 * right call for a pane that could only show a diff, and it is the wrong one
 * for someone who does not know git's words — telling them the answer is in the
 * terminal is telling them the answer is in the language they cannot read.
 *
 * So this exists, and what it will and will not do is the design:
 *
 * - **Pick, save, send.** The three steps, in that order, each behind its own
 *   gate. Nothing here picks and saves in one motion.
 * - **Nothing that destroys work.** No `reset --hard`, no discarding a file's
 *   edits, no force push, no branch deletion. Every one of those is a real thing
 *   people need — and the person who needs one is not the person this pane is
 *   for, and they have a terminal beside it. A pane whose worst outcome is "a
 *   save you did not mean to make" can be used without fear, and that is worth
 *   more than completeness.
 * - **Git's own error text, always.** Never swallowed, never paraphrased.
 *   `hintFor` adds a plain sentence *beside* it, which is a different thing from
 *   replacing it: the message git printed is the one that matches every answer
 *   found online, and hiding it would make the pane a dead end.
 *
 * Every operation shells out. Reading `.git` directly is right for the branch
 * name — one small file on a timer, which is why `gitBranch.ts` still does — and
 * wrong for all of this: status means diffing the index against the tree, and
 * reimplementing that is how a pane comes to disagree with the terminal beside
 * it about what is about to be saved.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type {
  Branch,
  ChangedFile,
  Commit,
  CommitRef,
  GitChange,
  GitProgress,
  GitResult,
  HistoryFilter,
  HostTool,
  RepoStatus,
} from '../shared/types'

/** Long enough for a slow disk or a big repository, short enough not to hang the UI. */
const LOCAL_TIMEOUT_MS = 20_000
/**
 * Anything that talks to GitHub gets its own, much longer, budget — and still a
 * finite one. A push over a bad connection that hangs forever leaves a button
 * spinning with no way back.
 */
const NETWORK_TIMEOUT_MS = 120_000

const MAX_OUTPUT = 8 * 1024 * 1024
/** Largest patch shown for one save. Past this nobody is reading it anyway. */
const MAX_DIFF_BYTES = 1024 * 1024

/** Field and record separators for `--format`, chosen because no keyboard makes them. */
const FIELD = '\x1f'
const RECORD = '\x1e'

interface GitRun {
  ok: boolean
  out: string
  err: string
}

/**
 * Runs git and reports what happened, without ever throwing.
 *
 * A rejected promise would make every caller here a try/catch, and there is
 * nothing exceptional about git saying no — "you have diverged" is an ordinary
 * outcome that the pane has a whole paragraph prepared for.
 */
function run(cwd: string, args: string[], opts: { timeout?: number; network?: boolean } = {}): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: opts.timeout ?? (opts.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS),
        windowsHide: true,
        maxBuffer: MAX_OUTPUT,
        env: {
          ...process.env,
          // Git must never stop and ask this process a question: there is no
          // terminal behind it, so a prompt for a username would hang until the
          // timeout and then report nothing useful. Off, it fails immediately
          // and says it needs credentials — which `hintFor` can explain.
          GIT_TERMINAL_PROMPT: '0',
          // Same reasoning for the pager and for the editor a merge would open.
          GIT_PAGER: 'cat',
          GIT_EDITOR: 'true',
          // English, so the phrases `hintFor` matches on are the phrases git
          // prints. A localised git would otherwise silently lose every hint.
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: stdout ?? '', err: (stderr ?? '').trim() || (error?.message ?? '') })
      }
    )
  })
}

/**
 * The same, with a patch fed to git on its standard input.
 *
 * Only `git apply` needs this, and it needs it rather than a temporary file for
 * a reason worth stating: a patch written to disk is a patch that outlives the
 * operation if the process dies mid-way, in a folder the user did not ask us to
 * write to. Down the pipe it exists for as long as the command does.
 */
function runInput(cwd: string, args: string[], input: string): Promise<GitRun> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: LOCAL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: MAX_OUTPUT,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'true', LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: stdout ?? '', err: (stderr ?? '').trim() || (error?.message ?? '') })
      }
    )
    // A patch git refuses can make it exit before the whole thing is written,
    // and the resulting EPIPE would otherwise take the process down rather than
    // become the error message it is.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

// ------------------------------------------------------------- progress

/**
 * Where progress events go, once the main process has somewhere to send them.
 *
 * A setter rather than an import, because this module is also loaded by the CLI
 * and by the tests, where there is no window to send anything to. Unset, every
 * report costs one null check and vanishes.
 */
let progressSink: ((event: GitProgress) => void) | null = null

export function onGitProgress(sink: ((event: GitProgress) => void) | null): void {
  progressSink = sink
}

function report(event: GitProgress): void {
  progressSink?.(event)
}

/**
 * Git's phases, in plain words.
 *
 * The same rule as everywhere else in these panes: git's own word stays, and a
 * sentence somebody can act on goes beside it. "Compressing objects" is a
 * perfectly good description of what is happening and tells a person nothing
 * about whether their work is safe; "packing it up to send" tells them where
 * they are in the journey.
 *
 * Ordered longest-prefix-first is unnecessary here — the names are distinct —
 * but they are matched by prefix rather than equality because git appends a
 * count to some of them and localised builds are prevented by `LC_ALL=C`.
 */
const PHASES: readonly { match: string; plain: string }[] = [
  { match: 'Enumerating objects', plain: 'Working out what to send' },
  { match: 'Counting objects', plain: 'Counting up what to send' },
  { match: 'Compressing objects', plain: 'Packing it up' },
  { match: 'Writing objects', plain: 'Uploading' },
  { match: 'Receiving objects', plain: 'Downloading' },
  { match: 'Resolving deltas', plain: 'Putting the pieces together' },
  { match: 'Unpacking objects', plain: 'Unpacking what came back' },
  { match: 'Updating files', plain: 'Updating your files' },
  { match: 'Checking out files', plain: 'Putting the files in place' },
  { match: 'Finding sources', plain: 'Finding what changed' },
  { match: 'remote: Enumerating objects', plain: 'The other end is working out what it has' },
  { match: 'remote: Counting objects', plain: 'The other end is counting' },
  { match: 'remote: Compressing objects', plain: 'The other end is packing it up' },
  { match: 'remote: Resolving deltas', plain: 'The other end is putting the pieces together' },
]

/**
 * Reads one line of git's progress output.
 *
 * The shape is fixed and has been for twenty years:
 *
 *   Writing objects:  62% (8/13)
 *   remote: Resolving deltas: 100% (4/4), done.
 *   Enumerating objects: 13, done.
 *
 * The percentage is missing on the phases that cannot know their total up
 * front, which is why it is optional here and why the bar has an indeterminate
 * state at all. Exported for the tests.
 */
export function parseProgress(line: string): { phase: string; plain: string; percent?: number; current?: number; total?: number; remote: boolean } | null {
  const text = line.trim()
  if (!text) return null

  const withCounts = /^(.*?):\s+(\d+)%\s+\((\d+)\/(\d+)\)/.exec(text)
  const bare = /^(.*?):\s+(\d+)(?:,|$)/.exec(text)
  const phase = (withCounts?.[1] ?? bare?.[1] ?? '').trim()
  if (!phase) return null

  const known = PHASES.find((p) => phase === p.match || phase.startsWith(p.match))
  // Anything git prints that is not one of its progress phases — "remote:" MOTD
  // banners, hints, warnings — is not progress and must not be shown as though
  // it were. Only the phases we recognise get through.
  if (!known) return null

  const remote = phase.startsWith('remote:')
  if (withCounts) {
    return {
      phase,
      plain: known.plain,
      percent: Number(withCounts[2]),
      current: Number(withCounts[3]),
      total: Number(withCounts[4]),
      remote,
    }
  }
  return { phase, plain: known.plain, current: Number(bare![2]), remote }
}

/**
 * Runs git and reports what it says as it says it.
 *
 * `spawn` rather than `execFile`, which is the whole point: `execFile` buffers
 * and hands everything over at the end, and the end is exactly when progress
 * has stopped being useful. The cost is that the timeout and the output cap
 * become ours to enforce rather than the library's, which is what the two
 * timers and the length check below are.
 *
 * `--progress` is passed by the callers because git only writes it when it
 * believes it is talking to a terminal, and it is not — there is a pipe here.
 * Without the flag a push over a slow link prints nothing at all until it ends.
 */
function runProgress(
  cwd: string,
  args: string[],
  opts: { op: string; network?: boolean; onLine?: (line: string) => void; command?: string }
): Promise<GitRun> {
  return new Promise((resolve) => {
    // `gh` shells out to git for the push it does, and git's progress comes
    // back up the same pipe — so the one runner covers both.
    const child = spawn(opts.command ?? 'git', args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
        LC_ALL: 'C',
      },
    })

    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      // Killed rather than left running: a push that hangs forever behind a
      // dead connection would otherwise hold the pane's lock for the life of
      // the app, with a bar that never moves.
      child.kill()
    }, opts.network ? NETWORK_TIMEOUT_MS : LOCAL_TIMEOUT_MS)

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      report({ cwd, op: opts.op, phase: '', plain: '', done: true })
      resolve({ ok, out, err: err.trim() })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < MAX_OUTPUT) out += chunk.toString()
      if (opts.onLine) for (const line of chunk.toString().split(/\r?\n/)) if (line) opts.onLine(line)
    })

    // Progress is written to stderr, and separated by carriage returns rather
    // than newlines — one line rewritten in place, as a terminal would show it.
    // Splitting on `\n` alone yields one enormous line per phase and no updates
    // until it ends, which is the bug that makes this look like it is not
    // working.
    child.stderr?.on('data', (chunk: Buffer) => {
      const value = chunk.toString()
      if (err.length < MAX_OUTPUT) err += value
      for (const line of value.split(/[\r\n]+/)) {
        const parsed = parseProgress(line)
        if (parsed) report({ cwd, op: opts.op, ...parsed })
      }
    })

    child.on('error', (error) => {
      err += `\n${error.message}`
      finish(false)
    })
    child.on('close', (code) => finish(code === 0))
  })
}

/** git's message, tidied of the prefixes that add nothing on screen. */
function message(res: GitRun): string {
  return (res.err || res.out || 'git failed').trim().replace(/^fatal:\s*/i, '')
}

/** Turns a run into the shape the renderer expects, hint and all. */
function asResult(res: GitRun): GitResult {
  if (res.ok) return { ok: true, output: res.out.trim() || res.err.trim() || undefined }
  const error = message(res)
  return { ok: false, error, hint: hintFor(`${error}\n${res.out}`), output: res.out.trim() || undefined }
}

/**
 * The plain-English sentence that goes beside a git error.
 *
 * This is the whole point of the feature, so it is worth being explicit about
 * what it is not: it is not a translation table for every message git has. It
 * is the handful you actually meet, each answered in the terms of what is
 * *true* — where your work is, what is at risk, and what to do next. The
 * ordering matters, since several of these can appear in one message and the
 * first match wins; the more specific are first.
 *
 * Every one of them says where the work is, because at the moment you read one
 * of these you will not believe your work is safe, and it almost always is.
 */
export function hintFor(text: string): string | undefined {
  const t = text.toLowerCase()

  if (/non-fast-forward|fetch first|updates were rejected|behind its remote counterpart/.test(t)) {
    return (
      'GitHub has saves (commits) you have not got, so sending yours would mean GitHub throwing its own away. ' +
      'Git refused — it is protecting you, and nothing is lost: your saves are still here on this machine. ' +
      'Bring GitHub\'s in first ("Bring in", which runs git pull --rebase: their saves first, yours back on the end), then send again.'
    )
  }
  if (/could not read username|authentication failed|terminal prompts disabled|permission denied \(publickey\)|invalid username or password/.test(t)) {
    return (
      'Git could not prove to GitHub who you are. Nothing was sent, and nothing here changed. ' +
      'Sign in once from the terminal beside this pane — `git push` there will ask properly — and this button works from then on.'
    )
  }
  if (/please tell me who you are|user\.email|unable to auto-detect email/.test(t)) {
    return (
      'Git does not know what name to put on the save yet. Run these once, in the terminal beside this pane:\n' +
      '  git config --global user.name "Your Name"\n' +
      '  git config --global user.email "you@example.com"'
    )
  }
  if (/nothing to commit|no changes added to commit|nothing added to commit/.test(t)) {
    return 'Nothing is picked, so there is nothing to put in a save. Tick the files you want first.'
  }
  if (/conflict|automatic merge failed|needs merge|unmerged/.test(t)) {
    return (
      'You and the other copy changed the same lines of the same file, so git stopped and is asking which wins. ' +
      'This is not damage and nothing is lost. Open the file, delete the <<<<<<< ======= >>>>>>> marker lines, ' +
      'keep the code you want, save it, then pick it here.'
    )
  }
  if (/would be overwritten by (checkout|merge)|local changes to the following files/.test(t)) {
    return (
      'You have changes that going there would write over, so git refused rather than binning them. ' +
      'Save them here first (pick, then save), and then go.'
    )
  }
  if (/no upstream branch|has no upstream|set-upstream/.test(t)) {
    return (
      'This line of saves (branch) has never been sent, so GitHub has no copy of it to add to. ' +
      'Sending will create one and pair the two up.'
    )
  }
  if (/could not resolve host|unable to access|failed to connect|network is unreachable|operation timed out/.test(t)) {
    return 'Could not reach GitHub. Nothing left this machine and nothing here changed — every save you have made is still here.'
  }
  if (/does not appear to be a git repository|no such remote|couldn't find remote ref/.test(t)) {
    return (
      'This project has no copy on GitHub yet, or the address it has does not work. ' +
      'Your saves are all still here; there is simply nowhere to send them to.'
    )
  }
  if (/refusing to merge unrelated histories/.test(t)) {
    return (
      'The copy online was started separately — it was made with a README or a licence file, so it has a save of its own ' +
      'and the two histories have nothing in common. Nothing is lost either way. ' +
      'Bring theirs in with `git pull --rebase --allow-unrelated-histories` in the terminal beside this pane, then send again.'
    )
  }
  if (/patch does not apply|corrupt patch|does not match index|while searching for/.test(t)) {
    return (
      'The file changed after this pane drew the lines you ticked, so the part it was going to pick is no longer where it was. ' +
      'Nothing was picked and nothing on disk was touched — the pane will redraw, and you can tick them again.'
    )
  }
  if (/remote origin already exists/.test(t)) {
    return (
      'This project already has an address for its copy online. Nothing was changed. ' +
      'To point it somewhere else, run `git remote set-url origin <address>` in the terminal beside this pane.'
    )
  }
  if (/name already exists on this account|repository .* already exists|already exists on remote/.test(t)) {
    return (
      'There is already a project of that name on your account, so nothing was made. ' +
      'Either pick another name, or — if that one *is* this project — paste its address instead of making a new one.'
    )
  }
  if (/gh: command not found|glab: command not found|is not recognized as an internal/.test(t)) {
    return 'That tool is not installed on this machine, so this pane cannot use it. The step-by-step way beside it needs nothing installed.'
  }
  if (/index\.lock|another git process/.test(t)) {
    return 'Another git command is running in this folder — often one in the terminal beside this pane. Let it finish and try again.'
  }
  if (/detached head|not currently on any branch/.test(t)) {
    return (
      'You are sitting on one save rather than on a line of saves (branch), so a new save here would belong to no line. ' +
      'Go to a branch first.'
    )
  }
  return undefined
}

// ---------------------------------------------------------------- shape cache

/**
 * Answers about a repository's *shape*, kept so the panes stop re-deriving them.
 *
 * Three of the five commands behind one `repoStatus` — the checkout root, the
 * git directory, and the origin URL — answer questions whose answers change
 * when someone runs `git init`, moves a folder, or sets a remote, and at no
 * other time. The panes ask every two to three seconds. Measured on Windows,
 * those three were 26 of 66 concurrent `git.exe` processes: the app was
 * spawning a process several times a second to re-derive a path that had not
 * moved. Every spawn is a process creation plus an antivirus scan.
 *
 * Staleness is handled per caller rather than by this deadline alone, because a
 * deadline is the wrong tool for anything the user can change under your hand:
 * `repoRoot` re-checks a remembered "not a repository" against the filesystem,
 * and `originUrl` puts the config file's mtime in its key. This value is the
 * floor under the ones that have no cheaper signal, and short enough that being
 * wrong costs a few seconds rather than a session.
 *
 * Anything that genuinely moves tick to tick — the status, the ahead/behind
 * counts, whether a rebase is in progress — is deliberately not cached here and
 * still costs exactly what it always did.
 */
const SHAPE_TTL_MS = 10_000

/** A long session visits many folders, so the cache is bounded rather than kept. */
const SHAPE_MAX = 256

const shapeCache = new Map<string, { value: unknown; at: number }>()

async function shaped<T>(key: string, compute: () => Promise<T>, ttlMs = SHAPE_TTL_MS): Promise<T> {
  const now = Date.now()
  const hit = shapeCache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value as T

  const value = await compute()
  if (shapeCache.size >= SHAPE_MAX) {
    for (const [k, v] of shapeCache) if (now - v.at >= SHAPE_TTL_MS) shapeCache.delete(k)
    // Still full means every entry is live; a clear costs one re-derivation
    // each rather than letting the map grow for the life of the process.
    if (shapeCache.size >= SHAPE_MAX) shapeCache.clear()
  }
  shapeCache.set(key, { value, at: now })
  return value
}

/** The root of the checkout this folder is in, or null when it is not in one. */
export async function repoRoot(cwd: string): Promise<string | null> {
  const key = `root:${cwd}`

  // A remembered "not a repository" is the one answer here that goes false
  // under the user's hand: `git init` in the terminal beside the pane makes it
  // wrong immediately, and a pane still saying "not a project git is watching"
  // afterwards reads as the app being broken. One `existsSync` per call is a
  // rounding error against the spawn it is protecting, so it is paid always.
  const hit = shapeCache.get(key)
  if (hit && hit.value === null && existsSync(path.join(cwd, '.git'))) shapeCache.delete(key)

  return shaped(key, async () => {
    const res = await run(cwd, ['rev-parse', '--show-toplevel'])
    if (!res.ok) return null
    const root = res.out.trim()
    return root ? path.normalize(root) : null
  })
}

// ---------------------------------------------------------------- status

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 * Version 2 rather than the original porcelain, and `-z` rather than plain
 * lines, and both are about not lying. Version 1 flattens "picked" and "changed
 * since you picked" into two characters whose meaning depends on each other;
 * version 2 states them plainly and carries the branch and ahead/behind counts
 * in the same call, so the pane's headline and its file list can never be from
 * two different moments. `-z` stops git quoting paths with unusual characters,
 * which is the difference between showing a file name and showing `"caf\303\251.txt"`.
 *
 * Exported for the tests, which run it against output from a real repository.
 */
export function parseStatus(
  raw: string,
  root: string
): Omit<RepoStatus, 'root' | 'hasRemote' | 'remoteUrl' | 'inProgress' | 'unsent'> {
  const out = {
    branch: undefined as string | undefined,
    detached: false,
    head: undefined as string | undefined,
    headFull: undefined as string | undefined,
    upstream: undefined as string | undefined,
    ahead: 0,
    behind: 0,
    files: [] as ChangedFile[],
  }

  // Trailing NUL means the last split is always empty; entries are otherwise
  // exactly the records git wrote, spaces and all.
  const records = raw.split('\0')
  const add = (repoPath: string, fields: { picked?: GitChange; changed?: GitChange; untracked?: boolean; conflicted?: boolean; from?: string }) => {
    out.files.push({
      path: path.resolve(root, repoPath),
      repoPath,
      picked: fields.picked ?? '',
      changed: fields.changed ?? '',
      untracked: fields.untracked ?? false,
      conflicted: fields.conflicted ?? false,
      from: fields.from,
    })
  }

  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') {
        // "(initial)" is git's way of saying this repository has no saves at
        // all yet, which is a state the publish flow has to be able to tell
        // apart from "a save exists and I cannot read it".
        out.head = value === '(initial)' ? undefined : value.slice(0, 7)
        out.headFull = value === '(initial)' ? undefined : value
      }
      else if (key === 'branch.head') {
        if (value === '(detached)') out.detached = true
        else out.branch = value
      } else if (key === 'branch.upstream') out.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          out.ahead = Number(m[1])
          out.behind = Number(m[2])
        }
      }
      continue
    }

    const kind = record[0]
    if (kind === '?') {
      add(record.slice(2), { untracked: true, changed: '?' })
      continue
    }
    // `!` is an ignored file. We never ask for those, but a future flag might,
    // and listing one as a change would be wrong.
    if (kind === '!') continue

    const parts = record.split(' ')
    const xy = parts[1] ?? '..'
    const picked = (xy[0] === '.' ? '' : xy[0]) as GitChange
    const changed = (xy[1] === '.' ? '' : xy[1]) as GitChange

    if (kind === '1') {
      add(parts.slice(8).join(' '), { picked, changed })
    } else if (kind === '2') {
      // A rename or copy. The path git wrote is where the file is *now*; the
      // one it came from is the next record along, which is why this loop has
      // to be able to consume two.
      const to = parts.slice(9).join(' ')
      const from = records[++i] ?? ''
      add(to, { picked, changed, from })
    } else if (kind === 'u') {
      add(parts.slice(10).join(' '), { picked, changed, conflicted: true })
    }
  }

  return out
}

/**
 * Which multi-step operation, if any, stopped part-way and is waiting.
 *
 * Read from the files git leaves in its own directory rather than by asking
 * git, because there is no command that answers it directly and every pane that
 * needs the answer needs it on the same timer as the status.
 */
async function inProgress(cwd: string): Promise<RepoStatus['inProgress']> {
  // Where the git directory *is* keeps; what is sitting in it does not. The
  // path is cached and the `existsSync` checks below stay live, so a rebase
  // started in the terminal beside the pane still shows up on the next tick.
  const gitDir = await shaped(`gitdir:${cwd}`, async () => {
    const res = await run(cwd, ['rev-parse', '--absolute-git-dir'])
    return res.ok ? res.out.trim() : ''
  })
  if (!gitDir) return undefined
  const has = (name: string) => existsSync(path.join(gitDir, name))
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  if (has('BISECT_LOG')) return 'bisect'
  return undefined
}

/**
 * Where `origin` points, or empty when there is no such remote.
 *
 * Cached against the *modification time of the file git keeps remotes in*
 * rather than against a clock. `git remote add` in the terminal beside the pane
 * rewrites that file, so the very next tick misses the cache and re-reads —
 * which a plain time-to-live would not do, and the difference is a pane that
 * says "not sent anywhere" for ten seconds after you have just added a remote.
 * A `stat` costs nothing next to the process spawn it saves, and unlike a
 * deadline it cannot be stale.
 *
 * A linked worktree keeps `.git` as a file pointing elsewhere, so there is no
 * config to stat beside it; that case pays the spawn rather than guessing.
 */
export async function originUrl(root: string): Promise<string> {
  const read = async () => {
    const res = await run(root, ['remote', 'get-url', 'origin'])
    return res.ok ? res.out.trim() : ''
  }

  let stamp: string
  try {
    const dot = path.join(root, '.git')
    if (!statSync(dot).isDirectory()) return read()
    stamp = String(statSync(path.join(dot, 'config')).mtimeMs)
  } catch {
    return read()
  }

  // The key carries the freshness, so the deadline is only here to stop an
  // untouched repository's entry living for the whole life of the process.
  return shaped(`origin:${root}:${stamp}`, read, 10 * 60_000)
}

/**
 * Where this repository stands, in one call.
 *
 * One call because the alternative is a headline and a file list read a moment
 * apart, which on a repository an agent is actively writing to is a pane that
 * says "2 changed files" above three of them.
 */
export async function repoStatus(cwd: string): Promise<RepoStatus> {
  const root = await repoRoot(cwd)
  if (!root) {
    return { root: '', detached: false, ahead: 0, behind: 0, hasRemote: false, files: [], unsent: [] }
  }
  return statusOf(root)
}

/**
 * The same answer for a root that has already been resolved.
 *
 * Split out because `send` wants the status of a root it is holding, and going
 * back through `repoStatus` would re-resolve the root it just used.
 */
async function statusOf(root: string): Promise<RepoStatus> {

  const [status, remoteUrl, stopped] = await Promise.all([
    run(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal', '-z']),
    originUrl(root),
    inProgress(root),
  ])

  const parsed = parseStatus(status.ok ? status.out : '', root)

  // Every save on any line here that is on no line GitHub has.
  //
  // Deliberately not "ahead of my upstream", which is the count in the
  // headline and a different question: a save on a branch you are not
  // currently standing on is just as absent from GitHub, and counting only
  // the current one marks some rows and not others for no reason the picture
  // can show.
  //
  // Only asked when there is a copy on GitHub to be absent from. Without one
  // the answer is "all of them", and a badge on every row says less than the
  // single sentence the pane already puts at the top.
  let unsent: string[] = []
  if (remoteUrl) {
    const res = await run(root, ['rev-list', '--max-count=500', '--all', '--not', '--remotes'])
    if (res.ok) unsent = res.out.split('\n').map((l) => l.trim()).filter(Boolean)
  }

  return {
    root,
    ...parsed,
    unsent,
    lastSave: await lastSave(root, parsed.headFull),
    hasRemote: remoteUrl.length > 0,
    remoteUrl: remoteUrl || undefined,
    inProgress: stopped,
  }
}

/**
 * The message on the save you are standing on.
 *
 * Wanted for one sentence — "Add to 'fixed the parser'" — and paid for once per
 * save rather than once per tick, because the sha is *in the cache key*. A new
 * save changes the key and costs one spawn; three seconds later the same save
 * costs nothing. That is the same trick `originUrl` plays with the config
 * file's timestamp, and it is why this can sit in the poll at all.
 */
async function lastSave(root: string, sha: string | undefined): Promise<RepoStatus['lastSave']> {
  if (!sha) return undefined
  return shaped(
    `lastsave:${root}:${sha}`,
    async () => {
      const res = await run(root, ['log', '-1', '--format=%s', sha])
      return res.ok ? { sha, subject: res.out.trim() } : undefined
    },
    60 * 60_000
  )
}

// --------------------------------------------------------------- history

const LOG_FORMAT = [
  '%H', // full number (hash)
  '%h', // short number
  '%P', // the saves before this one
  '%an',
  '%ae',
  '%at',
  '%D', // the branch names, tags and HEAD pointing here
  '%s',
  '%b',
].join(FIELD) + RECORD

/**
 * Parses the log format above into saves.
 *
 * Split on our own separators rather than on newlines, because a save's message
 * is arbitrary text that routinely contains blank lines and, on this project,
 * whole paragraphs. Exported for the tests.
 */
export function parseLog(raw: string, remotes: readonly string[] = ['origin']): Commit[] {
  const commits: Commit[] = []
  for (const record of raw.split(RECORD)) {
    const text = record.replace(/^\r?\n/, '')
    if (!text.trim()) continue
    const fields = text.split(FIELD)
    if (fields.length < 8) continue
    const [sha, short, parents, author, email, at, refs, subject, ...rest] = fields
    commits.push({
      sha,
      short,
      parents: parents.trim() ? parents.trim().split(' ') : [],
      author,
      email,
      at: Number(at) * 1000,
      refs: parseRefs(refs, remotes),
      subject,
      // Anything after the subject is the body, and joining rather than taking
      // [8] is what stops a message containing our separator losing its tail.
      body: rest.join(FIELD).trim(),
    })
  }
  return commits
}

/** `HEAD -> main, origin/main, tag: v1.00` into something drawable. */
export function parseRefs(raw: string, remotes: readonly string[] = ['origin']): CommitRef[] {
  const out: CommitRef[] = []
  for (const piece of raw.split(',')) {
    const name = piece.trim()
    if (!name) continue
    if (name.startsWith('tag: ')) {
      out.push({ name: name.slice(5), kind: 'tag' })
    } else if (name.startsWith('HEAD -> ')) {
      // "You are here, and here is on this line of saves" — one badge, not two.
      out.push({ name: name.slice(8), kind: 'head' })
    } else if (name === 'HEAD') {
      out.push({ name: 'HEAD', kind: 'head' })
    } else if (remotes.some((r) => name.startsWith(`${r}/`))) {
      // `origin/HEAD` is not a line of saves, it is a note about which one
      // GitHub calls its default — and it sits on the same save as the branch
      // it names, so showing it puts two badges on one row saying one thing.
      if (name.endsWith('/HEAD')) continue
      out.push({ name, kind: 'remote' })
    } else {
      out.push({ name, kind: 'branch' })
    }
  }
  return out
}

async function remoteNames(cwd: string): Promise<string[]> {
  const res = await run(cwd, ['remote'])
  if (!res.ok) return ['origin']
  const names = res.out.split('\n').map((l) => l.trim()).filter(Boolean)
  return names.length ? names : ['origin']
}

/**
 * The saves, newest first, across every line of saves.
 *
 * `--all` deliberately: the pane's job is to draw the picture, and a picture of
 * one branch is a straight line that explains nothing. `--date-order` keeps it
 * roughly chronological without ever putting a save above one it came from,
 * which is the ordering `layoutGraph` is written against.
 */
export async function history(cwd: string, limit = 400, filter?: HistoryFilter): Promise<Commit[]> {
  const root = (await repoRoot(cwd)) ?? cwd
  const remotes = await remoteNames(root)
  const args = ['log', '--date-order', `--max-count=${Math.max(1, Math.min(2000, limit))}`, `--format=${LOG_FORMAT}`, '--all']

  // Every one of these is passed as its own argument and never interpolated
  // into a string: what the user typed goes to git as a value, so a message
  // search for `--author=me` searches for that text rather than becoming a
  // flag. `execFile` takes an array for exactly this reason.
  if (filter?.text) args.push('--regexp-ignore-case', `--grep=${filter.text}`)
  if (filter?.author) args.push('--regexp-ignore-case', `--author=${filter.author}`)
  // `-S` is git's "when did this text stop or start appearing" search, which is
  // a different and often better question than "who mentioned it in a message".
  if (filter?.content) args.push(`-S${filter.content}`)
  // A path is a pathspec and has to come after the separator, or a file whose
  // name happens to match a branch is read as a revision.
  const tail = filter?.path ? ['--', filter.path] : []

  let res = await run(root, [...args, 'HEAD', ...tail])
  // A repository whose first save has not been made yet has no HEAD to name,
  // and git treats that as a bad argument rather than as an empty answer.
  // Dropping the name by position was fine while it was last; a path filter
  // puts two more arguments after it, so the two forms are built rather than
  // sliced.
  if (!res.ok) res = await run(root, [...args, ...tail])
  if (!res.ok) return []
  return parseLog(res.out, remotes)
}

const BRANCH_FORMAT = [
  '%(refname)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(objectname:short)',
  '%(committerdate:unix)',
  '%(worktreepath)',
  '%(subject)',
].join(FIELD)

/** Every line of saves, here and on the copy elsewhere. */
export async function branches(cwd: string): Promise<Branch[]> {
  const root = (await repoRoot(cwd)) ?? cwd
  const res = await run(root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes'])
  if (!res.ok) return []
  return parseBranches(res.out)
}

/** Exported for the tests. */
export function parseBranches(raw: string): Branch[] {
  const out: Branch[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [full, name, upstream, track, head, sha, at, worktree, subject] = line.split(FIELD)
    // `origin/HEAD` is a pointer at whichever branch GitHub calls its default,
    // not a line of saves anybody works on. Listing it means an entry that
    // duplicates another one and cannot be switched to.
    //
    // Matched on the *full* name: git shortens `refs/remotes/origin/HEAD` to
    // plain `origin`, so checking the short name misses it entirely and the
    // list gains a chip called "origin" that goes nowhere.
    if (full?.endsWith('/HEAD')) continue
    const ahead = /ahead (\d+)/.exec(track ?? '')
    const behind = /behind (\d+)/.exec(track ?? '')
    out.push({
      name,
      current: head === '*',
      remote: full?.startsWith('refs/remotes/') ?? false,
      upstream: upstream || undefined,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      head: sha || undefined,
      at: at ? Number(at) * 1000 : undefined,
      subject: subject || undefined,
      checkedOutAt: worktree || undefined,
    })
  }
  return out
}

// ------------------------------------------------------------------ diffs

function capped(text: string): string {
  return text.length > MAX_DIFF_BYTES
    ? `${text.slice(0, MAX_DIFF_BYTES)}\n\n… the rest is not shown: this is more than ${MAX_DIFF_BYTES / 1024} KB of changed lines.`
    : text
}

/**
 * The changed lines of one file, from whichever of the three places it is in.
 *
 * Three cases and not one, because "what changed" has three different answers
 * depending on what you are looking at, and showing the wrong one is how a pane
 * comes to display changes that are not going into the save it is offering to
 * make.
 */
export async function fileDiff(
  cwd: string,
  repoPath: string,
  opts: { picked?: boolean; untracked?: boolean } = {}
): Promise<string> {
  const root = (await repoRoot(cwd)) ?? cwd
  const args = opts.untracked
    ? ['diff', '--no-index', '--no-color', '--', '/dev/null', repoPath]
    : opts.picked
      ? ['diff', '--cached', '--no-color', '--', repoPath]
      : ['diff', '--no-color', '--', repoPath]
  const res = await run(root, args)
  // `--no-index` exits non-zero when the files differ, which is the ordinary
  // case here — so what git printed is trusted over what it returned.
  return capped(res.out || (res.ok ? '' : ''))
}

/** Everything picked, as one patch — what the next save will actually contain. */
export async function pickedDiff(cwd: string): Promise<string> {
  const root = (await repoRoot(cwd)) ?? cwd
  const res = await run(root, ['diff', '--cached', '--no-color'])
  return capped(res.out)
}

/** One save's changed lines, with the files it touched. */
export async function commitDiff(cwd: string, sha: string, repoPath?: string): Promise<string> {
  const root = (await repoRoot(cwd)) ?? cwd
  const args = ['show', '--no-color', '--format=', '--patch', sha]
  if (repoPath) args.push('--', repoPath)
  const res = await run(root, args)
  return capped(res.out)
}

/** The files one save touched, as `status<tab>path` lines. */
export async function commitFiles(cwd: string, sha: string): Promise<ChangedFile[]> {
  const root = (await repoRoot(cwd)) ?? cwd
  const res = await run(root, ['show', '--name-status', '--format=', '-z', sha])
  if (!res.ok) return []
  const out: ChangedFile[] = []
  const parts = res.out.split('\0').filter((p) => p !== '')
  for (let i = 0; i < parts.length; i++) {
    const letter = parts[i]
    if (!/^[A-Z]/.test(letter)) continue
    // A rename writes its score after the letter and then two paths.
    const rename = letter.startsWith('R') || letter.startsWith('C')
    const from = rename ? parts[++i] : undefined
    const file = parts[++i]
    if (!file) break
    out.push({
      path: path.resolve(root, file),
      repoPath: file,
      picked: letter[0] as GitChange,
      changed: '',
      untracked: false,
      conflicted: false,
      from,
    })
  }
  return out
}

// ------------------------------------------------------------- operations

/**
 * Picks files for the next save. No paths means everything that has changed.
 *
 * `--verbose` so that picking everything in a repository an agent has just
 * rewritten says which file it is on rather than sitting still: git prints
 * `add 'path'` per file, which is the only per-file progress any of these
 * operations can offer.
 */
export async function pick(cwd: string, paths: string[]): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const args = paths.length ? ['add', '--verbose', '--', ...paths] : ['add', '--verbose', '--all']
  let count = 0
  return asResult(
    await runProgress(root, args, {
      op: 'pick',
      onLine: (line) => {
        const m = /^add '(.*)'$/.exec(line.trim())
        if (!m) return
        count++
        // Tagged with the repository root, like every other report: the pane
        // knows both that and its own folder, and matching on either is what
        // lets a pane opened in a subfolder still see its own operations.
        report({ cwd: root, op: 'pick', phase: 'add', plain: 'Picking', file: m[1], current: count })
      },
    })
  )
}

/**
 * Takes files back out of picked.
 *
 * `git reset` rather than `git restore --staged`, which reads better but does
 * not exist for a repository whose first save has not been made yet — and the
 * first thing anyone does in a new project is pick everything and then change
 * their mind. Neither form touches a file on disk.
 */
export async function unpick(cwd: string, paths: string[]): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const args = paths.length ? ['reset', '--quiet', '--', ...paths] : ['reset', '--quiet']
  return asResult(await run(root, args))
}

/** Saves the picked files, on this machine only. */
export async function save(cwd: string, message: string): Promise<GitResult> {
  const text = message.trim()
  if (!text) return { ok: false, error: 'a message is required', hint: 'A save needs a line saying what it is, so the list of saves is readable later.' }
  const root = (await repoRoot(cwd)) ?? cwd
  return asResult(await run(root, ['commit', '-m', text]))
}

/**
 * Sends this line of saves to GitHub.
 *
 * A branch that has never been sent has nothing on GitHub to add to, and plain
 * `git push` refuses with an instruction to re-run it with `--set-upstream`.
 * Doing that automatically is safe — it creates a branch on GitHub of the same
 * name and pairs the two up — and refusing in order to make the user paste a
 * flag would be theatre.
 */
export async function send(cwd: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const status = await repoStatus(root)
  if (status.detached || !status.branch) {
    return {
      ok: false,
      error: 'not on a branch',
      hint: 'You are sitting on one save rather than on a line of saves (branch), and there is no line to send. Go to a branch first.',
    }
  }
  const args = status.upstream
    ? ['push', '--progress']
    : ['push', '--progress', '--set-upstream', 'origin', status.branch]
  return asResult(await runProgress(root, args, { op: 'send', network: true }))
}

/**
 * Looks at what is new on the copy online without touching a single file here.
 *
 * `--progress` in place of the `--quiet` this used to pass, which were pulling
 * in opposite directions: quiet suppressed the very lines the bar is drawn
 * from. Nothing is printed to a user either way — the output goes to the pane.
 */
export async function peek(cwd: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  return asResult(await runProgress(root, ['fetch', '--progress'], { op: 'peek', network: true }))
}

/**
 * Brings GitHub's saves in, putting yours back on the end.
 *
 * `--rebase` rather than a plain pull, and it is the same choice `git_ia`
 * recommends when a push is refused: it puts their saves in first and yours
 * back on the end, so the line stays straight instead of gaining a join-up save
 * (merge commit) nobody asked for. It can still stop on a conflict, which is
 * git asking a question rather than anything going wrong.
 */
export async function bringIn(cwd: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  return asResult(await runProgress(root, ['pull', '--rebase', '--progress'], { op: 'bring-in', network: true }))
}

/**
 * Goes to another line of saves.
 *
 * `switch` rather than `checkout`, for two reasons that both matter here: it
 * refuses to do anything except change branch, so a mistyped name cannot
 * silently throw away a file's edits the way `checkout -- <file>` would; and
 * given a name that only exists on GitHub it creates the local line and pairs
 * them up, which is what someone clicking `origin/thing` in a list means.
 */
export async function goTo(cwd: string, name: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const remotes = await remoteNames(root)
  const prefix = remotes.find((r) => name.startsWith(`${r}/`))
  const local = prefix ? name.slice(prefix.length + 1) : name
  return asResult(await run(root, ['switch', local]))
}

/** Starts a new line of saves here, and goes to it. */
export async function startBranch(cwd: string, name: string): Promise<GitResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'a name is required' }
  const root = (await repoRoot(cwd)) ?? cwd
  return asResult(await run(root, ['switch', '--create', clean]))
}

// -------------------------------------------------------- part of a file

/**
 * Picks or unpicks exactly the lines in a patch the renderer built.
 *
 * The patch arrives already cut down — see `src/shared/diffPatch.ts` for the
 * arithmetic — and all that is left here is to hand it to git the right way
 * round. Neither direction writes to a file on disk: `--cached` means the patch
 * lands in what is picked and nowhere else, so the worst case is git refusing
 * it, which is a message rather than a loss.
 *
 * `--unidiff-zero` is deliberately *not* passed. It tells git to skip the
 * context check, and the context check is the thing standing between a
 * mis-built patch and lines being picked from the wrong part of the file.
 */
export async function applyLines(cwd: string, patch: string, direction: 'pick' | 'unpick'): Promise<GitResult> {
  if (!patch.trim()) return { ok: false, error: 'nothing selected', hint: 'Tick at least one changed line first.' }
  const root = (await repoRoot(cwd)) ?? cwd
  const args = ['apply', '--cached', '--whitespace=nowarn']
  if (direction === 'unpick') args.push('--reverse')
  return asResult(await runInput(root, args, patch))
}

// ------------------------------------------------------------- undoing

/**
 * Undoes the last save, leaving every file exactly as it is.
 *
 * `--soft`, and only `--soft`. The distinction is the single most valuable
 * thing this pane can teach: `git reset --soft HEAD~1` puts the save's contents
 * back into "picked" and touches nothing on disk, while the `--hard` sitting
 * one word away in every search result deletes the work outright. This offers
 * the reversible one and does not offer the other.
 *
 * Refused once the save is on the copy online, because undoing a save that
 * someone else may already have is the beginning of a rewrite, and a rewrite is
 * exactly the class of operation this pane leaves to the terminal.
 */
export async function undoLastSave(cwd: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const status = await statusOf(root)
  if (!status.lastSave) {
    return { ok: false, error: 'no saves yet', hint: 'There is no save to undo — this project has not had one made yet.' }
  }
  if (status.hasRemote && !status.unsent.includes(status.lastSave.sha)) {
    return {
      ok: false,
      error: 'the last save has already been sent',
      hint:
        'That save is already on the copy online, so undoing it here would leave the two disagreeing about what happened. ' +
        'Make a new save that puts it right instead — or, if you are certain nobody else has it, do it in the terminal beside this pane.',
    }
  }
  // A first save has no save before it to fall back to, and `HEAD~1` is an
  // error rather than an empty answer. Emptying the branch is the honest
  // equivalent and keeps every file.
  const first = await run(root, ['rev-parse', '--verify', '--quiet', 'HEAD~1'])
  const args = first.ok ? ['reset', '--soft', 'HEAD~1'] : ['update-ref', '-d', 'HEAD']
  return asResult(await run(root, args))
}

/**
 * Puts what is picked into the save that already exists, instead of a new one.
 *
 * The same gate as undoing, and for the same reason — this replaces a save with
 * a different one carrying the same intent, which is fine while it is yours
 * alone and a rewrite once it is not.
 */
export async function amend(cwd: string, message: string): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const status = await statusOf(root)
  if (!status.lastSave) {
    return { ok: false, error: 'no saves yet', hint: 'There is no save to add to yet. Make the first one.' }
  }
  if (status.hasRemote && !status.unsent.includes(status.lastSave.sha)) {
    return {
      ok: false,
      error: 'the last save has already been sent',
      hint:
        'That save is already on the copy online. Changing it here would make the two disagree about what happened, so this makes a new save instead.',
    }
  }
  const text = message.trim()
  const args = text ? ['commit', '--amend', '-m', text] : ['commit', '--amend', '--no-edit']
  return asResult(await run(root, args))
}

/**
 * Undoes one save by making a new one that puts it back.
 *
 * The safe undo, and the one that works on a save everybody already has: git
 * writes a fresh save whose content is the old one turned around, so nothing is
 * rewritten and the record of both stays. `--no-edit` because the pane cannot
 * open an editor, and git's default message already names what was reverted.
 */
export async function revertSave(cwd: string, sha: string): Promise<GitResult> {
  if (!sha.trim()) return { ok: false, error: 'no save given' }
  const root = (await repoRoot(cwd)) ?? cwd
  // A merge has two sides, and reverting one needs to be told which to keep.
  // `-m 1` means "keep the line you were on", the only answer a button can
  // give honestly — and git refuses outright without it.
  const parents = await run(root, ['rev-list', '--parents', '-n', '1', sha])
  const isMerge = parents.ok && parents.out.trim().split(/\s+/).length > 2
  const args = ['revert', '--no-edit']
  if (isMerge) args.push('-m', '1')
  args.push(sha)
  return asResult(await run(root, args))
}

/** Puts a name on one save, so it can be found by it later. */
export async function addTag(cwd: string, sha: string, name: string): Promise<GitResult> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'a name is required' }
  const root = (await repoRoot(cwd)) ?? cwd
  // Not `--force`: a name that already points at another save is a question,
  // and moving it silently is how a release tag comes to mean something else.
  return asResult(await run(root, ['tag', clean, sha || 'HEAD']))
}

// ------------------------------------------------------------ publishing

/**
 * Starts tracking this folder, if it is not tracked already.
 *
 * `-b main` because the default git ships with is still `master` on any
 * installation older than 2.28 or without `init.defaultBranch` set, and every
 * host this app knows about now calls its default `main`. Getting them to agree
 * from the start saves the "your push created a second branch" confusion that
 * has no good explanation. Older gits reject the flag, and then the plain form
 * is used and the branch is called whatever that git calls it.
 */
export async function initRepo(cwd: string): Promise<GitResult> {
  const already = await repoRoot(cwd)
  if (already) {
    return { ok: false, error: 'already tracked', hint: `This folder is already part of a project git is watching (${already}).` }
  }
  let res = await run(cwd, ['init', '-b', 'main'])
  if (!res.ok) res = await run(cwd, ['init'])
  // The remembered "not a repository" for this folder is now wrong, and the
  // pane asks again within the second.
  shapeCache.delete(`root:${cwd}`)
  return asResult(res)
}

/**
 * Points this project at its copy online.
 *
 * Refuses to move an address that is already set. Repointing a project at a
 * different host is a real thing people do and a rare one, and doing it by
 * accident — because a publish flow was run twice — sends the next push
 * somewhere the user has forgotten about.
 */
export async function setOrigin(cwd: string, url: string): Promise<GitResult> {
  const clean = url.trim()
  if (!clean) return { ok: false, error: 'an address is required' }
  const root = (await repoRoot(cwd)) ?? cwd
  const existing = await run(root, ['remote', 'get-url', 'origin'])
  if (existing.ok && existing.out.trim()) {
    return {
      ok: false,
      error: 'remote origin already exists',
      hint: `This project already points at ${existing.out.trim()}. Nothing was changed.`,
    }
  }
  const res = await run(root, ['remote', 'add', 'origin', clean])
  // The origin cache is keyed on the config file's timestamp, which has just
  // changed — so this is belt and braces rather than necessary, and cheap.
  shapeCache.clear()
  return asResult(res)
}

/**
 * Runs a program that is not git, to find out whether it is there.
 *
 * Separate from `run` because everything in that function is about git — its
 * environment variables, its pager, its prompt suppression — and because a tool
 * that is missing is the ordinary answer here rather than a failure.
 */
function runTool(command: string, args: string[], cwd: string, timeout = 15_000): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout, windowsHide: true, maxBuffer: MAX_OUTPUT, env: { ...process.env, NO_COLOR: '1' }, shell: false },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: stdout ?? '', err: (stderr ?? '').trim() || (error?.message ?? '') })
      }
    )
  })
}

/**
 * Which host command-line tools are installed here, and signed in.
 *
 * Asked because one of them collapses the whole publish flow into a button:
 * `gh` and `glab` already hold the user's credentials, so with either present
 * the app never has to see a token, store one, or send the user to a browser.
 * Without one the guided route works and needs nothing installed — so this is
 * a shortcut being offered, never a requirement.
 *
 * `auth status` rather than `--version`, because installed and signed in are
 * different states and only the second one can make a project.
 */
export async function hostTools(cwd: string): Promise<HostTool[]> {
  const candidates: { command: string; host: 'github' | 'gitlab'; label: string }[] = [
    { command: 'gh', host: 'github', label: 'GitHub CLI' },
    { command: 'glab', host: 'gitlab', label: 'GitLab CLI' },
  ]
  return Promise.all(
    candidates.map(async ({ command, host, label }) => {
      const res = await runTool(command, ['auth', 'status'], cwd)
      // A missing program and a program that ran and said "not logged in" both
      // come back as a non-zero exit, and they need different sentences on
      // screen — so they are told apart by the shape of the failure.
      const missing = /ENOENT|not found|not recognized|cannot find/i.test(res.err)
      return {
        command,
        host,
        label,
        installed: !missing,
        signedIn: res.ok,
        note: missing ? undefined : res.ok ? undefined : firstLine(res.err || res.out),
      }
    })
  )
}

function firstLine(text: string): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean)
  return line || undefined
}

/**
 * Makes the project online and sends everything to it, in one go.
 *
 * Only reachable when the matching tool reported itself signed in. The whole
 * dance this replaces — make an empty project on a web page, copy the address,
 * add it as a remote, push and set the pairing — is four steps with two places
 * to get it wrong, and the tool does all four with the credentials it already
 * has.
 *
 * `--source=.` matters: it tells `gh` this folder is the project, so it adds the
 * remote here rather than making an empty one somewhere else and leaving the
 * user to wire it up.
 */
export async function createOnline(
  cwd: string,
  opts: { command: string; name: string; private: boolean; description?: string }
): Promise<GitResult> {
  const root = (await repoRoot(cwd)) ?? cwd
  const name = opts.name.trim()
  if (!name) return { ok: false, error: 'a name is required' }
  const visibility = opts.private ? '--private' : '--public'

  if (opts.command === 'gh') {
    const args = ['repo', 'create', name, '--source=.', '--remote=origin', '--push', visibility]
    if (opts.description) args.push('--description', opts.description)
    report({ cwd: root, op: 'publish', phase: 'create', plain: `Making ${name} on GitHub` })
    const res = await runProgress(root, args, { op: 'publish', network: true, command: 'gh' })
    shapeCache.clear()
    return asResult(res)
  }

  if (opts.command === 'glab') {
    // `glab` makes the project and adds the remote, but does not push — so the
    // push is ours, and it is the ordinary one every other button here runs.
    const args = ['repo', 'create', name, visibility, '--remoteName', 'origin']
    if (opts.description) args.push('--description', opts.description)
    const made = await runTool('glab', args, root, NETWORK_TIMEOUT_MS)
    shapeCache.clear()
    if (!made.ok) return asResult(made)
    return send(root)
  }

  return { ok: false, error: `unknown tool: ${opts.command}` }
}
