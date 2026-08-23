/**
 * What each of your machines is part-way through, written where the others can
 * read it.
 *
 * The problem is not technical. Working on one project from a laptop, a desktop
 * and a MacBook through the same day, the question that will not go away is
 * "did I leave something uncommitted on the other one?" — and it cannot be
 * answered from here, because a repository knows what *this* machine has done
 * to it and nothing whatsoever about what a machine three rooms away has.
 *
 * So each machine writes down its own answer, in the folder they all already
 * share, and every machine reads all of them.
 *
 * **This reports and does nothing else.** No patch is written, no work is
 * carried anywhere, and nothing here commits, pushes or pulls on any machine's
 * behalf — not this one, and certainly not another one. Relay's entire job is
 * to make the state of every machine visible in one place; deciding what to do
 * about it is a person's job, in the git pane, on the machine it affects. The
 * temptation to add "…and bring it over for you" is exactly the feature this is
 * not, because the moment it moves work it owns a conflict it cannot resolve.
 *
 * **A description, never the thing described.** Branch names, counts, and the
 * paths of files git already tracks. No file contents. No names of untracked
 * files — a tracked path is already written into the repository's history,
 * whereas an untracked one can be a scratch dump, a `.env`, or a key somebody
 * pasted, and a synced folder is not the place to find that out. Those are
 * counted and left nameless.
 *
 * **Everything read here is in the past tense.** A record is what a machine
 * could see when it wrote, arriving through a sync client that may have taken
 * minutes. There is no live connection between machines and there is no
 * pretending otherwise: every record carries `at`, and nothing that renders one
 * is allowed to drop it.
 *
 * Machine identity and the project key come from `shareIdentity.ts`, shared with
 * `tokenShare.ts` so both features agree about who wrote a file and which
 * project it belongs to.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { repoStatus, unsentSubjects } from './git'
import { redact, seal, unseal } from './shareCrypto'
import { machine, projectKey } from './shareIdentity'
import type { Relay, RelayPresence, RelayPublishEntry, RepoStatus } from '../shared/types'

/** The folder this app makes inside whatever shared folder it is given. */
const SHARE_FOLDER = 'ia_workspaces-relay'

/**
 * How many changed files one machine names.
 *
 * Enough for the overlap warning to be right about the files anyone is actually
 * editing, and short of the mid-refactor case where a machine has touched two
 * hundred and the list stops being information. Past the cap the count still
 * tells the truth — `changed.length` is not what the headline counts.
 */
const MAX_CHANGED = 60

/** How many unsent saves get their message published. Beyond this, the count says it. */
const MAX_SUBJECTS = 5

/**
 * How long a change waits before it is published.
 *
 * There is deliberately no heartbeat. A project nobody has touched since
 * Tuesday writes nothing at all — not a file a week, not a file an hour — and a
 * machine left running on an untouched repository is silent on the shared
 * folder. The alternative was a periodic write so that `at` could mean "still
 * running", and it is not worth it: it would have every machine uploading the
 * same sentence forever to keep a liveness dot honest, when the thing anyone
 * actually wants to know is *when the work appeared*, which is what `at` means
 * now and means more precisely for the silence.
 *
 * The delay is the other half. Publishing the instant something differs would
 * put a file on a synced drive on every keystroke that touches a new file; a
 * change that has stood for a couple of minutes is a change worth telling two
 * other computers about. Note this is a delay and not a settle: the clock is
 * not restarted by further edits, so a machine being worked on hard still
 * reports about every two minutes rather than going quiet until it stops.
 */
const SETTLE_MS = 2 * 60 * 1000

/** What the renderer hands over: one entry per workspace, whatever state it is in. */
export type RelayEntry = RelayPublishEntry

/**
 * What this machine last put on the disk, so an unchanged project writes nothing.
 *
 * Keyed by project rather than by workspace: two workspaces pointing at one
 * repository are one project, and the second would otherwise overwrite the
 * first's record on every pass with an identical one.
 *
 * Seeded from the folder on the first pass — see `shapeOf`. Without that, every
 * launch would find an empty map, decide that everything had changed, and
 * rewrite every project's record two minutes later to say exactly what it
 * already said.
 */
