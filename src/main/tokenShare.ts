/**
 * One project's token count, added up across every machine you work on it from.
 *
 * `tokenUsage.ts` can only ever answer for the machine it is running on —
 * Claude Code writes its transcripts to the local `~/.claude`, and a laptop
 * knows nothing about a desktop. So each machine writes down its own totals in
 * a folder you share between them (a synced drive, a network share), and every
 * machine adds up all the files it finds.
 *
 * **Totals, not transcripts.** What is written is a few dozen numbers per
 * project — no prompts, no replies, no file names, nothing either machine said.
 * Syncing the transcripts themselves would work too and was the other option;
 * it means moving a couple of hundred megabytes of your conversations through
 * somebody's cloud folder to answer a question that fits in two kilobytes.
 *
 * **Keyed by what the project *is*, not where it sits.** The same repository is
 * `C:\rootCloud\dev\thing` here and `~/work/thing` on a laptop, so a key made
 * from the path would file the two machines under two different projects and
 * merge nothing. The git remote is the identity where there is one — it is the
 * same string on every machine that cloned it — and the folder's own name is the
 * fallback where there is not.
 *
 * **Machines are only ever added, never merged.** Every file is stamped with a
 * machine id, so a machine that writes twice replaces its own line rather than
 * counting itself again, and one that has been switched off for a month keeps
 * contributing what it last knew. Nothing here deletes another machine's file:
 * it is the only copy of a number this app cannot recompute.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { originUrl, repoRoot } from './git'
import type { MachineTotals, SharedTokens, TokenPublishEntry } from '../shared/types'

/** Where each machine's identity is kept, so it survives a rename. */
const IDENTITY_NAME = 'machine.json'
/** The folder this app makes inside whatever share folder it is given. */
const SHARE_FOLDER = 'ia_workspaces-tokens'

let identity: { id: string; label: string } | null = null

/**
 * This machine, as the other machines will see it.
 *
 * The id is random and written down once rather than derived from the hostname,
 * because a hostname is a thing people change — and a machine that changes its
 * id stops replacing its own file and starts double-counting itself, which is
 * the one arithmetic error this whole mechanism exists to avoid. The *label* is
 * the hostname, and is free to change: it is only ever shown, never matched on.
 */
async function machine(dataDir: string): Promise<{ id: string; label: string }> {
  if (identity) return { ...identity, label: os.hostname() || identity.label }

  const file = path.join(dataDir, IDENTITY_NAME)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed?.id === 'string' && parsed.id) {
      identity = { id: parsed.id, label: os.hostname() || parsed.label || parsed.id }
      return identity
    }
  } catch {
    // No identity yet, or an unreadable one. Either way this machine gets a new
    // name — which is safe, because the worst case is that its old file lingers
    // in the share and is attributed to a machine nobody recognises. Better
    // that than two machines agreeing on one id.
  }

  const label = os.hostname() || 'this machine'
  identity = {
    id: `${slug(label).slice(0, 12) || 'machine'}-${createHash('sha256')
      .update(`${label}:${os.homedir()}:${Date.now()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 8)}`,
    label,
  }
  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(file, JSON.stringify(identity), 'utf8')
  } catch {
    // Unwritable state folder: the id lasts as long as the process. Sharing
    // still works today; tomorrow this machine appears under a new name.
  }
  return identity
}

/** Filesystem-safe, and stable across the platforms this runs on. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * A git remote reduced to the part that is the same everywhere.
 *
 * `git@github.com:me/thing.git`, `https://github.com/me/thing.git` and
 * `https://github.com/me/thing` are one repository written three ways, and two
 * machines that cloned it differently must still land on one key.
 */
function normaliseRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:/g, '/')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/**
 * What identifies this project to every machine that has it.
 *
 * The remote where there is one; the folder's own name where there is not. The
 * fallback is deliberately weak and deliberately kept: two unrelated folders
 * both called `scripts` will merge, and that is a smaller surprise than a
 * project which silently refuses to add up because nobody ever pushed it
 * anywhere. The folder each machine used travels in the file, so the panel can
 * show what actually got merged.
 */
async function projectKey(cwd: string): Promise<string> {
  try {
    const root = await repoRoot(cwd)
    if (root) {
      const url = await originUrl(root)
      if (url) return `git-${createHash('sha256').update(normaliseRemote(url)).digest('hex').slice(0, 16)}`
    }
  } catch {
    // Not a repository, or git is not installed. The folder name it is.
  }
  return `dir-${slug(path.basename(cwd)) || 'unnamed'}`
}

/** What the renderer hands over: one entry per workspace that has spent anything. */
export type PublishEntry = TokenPublishEntry

/**
 * What was written last time, so an idle minute writes nothing.
 *
 * A file rewritten every sixty seconds is a file a sync client uploads every
 * sixty seconds, forever, to say the same thing. Only a changed total is worth
 * anyone's bandwidth.
 */
const published = new Map<string, string>()

/**
 * Publishes this machine's totals and returns everyone's.
 *
 * `shareDir` blank means the feature is off, and the answer is an empty share
 * rather than an error — the panel then shows this machine's own numbers, which
 * is exactly what it showed before any of this existed.
 */
export async function shareTokens(
  dataDir: string,
  shareDir: string,
  entries: PublishEntry[]
): Promise<SharedTokens> {
  if (!shareDir.trim()) return { machine: '', keys: {}, byProject: {} }

  const me = await machine(dataDir)
  const root = path.join(shareDir, SHARE_FOLDER)
  const keys: Record<string, string> = {}

  for (const entry of entries) {
    const key = await projectKey(entry.cwd)
    keys[entry.cwd] = key

    const record: MachineTotals = {
      machine: me.id,
      label: me.label,
      project: key,
      path: entry.cwd,
      name: entry.name,
      totals: entry.totals,
      cost: entry.cost,
      costs: entry.costs,
      at: Date.now(),
    }

    // `at` is deliberately left out of the comparison: a heartbeat is not news,
    // and including it would rewrite every file on every poll.
    const shape = JSON.stringify({ ...record, at: 0 })
    if (published.get(key) === shape) continue

    try {
      await mkdir(path.join(root, key), { recursive: true })
      await writeFile(path.join(root, key, `${me.id}.json`), JSON.stringify(record, null, 2), 'utf8')
      published.set(key, shape)
    } catch {
      // An unreachable share — the drive is not mounted, the network is down.
      // This machine keeps its own count and says so; it does not fail the read.
    }
  }

  return { machine: me.id, keys, byProject: await readShare(root) }
}

/** Every machine's file, tolerating anything that is not one of ours. */
async function readShare(root: string): Promise<Record<string, MachineTotals[]>> {
  const out: Record<string, MachineTotals[]> = {}
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
        const record = JSON.parse(raw) as MachineTotals
        if (!record?.machine || !record?.totals) continue
        // The folder is the key, not whatever the file claims — a file moved
        // into the wrong folder must not quietly join the wrong project.
        record.project = project.name
        ;(out[project.name] ??= []).push(record)
      } catch {
        // Half-written by a sync client mid-copy, or not ours at all. Skipped
        // rather than fatal: one bad file must not cost every other machine.
      }
    }
  }
  return out
}
