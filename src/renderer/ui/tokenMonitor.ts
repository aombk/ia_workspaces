/**
 * What each workspace has spent — on this machine, and on the others.
 *
 * Three jobs, and each is a decision rather than a lookup.
 *
 * **Folders become workspaces, deepest match winning.** The main process counts
 * per *folder*, because that is what Claude Code records; it knows nothing about
 * workspaces. A folder is counted towards the deepest workspace it sits inside,
 * which is what makes nesting add up — a parent at `dev/thing` and a child at
 * `dev/thing/borf` would otherwise both claim a conversation held in `borf` —
 * and what lets a session started in a *subfolder* count towards the workspace
 * above it rather than vanishing.
 *
 * **Machines are merged, not summed twice.** Each machine writes its own totals
 * into a shared folder keyed by machine id, so a machine that publishes twice
 * replaces its own line. See `tokenShare.ts`; this side only adds up what comes
 * back and remembers which row is ours.
 *
 * **Every figure names the class it belongs to.** "I spent a million tokens" is
 * a sentence with no single meaning, and pretending otherwise is what made the
 * first version of this confusing. Anthropic bills four classes of token at four
 * different rates — base input, output, cache writes, and **cache hits**, which
 * is the official name for the conversation being sent up again on every reply.
 * Cache hits were 97.5% of every token counted on the machine this was written
 * on, and they cost a tenth of base input.
 *
 * This module answers those questions and draws none of them. `tokensPane.ts` is
 * the one place the figures are formatted, which is why a badge, a monitor block
 * and two kinds of hover text could each be tried and dropped without any of the
 * counting moving.
 */
import { backend } from '../../backend'
import { store } from '../state'
import {
  zeroCosts,
  type CostBreakdown,
  type MachineTotals,
  type ProjectTokenUsage,
  type SharedTokens,
  type TokenReport,
  type TokenTotals,
} from '../../shared/types'

/** Local files, already-parsed offsets: a minute costs almost nothing. */
const POLL_MS = 60 * 1000

let latest: TokenReport | null = null
let shared: SharedTokens = { machine: '', keys: {}, byProject: {} }
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

export function initTokenMonitor(): void {
  void refresh()
  // Coming back to the window is when you are most likely to be looking, and
  // most likely to have just finished a conversation somewhere else.
  window.addEventListener('focus', () => void refresh())
}

/**
 * The last report, or null before the first.
 *
 * Null is not zero and is drawn differently — the first scan reads every
 * transcript on the disk, and "still counting" must not look like "nothing".
 */
export function latestTokens(): TokenReport | null {
  return latest
}

/** Whether totals are being pooled with other machines at all. */
export function sharingOn(): boolean {
  return Boolean(shared.machine)
}