const published = new Map<string, string>()

/**
 * Projects this run has already compared against the folder, once each.
 *
 * Separate from `published` because "not seeded yet" and "seeded, and the disk
 * held nothing" are different states, and a project with no file on the disk
 * would otherwise be re-read on every sweep forever.
 */
const seeded = new Set<string>()

/**
 * When each project was first seen to differ from what is on the disk.
 *
 * Cleared the moment it agrees again, so a change made and undone inside the
 * delay is never published — which is most of what the delay is for.
 */
const pending = new Map<string, number>()

/** What was last published for each project, so an unchanged list writes nothing. */
const publishedCommands = new Map<string, string>()

/** When each project's command list was first seen to differ. See `COMMAND_SETTLE_MS`. */
const commandsPending = new Map<string, number>()

/**
 * Projects whose command list this run has looked at once.
 *
 * The first look publishes without waiting, exactly as the state record's does,
 * and here the reason is sharper: this map is empty at every launch, so with a
 * fifteen-minute clock and nothing else, a session shorter than fifteen minutes
 * would publish nothing at all — and a great many sessions are.
 */
const commandsSeeded = new Set<string>()

/**
 * How long a changed command list waits before it is published.
 *
 * Much longer than the state record's delay, because the two answer different
 * questions. "Has the laptop got work I have not seen" is worth knowing within
 * minutes. "What does somebody run in this project" is a description of how a
 * project is built, and nobody needs this morning's addition to it this
 * morning — while the list changes every time a new command is run, which
 * during a working hour is often.
 *
 * Without this the list was republished on the next sweep after any new
 * command: a few kilobytes of ciphertext per project, every minute or so, all
 * day, on a drive somebody is paying to sync.
 */
const COMMAND_SETTLE_MS = 15 * 60 * 1000

/**
 * Publishes this machine's account of every workspace, and returns everyone's.
 *
 * A blank `sharedDir` means the feature is off, and the answer says so rather
 * than being an empty success — a pane that cannot tell "switched off" from
 * "nobody has written anything" will send someone looking for a fault that is
 * not there.
 */
