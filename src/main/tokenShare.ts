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
 *
 * Who this machine is and what a project is called on all of them live in
 * `shareIdentity.ts`, because `relay.ts` writes into the same synced folder and
 * the two must agree about both or a laptop files itself under two names.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { machine, projectKey } from './shareIdentity'
import type { MachineTotals, SharedTokens, TokenPublishEntry } from '../shared/types'

/** The folder this app makes inside whatever share folder it is given. */
const SHARE_FOLDER = 'ia_workspaces-tokens'

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