/** Called whenever a new report lands, for anything that draws one. */
export function watchTokens(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Asks now rather than waiting for the poll. */
export function refreshTokensNow(): void {
  void refresh()
}

async function refresh(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  try {
    latest = await backend().claudeTokens()
  } catch {
    // A failed read leaves the last good report on screen rather than blanking
    // it. Nothing here is live enough for a stale number to mislead anyone.
  }

  // Publishing happens after counting and before drawing, so the share folder
  // and the screen agree. It is skipped entirely when no folder is configured —
  // the call returns an empty share without touching a disk.
  try {
    shared = await backend().shareTokens(store.settings.sharedDir ?? '', localEntries())
  } catch {
    // An unreachable share — an unmounted drive, a network that is down. This
    // machine's own numbers are unaffected, and that is what gets drawn.
  }

  cached = null
  for (const fn of listeners) fn()
  timer = setTimeout(() => void refresh(), POLL_MS)
}

/** This machine's own per-workspace totals, on their way to the shared folder. */
function localEntries() {
  const out = []
  for (const workspace of store.workspaces) {
    const own = localOnly(workspace.id)
    if (own)
      out.push({
        cwd: workspace.cwd,
        name: workspace.name,
        totals: own.totals,
        cost: own.cost,
        costs: own.costs,
      })
  }
  return out
}

/**
 * Path comparison as the filesystem means it, not as JavaScript does.
 *
 * Windows is case-insensitive and writes separators both ways round — the same
 * folder reaches us as `C:\rootCloud\dev` from one place and `C:/rootCloud/dev`
 * from another. Comparing the strings raw is how a workspace ends up reporting
 * nothing while its tokens sit in a row called "other folders".
 */
function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Whether `child` is `parent` or sits inside it. */
function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`)
}

/** Which workspace owns each counted folder, and what is left over. */
export interface TokenOwnership {
  byWorkspace: Map<string, ProjectTokenUsage[]>
  orphans: ProjectTokenUsage[]
}

let cached: { key: string; value: TokenOwnership } | null = null

/**
 * Folders assigned to workspaces, deepest match winning.
 *
 * Memoised on the report and the set of workspace folders, because the sidebar
 * asks once per row per repaint and the answer only changes when one of those
 * two does.
 */
export function ownership(): TokenOwnership {
  const report = latest
  const roots = store.workspaces.map((w) => ({ id: w.id, cwd: normalise(w.cwd) }))
  const key = `${report?.scannedAt ?? 0}|${roots.map((r) => `${r.id}:${r.cwd}`).join('|')}`
  if (cached && cached.key === key) return cached.value

  const value: TokenOwnership = { byWorkspace: new Map(), orphans: [] }
  for (const project of report?.projects ?? []) {
    const where = normalise(project.cwd)
    let best: { id: string; cwd: string } | null = null
    for (const root of roots) {
      if (!root.cwd || !isInside(where, root.cwd)) continue
      // Deepest wins: a nested workspace keeps its own tokens instead of
      // handing them to the parent it happens to live inside.
      if (!best || root.cwd.length > best.cwd.length) best = root
    }
    if (!best) {
      value.orphans.push(project)
      continue
    }
    const list = value.byWorkspace.get(best.id)
    if (list) list.push(project)
    else value.byWorkspace.set(best.id, [project])
  }

  cached = { key, value }
  return value
}

/** Empty counters. */
function zero(): TokenTotals {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, messages: 0 }
}

function fold(into: TokenTotals, from: TokenTotals): void {
  into.input += from.input
  into.output += from.output
  into.cacheWrite5m += from.cacheWrite5m
  into.cacheWrite1h += from.cacheWrite1h
  into.cacheRead += from.cacheRead
  into.messages += from.messages
}

/** One workspace's spend — its own, not its child workspaces'. */
export interface WorkspaceTokens {
  totals: TokenTotals
  /** The headline: everything except cache hits. See the note above. */
  fresh: number
  /** Everything, cache hits included — every token the API processed. */
  total: number
  cost: number
  /** That cost per token class, so the total can be checked rather than believed. */
  costs: CostBreakdown
  /** New tokens today and over the last seven days. */
  today: number
  week: number
  /** The heaviest day in the last month, which is usually the day you remember. */
  busiest: { day: string; tokens: number } | null
  /** When this project last said anything, so a big number can be an old one. */
  lastAt: number | null
  /** Which models did the work, biggest share first. */
  models: string[]
  unpricedModels: string[]
  folders: string[]
  /**
   * One row per machine, when totals are pooled. Empty when sharing is off,
   * which is how the panel knows to say "this machine" instead of listing one.
   */
  machines: Array<{ label: string; fresh: number; cost: number; at: number; self: boolean }>
}

/**
 * What this machine alone counted for a workspace. The thing that gets
 * published — a machine must never publish its own copy of everyone else's.
 */
function localOnly(workspaceId: string): WorkspaceTokens | null {
  const projects = ownership().byWorkspace.get(workspaceId)
  if (!projects || !projects.length) return null
  return summarise(projects)
}

/** What a workspace has spent, across every machine that has reported one. */
export function workspaceTokens(workspaceId: string): WorkspaceTokens | null {
  const workspace = store.workspaces.find((w) => w.id === workspaceId)
  const own = localOnly(workspaceId)
  const others = workspace ? machinesFor(workspace.cwd) : []
  if (!own && !others.length) return null

  // Sharing off, or nobody else has ever reported: this machine's own numbers,
  // with no machine list to imply a comparison that does not exist.
  if (!others.length) return own

  const totals = zero()
  const costs = zeroCosts()
  let cost = 0
  const machines: WorkspaceTokens['machines'] = []
  for (const machine of others) {
    fold(totals, machine.totals)
    cost += machine.cost
    // The class split travels too, so the five rows of the stats table still
    // add up to the figure under them once several machines are pooled. A
    // record written before that field existed contributes its tokens and no
    // dollars to the split — which the table would rather show than fake.
    if (machine.costs) {
      costs.input += machine.costs.input
      costs.output += machine.costs.output
      costs.cacheWrite5m += machine.costs.cacheWrite5m
      costs.cacheWrite1h += machine.costs.cacheWrite1h
      costs.cacheRead += machine.costs.cacheRead
    }
    machines.push({
      label: machine.label,
      fresh: freshOf(machine.totals),
      cost: machine.cost,
      at: machine.at,
      self: machine.machine === shared.machine,
    })
  }
  machines.sort((a, b) => b.fresh - a.fresh)

  return {
    totals,
    fresh: freshOf(totals),
    total: totalOf(totals),
    cost,
    costs,
    // Days are local: another machine publishes its totals, not its calendar.
    // Saying "today" for a pooled figure would be a number this machine cannot
    // stand behind, so the recent slices stay this machine's own and say so.
    today: own?.today ?? 0,
    week: own?.week ?? 0,
    busiest: own?.busiest ?? null,
    lastAt: others.reduce<number | null>((a, m) => (a === null || m.at > a ? m.at : a), null),
    models: own?.models ?? [],
    unpricedModels: own?.unpricedModels ?? [],
    folders: [...new Set(others.map((m) => m.path))],
    machines,
  }
}

/**
 * Every machine's row for a folder, this one included.
 *
 * Keyed by what the project *is* rather than where it sits — see `tokenShare.ts`
 * — so the same repository checked out at two different paths lines up.
 */
function machinesFor(cwd: string): MachineTotals[] {
  if (!shared.machine) return []
  const key = shared.keys[cwd]
  return key ? (shared.byProject[key] ?? []) : []
}

// Folders under no workspace are still tracked by `ownership`, and deliberately
// have nowhere to appear: with the counts living on a workspace's own hover,
// there is no row for a folder that is not one. They stay in the model because
// the day something wants to say "and 12M elsewhere", the number is already
// there and correct.

function summarise(projects: ProjectTokenUsage[]): WorkspaceTokens {
  const totals = zero()
  let cost = 0
  const costs = zeroCosts()
  let lastAt: number | null = null
  const unpriced = new Set<string>()
  const days = new Map<string, number>()
  const byModel = new Map<string, number>()

  for (const project of projects) {
    fold(totals, project.totals)
    cost += project.cost
    costs.input += project.costs.input
    costs.output += project.costs.output
    costs.cacheWrite5m += project.costs.cacheWrite5m
    costs.cacheWrite1h += project.costs.cacheWrite1h
    costs.cacheRead += project.costs.cacheRead
    if (project.lastAt !== null && (lastAt === null || project.lastAt > lastAt)) lastAt = project.lastAt
    for (const model of project.unpricedModels) unpriced.add(model)
    for (const [day, tokens] of Object.entries(project.days)) {
      days.set(day, (days.get(day) ?? 0) + tokens)
    }
    for (const [model, t] of Object.entries(project.byModel)) {
      byModel.set(model, (byModel.get(model) ?? 0) + freshOf(t))
    }
  }

  const todayKey = dayKey(new Date())
  const weekAgo = dayKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000))
  let today = 0
  let week = 0
  let busiest: { day: string; tokens: number } | null = null
  for (const [day, tokens] of days) {
    if (day === todayKey) today += tokens
    if (day >= weekAgo) week += tokens
    if (!busiest || tokens > busiest.tokens) busiest = { day, tokens }
  }

  return {
    totals,
    fresh: freshOf(totals),
    total: totalOf(totals),
    cost,
    costs,
    today,
    week,
    busiest,
    lastAt,
    // Biggest share first, and models that did nothing left out — a list of
    // every model the folder has ever seen is a list, not a fact.
    models: [...byModel.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([model]) => model),
    unpricedModels: [...unpriced],
    folders: projects.map((p) => p.cwd),
    machines: [],
  }
}

function dayKey(at: Date): string {
  const month = `${at.getMonth() + 1}`.padStart(2, '0')
  const day = `${at.getDate()}`.padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

/** Everything, re-reads included. */
export function totalOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead
}

/** The headline: what was new, rather than what was read back. */
export function freshOf(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h
}

/** What one conversation has spent, for the tab it is running in. */
export function sessionTokens(id: string): { fresh: number; total: number; cost: number } | null {
  const found = latest?.sessions.find((s) => s.id === id)
  return found
    ? { fresh: freshOf(found.totals), total: totalOf(found.totals), cost: found.cost }
    : null
}

/**
 * `8.4M`, `240K`, `1.2B` — two significant figures and a suffix.
 *
 * A token count is never read as a quantity, only as a comparison: this project
 * against that one. Nine digits of it is a number you have to count the commas
 * of, which is a number you skip.
 */
export function tokenCount(n: number): string {
  if (n < 1000) return `${Math.round(n)}`
  if (n < 1_000_000) return `${trim(n / 1000)}K`
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`
  return `${trim(n / 1_000_000_000)}B`
}

function trim(n: number): string {
  return n < 10 ? n.toFixed(1) : `${Math.round(n)}`
}

/** `$12.40`, or `$1,240` once the cents have stopped mattering. */
export function money(n: number): string {
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`
  if (n >= 10) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

/**
 * The one sentence that has to travel with every dollar figure in this app.
 *
 * Claude Code is signed in to a subscription, which does not bill per token. The
 * number is what the same work would have cost on the API — the right way to
 * compare two projects, and the wrong way to predict a bill. Said in one place
 * so it is said the same way in all of them.
 */
export const COST_CAVEAT =
  'What this would have cost at API prices. Your plan is a subscription, so this is not a bill — it is how projects compare.'

// The hover text that used to live here is gone: the counts are a tab now, and
//  formats them. What stays is the data — this module answers
// what a workspace has spent and who reported it, and no longer draws anything.