export async function publishRelay(
  dataDir: string,
  sharedDir: string,
  entries: readonly RelayEntry[],
  passphrase = ''
): Promise<Relay> {
  if (!sharedDir.trim())
    return { machine: '', keys: {}, byProject: {}, commandsByProject: {}, problem: 'off' }

  const me = await machine(dataDir)
  const root = path.join(sharedDir, SHARE_FOLDER)
  const keys: Record<string, string> = {}
  let wrote = false
  let failed = false

  for (const entry of entries) {
    let status: RepoStatus
    try {
      status = await repoStatus(entry.cwd)
    } catch {
      // A folder that has gone away with the drive it was on. Nothing to say
      // about it, and the machines that can still see it are unaffected.
      continue
    }
    // Not a repository. Relay has nothing to report about a folder git does not
    // know, and publishing an empty record would put a row in every other
    // machine's pane saying nothing at all.
    if (!status.root) continue

    const key = await projectKey(entry.cwd)
    keys[entry.cwd] = key

    // `repoPath`, never `path`. The absolute one is where the file sits on this
    // machine, and the whole point of publishing the list is that another
    // machine can compare it against its own — which it cannot do when one calls
    // a file `dev/thing/src/a.ts` and the other calls it `work/thing/src/a.ts`.
    // Relative to the repository root, forward slashes, as git says it.
    const changed = status.files
      .filter((file) => !file.untracked)
      .map((file) => file.repoPath)
      .sort()
    const untracked = status.files.filter((file) => file.untracked).length

    const shape = shapeOf({
      branch: status.branch,
      detached: status.detached || undefined,
      head: status.headFull,
      unsent: status.ahead,
      behind: status.behind,
      hasRemote: status.hasRemote,
      upstream: status.upstream,
      inProgress: status.inProgress,
      changed: changed.slice(0, MAX_CHANGED),
      untracked,
      open: entry.open,
      name: entry.name,
      path: entry.cwd,
    })

    // What is already on the disk, which on the first look means what a previous
    // run of this app left there — possibly days ago, possibly wrong since.
    const first = !seeded.has(key)
    if (first) {
      seeded.add(key)
      const mine = await readOwn(root, key, me.id)
      if (mine) published.set(key, shapeOf(mine))
    }

    // Commands go in their own file, always encrypted, and on their own
    // schedule: the state record is rewritten rarely by design, and a list of
    // commands changes every time one is run. Tying them together would mean
    // publishing state too often or commands too rarely.
    if (entry.commands?.length && passphrase) {
      await writeCommands(root, key, me, entry.commands, passphrase)
    }

    if (published.get(key) === shape) {
      // Unchanged, so nothing is written — not now and not in five minutes.
      // A project nobody has touched is silent on the shared folder.
      pending.delete(key)
      continue
    }

    // The first look of a session skips the wait entirely, and that is the case
    // it matters most in. Without a heartbeat, the record on the disk is only
    // corrected by this app running: leave the laptop showing "2 saves not
    // sent", close it, commit and push from a plain terminal, and every other
    // machine goes on reporting those two saves until ia_workspaces runs there
    // again. Making the correction wait a further two minutes after launch is
    // two more minutes of a stale warning, and a warning that has been wrong
    // once is a warning that gets ignored. There is also nothing to damp here —
    // the delay exists to absorb ongoing edits, and one look cannot be churn.
    //
    // From the second look on: one clock per project, started by the first
    // difference and never reset. A further change while it runs does not
    // restart it and does not start a second — when it expires, whatever is
    // true *then* gets written. Restarting it would turn the delay into a
    // settle, which inverts the feature: while someone is working, the
    // description differs on every sweep, so the clock would never expire and
    // the machine being worked on hardest would be the one that never reported.
    const since = first ? 0 : pending.get(key)
    if (since === undefined) {
      pending.set(key, Date.now())
      continue
    }
    if (Date.now() - since < SETTLE_MS) continue

    const record: RelayPresence = {
      machine: me.id,
      label: me.label,
      project: key,
      path: entry.cwd,
      name: entry.name,
      branch: status.branch,
      detached: status.detached || undefined,
      head: status.headFull,
      // `ahead`, not `unsent.length`. See `unsentSubjects` in `git.ts` for why
      // those are different numbers and why only this one belongs in a sentence
      // that names a branch.
      unsent: status.ahead,
      unsentSubjects: status.ahead ? await unsentSubjects(entry.cwd, MAX_SUBJECTS) : [],
      behind: status.behind,
      hasRemote: status.hasRemote,
      upstream: status.upstream,
      changed: changed.slice(0, MAX_CHANGED),
      untracked,
      inProgress: status.inProgress,
      open: entry.open,
      at: Date.now(),
    }

    try {
      await mkdir(path.join(root, key), { recursive: true })
      await writeFile(path.join(root, key, `${me.id}.json`), JSON.stringify(record, null, 2), 'utf8')
      published.set(key, shape)
      pending.delete(key)
      wrote = true
    } catch {
      // An unreachable share — the drive is not mounted, the network is down.
      // Noted rather than thrown: the other machines' records may still be
      // readable from a cache, and showing those beats showing an error.
      failed = true
    }
  }

  const byProject = await readRelay(root)
  const commandsByProject = passphrase ? await readCommands(root, me.id, passphrase) : {}
  const reachable = wrote || Object.keys(byProject).length > 0
  return {
    machine: me.id,
    keys,
    byProject,
    commandsByProject,
    problem: failed && !reachable ? 'unreachable' : undefined,
  }
}

