/**
 * Who this machine is, and what a project is called on all of them.
 *
 * Both answers were worked out for `tokenShare.ts` and are needed verbatim by
 * `relay.ts`: two features writing into the same synced folder have to agree
 * about which machine wrote a file and which project it belongs to, or a laptop
 * files its token totals under one key and its relay presence under another and
 * the two never line up on the desktop. Copying the logic would have worked
 * until the day one copy learned about a new remote format.
 *
 * Nothing here touches the network and nothing here throws.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { originUrl, checkoutRoot } from './git'

/** Where each machine's identity is kept, so it survives a rename. */
const IDENTITY_NAME = 'machine.json'

export interface Machine {
  id: string
  label: string
}

let identity: Machine | null = null

/**
 * This machine, as the other machines will see it.
 *
 * The id is random and written down once rather than derived from the hostname,
 * because a hostname is a thing people change — and a machine that changes its
 * id stops replacing its own file and starts appearing twice, which is the one
 * error this whole mechanism exists to avoid. The *label* is the hostname, and
 * is free to change: it is only ever shown, never matched on.
 */
export async function machine(dataDir: string): Promise<Machine> {
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
export function slug(text: string): string {
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
export function normaliseRemote(url: string): string {
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
 * project which silently refuses to line up because nobody ever pushed it
 * anywhere. The folder each machine used travels in the record, so a pane can
 * show what actually got matched.
 */
export async function projectKey(cwd: string): Promise<string> {
  try {
    const root = await checkoutRoot(cwd)
    if (root) {
      const url = await originUrl(root)
      if (url) return `git-${createHash('sha256').update(normaliseRemote(url)).digest('hex').slice(0, 16)}`
    }
  } catch {
    // Not a repository, or git is not installed. The folder name it is.
  }
  return `dir-${slug(path.basename(cwd)) || 'unnamed'}`
}