/**
 * Writes this machine's commands for one project, encrypted.
 *
 * Rewritten in full each time rather than appended to: the list is already
 * capped, and a file that only grows is a file that eventually needs its own
 * maintenance story. Skipped entirely when nothing has changed, on the same
 * reasoning as the state record — a synced folder should not be asked to carry
 * the same sentence twice.
 */
async function writeCommands(
  root: string,
  key: string,
  me: { id: string; label: string },
  commands: readonly string[],
  passphrase: string
): Promise<void> {
  // Redacted here rather than by the caller, and this is the only place that
  // may write a command anywhere outside this machine. A choke point cannot be
  // forgotten by a second caller added later, and cannot be bypassed by a bug
  // in the renderer that assembles the list.
  const safe = commands.map(redact)

  const shape = JSON.stringify(safe)
  if (publishedCommands.get(key) === shape) {
    commandsPending.delete(key)
    return
  }

  // Same shape of clock as the state record's, and for the same reason: one
  // per project, started by the first difference and never reset, so a project
  // being worked on hard publishes on a fixed cadence rather than never.
  const first = !commandsSeeded.has(key)
  commandsSeeded.add(key)
  if (!first) {
    const since = commandsPending.get(key)
    if (since === undefined) {
      commandsPending.set(key, Date.now())
      return
    }
    if (Date.now() - since < COMMAND_SETTLE_MS) return
  }

  try {
    await mkdir(path.join(root, key), { recursive: true })
    // The label goes inside the sealed body rather than into the filename:
    // which machine ran what is part of what somebody would rather not publish.
    const body = seal(JSON.stringify({ machine: me.id, label: me.label, commands: safe }), passphrase)
    await writeFile(path.join(root, key, `cmd-${me.id}.json`), body, 'utf8')
    publishedCommands.set(key, shape)
    commandsPending.delete(key)
  } catch {
    // Unreachable share. The state record's own handling already reports that.
  }
}

/**
 * Every other machine's commands, by project, for the passphrases that match.
 *
 * A file this passphrase cannot open is skipped in silence. That is the
 * ordinary case for a machine set up with a different passphrase, and it is not
 * worth warning about on every sweep: the commands simply do not appear, which
 * is exactly what "cannot read them" should look like.
 */
async function readCommands(
  root: string,
  meId: string,
  passphrase: string
): Promise<Relay['commandsByProject']> {
  const out: Relay['commandsByProject'] = {}
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    let files
    try {
      files = await readdir(path.join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.startsWith('cmd-')) continue
      // This machine's own are already in its own history, and fresher.
      if (file.name === `cmd-${meId}.json`) continue
      try {
        const raw = await readFile(path.join(root, project.name, file.name), 'utf8')
        const opened = unseal(raw, passphrase)
        if (!opened) continue
        const record = JSON.parse(opened) as { machine: string; label: string; commands: string[] }
        if (!record?.machine || !Array.isArray(record.commands)) continue
        ;(out[project.name] ??= []).push({
          machine: record.machine,
          label: record.label || record.machine,
          commands: record.commands.filter((c) => typeof c === 'string' && c),
        })
      } catch {
        // Half-written by a sync client, or not ours at all.
      }
    }
  }
  return out
}

/** The part of a record that decides whether it is worth writing again. */
interface Shape {
  branch?: string
  detached?: boolean
  head?: string
  unsent: number
  behind: number
  hasRemote: boolean
  upstream?: string
  inProgress?: RelayPresence['inProgress']
  changed: string[]
  untracked: number
  open: boolean
  name: string
  path: string
}

/**
 * A record reduced to what a change means.
 *
 * `at` is left out, or every record would differ from itself. So are the unsent
 * saves' messages, which are a function of the head and the unsent count and so
 * cannot differ while those agree — and fetching them in order to decide
 * whether to write would spawn a git process on every pass to answer "no".
 *
 * Written as an explicit field list rather than over the record, so that adding
 * a field to `RelayPresence` is a deliberate decision about whether changing it
 * is news, rather than something that silently starts causing writes.
 */
function shapeOf(value: Shape): string {
  return JSON.stringify([
    value.branch ?? null,
    value.detached ?? false,
    value.head ?? null,
    value.unsent,
    value.behind,
    value.hasRemote,
    value.upstream ?? null,
    value.inProgress ?? null,
    value.changed,
    value.untracked,
    value.open,
    value.name,
    value.path,
  ])
}

/**
 * This machine's own record for one project, as it currently sits on the disk.
 *
 * Read once per project per run, to answer "did the last run of this app
 * already say exactly this?" — because without it, starting the app would find
 * an empty memory, conclude that every project had changed, and rewrite every
 * record two minutes later with identical contents. On three machines that is
 * three pointless uploads every time anyone opens the app.
 */
async function readOwn(root: string, key: string, id: string): Promise<Shape | null> {
  try {
    const raw = await readFile(path.join(root, key, `${id}.json`), 'utf8')
    const record = JSON.parse(raw) as RelayPresence
    if (!record?.machine) return null
    return {
      branch: record.branch,
      detached: record.detached,
      head: record.head,
      unsent: record.unsent,
      behind: record.behind,
      hasRemote: record.hasRemote,
      upstream: record.upstream,
      inProgress: record.inProgress,
      changed: Array.isArray(record.changed) ? record.changed : [],
      untracked: record.untracked,
      open: record.open,
      name: record.name,
      path: record.path,
    }
  } catch {
    // Never written, unreadable, or half-copied by a sync client. Treated as
    // "nothing on the disk", whose only cost is one write that says what the
    // file already said.
    return null
  }
}

/**
 * Every machine's record, tolerating anything that is not one of ours.
 *
 * Nothing here deletes another machine's file, for the same reason
 * `tokenShare.ts` does not: it is the only account of a machine that may be
 * switched off, and a machine that has been quiet for a month still holds the
 * most useful thing anyone can know about it. Age is shown, not enforced.
 */
async function readRelay(root: string): Promise<Record<string, RelayPresence[]>> {
  const out: Record<string, RelayPresence[]> = {}
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch {
    // Nothing written there yet, or the share is not reachable right now.
    return out
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue
    let files
    try {
      files = await readdir(path.join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json')) continue
      try {
        const raw = await readFile(path.join(root, project.name, file.name), 'utf8')
        const record = JSON.parse(raw) as RelayPresence
        if (!record?.machine || typeof record.at !== 'number') continue
        // The folder is the key, not whatever the file claims — a file moved
        // into the wrong folder must not quietly join the wrong project.
        record.project = project.name
        record.changed = Array.isArray(record.changed) ? record.changed : []
        record.unsentSubjects = Array.isArray(record.unsentSubjects) ? record.unsentSubjects : []
        ;(out[project.name] ??= []).push(record)
      } catch {
        // Half-written by a sync client mid-copy, or not ours at all. Skipped
        // rather than fatal: one bad file must not cost every other machine.
      }
    }
  }

  for (const key of Object.keys(out)) out[key] = newestPerMachine(out[key])
  return out
}

/**
 * One row per machine, newest first, however many files that machine has left.
 *
 * A sync client resolves a simultaneous write by keeping both sides — OneDrive
 * writes `name-MACHINE.json`, Dropbox writes `name (conflicted copy).json` —
 * and both end in `.json`, so both get read. Without this, the machine that was
 * written to from two places at once appears twice, with two different accounts
 * of itself, and the pane looks broken in precisely the situation it exists for.
 *
 * The newest wins, which is the same rule a person would apply, and the older
 * file is left alone: deleting another machine's file is not this app's to do,
 * and the sync client will tidy its own copy up.
 */
function newestPerMachine(records: RelayPresence[]): RelayPresence[] {
  const best = new Map<string, RelayPresence>()
  for (const record of records) {
    const seen = best.get(record.machine)
    if (!seen || record.at > seen.at) best.set(record.machine, record)
  }
  return [...best.values()].sort((a, b) => b.at - a.at)
}
