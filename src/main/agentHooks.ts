/**
 * Installing and removing our handlers in an agent's own hook configuration.
 *
 * Extracted from `claudeConfig.ts` when a second agent needed the same thing.
 * The mechanics are identical across every agent that keeps hooks in a JSON
 * settings file — merge without disturbing what is already there, recognise our
 * own handler so re-running is idempotent, and strip back out leaving a file
 * indistinguishable from one we never touched. Only the path, the event names
 * and the command differ, so those are the arguments.
 *
 * The protocol these install has never had a tool name in it. `iaw notify` and
 * `iaw session` know nothing about which agent invoked them — the pane is
 * identified by the environment, not by the caller. That was always the design;
 * until there was a second installer it was also merely a claim.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentConfigInfo } from '../shared/types'

/** What an agent needs to describe about itself to be installable. */
export interface AgentHookSpec {
  /** Stable key, used for the backup suffix and the prior-state file. */
  id: string
  /** Human name, for messages. */
  label: string
  /** Absolute path to the agent's settings file. */
  settingsPath(): string
  /**
   * Event name → the command to run, given the absolute path to our shim.
   *
   * Called with an empty path when only the event *names* matter — counting
   * what is missing, and stripping — so it must not depend on the value.
   */
  commands(iawPath: string): Record<string, string>
  /**
   * Whether this agent's hook groups carry a `matcher` key.
   *
   * Claude Code has matcher-based events (`SessionStart` fires for startup,
   * resume, clear and compact) and a group with no matcher key never fires at
   * all — which is exactly how the session id went unrecorded for a while
   * despite the other two hooks working. Harmless on non-matcher events, so it
   * is set per agent rather than per event.
   */
  matcherGroups: boolean
  /**
   * Anything the user has to do that installing cannot do for them.
   *
   * Shown in Settings beside the button. Exists for Codex, which gates hooks
   * behind a separate trust entry we deliberately do not forge — see `CODEX`.
   */
  note?: string
}

/**
 * Recognises a handler as ours.
 *
 * Deliberately loose about how the shim is spelled: builds have written a bare
 * `iaw`, an absolute POSIX path and a `.cmd`, and turning the integration off
 * has to find all of them. It is tight about the verb, so a user's own script
 * that merely mentions `iaw` somewhere is not swept up.
 */
export function isOurHook(command: unknown): boolean {
  return typeof command === 'string' && /(^|[\s"/\\])iaw(\.cmd)?"? (notify|session)\b/.test(command)
}

/** Every verb our hooks invoke. `isOurHook` is looser; this has to be exact. */
const VERBS = 'notify|session|report-agent'

/**
 * A hook command with the shim's path reduced to a placeholder, so two spellings
 * of the same instruction compare equal.
 *
 * Needed because staleness is decided by comparing an installed command against
 * the one we would write now, and the two legitimately disagree about the path:
 * `commands()` is documented as taking an empty path when only the event names
 * matter, builds have written a bare `iaw`, an absolute POSIX path and a `.cmd`,
 * and a user who moved the app has a valid install naming the old location.
 * None of those is a reason to rewrite their config; a changed *verb or flag*
 * is.
 */
export function hookShape(command: string): string {
  return command.replace(new RegExp(String.raw`(?:"[^"]*"|\S+)(?= (?:${VERBS})\b)`, 'g'), 'iaw')
}

/**
 * Adds our handler to each event, leaving any hooks the user already has in
 * place — this is their config, and these agents run every matching handler.
 */
export function mergeHooks(
  spec: AgentHookSpec,
  existing: unknown,
  iawPath: string
): { hooks: Record<string, unknown[]>; added: number } {
  const hooks: Record<string, unknown[]> =
    existing && typeof existing === 'object' ? { ...(existing as Record<string, unknown[]>) } : {}
  let added = 0

  for (const [event, command] of Object.entries(spec.commands(iawPath))) {
    const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : []
    const wanted = hookShape(command)

    // An earlier version of this app may already have written a handler here.
    // Finding one is not the end of the question: if what it runs has since
    // changed — a flag added to `report-agent`, a verb renamed — leaving it be
    // means the upgrade silently never reaches anybody who installed before it,
    // and `hooksInstalled` goes on reporting that everything is current. So a
    // handler of ours whose instruction no longer matches is rewritten in
    // place, keeping its position among whatever else the user has on the
    // event.
    let found = false
    let stale = false
    const refreshed = groups.map((group) => {
      const handlers = (group as { hooks?: unknown[] })?.hooks
      if (!Array.isArray(handlers)) return group
      let touched = false
      const next = handlers.map((h) => {
        const current = (h as { command?: unknown })?.command
        if (!isOurHook(current)) return h
        found = true
        if (hookShape(current as string) === wanted) return h
        stale = true
        touched = true
        return { ...(h as object), command }
      })
      return touched ? { ...(group as object), hooks: next } : group
    })

    if (found) {
      if (!stale) continue
      // Rewriting one counts the same as adding one: both mean the file on disk
      // is not yet what this version installs, which is exactly what `added`
      // is read for.
      hooks[event] = refreshed
      added++
      continue
    }

    groups.push(
      spec.matcherGroups
        ? { matcher: '', hooks: [{ type: 'command', command }] }
        : { hooks: [{ type: 'command', command }] }
    )
    hooks[event] = groups
    added++
  }

  return { hooks, added }
}

/**
 * Strips our handler back out of the user's hooks.
 *
 * Groups we added contain only our handler and go entirely; a group the user
 * merged us into keeps its other handlers. An event left with no groups, and a
 * `hooks` object left with no events, are removed rather than left as empty
 * husks — the aim is a file indistinguishable from one we never touched.
 */
export function stripHooks(
  spec: AgentHookSpec,
  existing: unknown
): { hooks: Record<string, unknown[]> | null; removed: number } {
  if (!existing || typeof existing !== 'object') return { hooks: null, removed: 0 }
  const hooks = { ...(existing as Record<string, unknown[]>) }
  let removed = 0

  // The path is irrelevant here: only the event names are read.
  for (const event of Object.keys(spec.commands(''))) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : null
    if (!groups) continue

    const kept: unknown[] = []
    for (const group of groups) {
      const handlers = (group as { hooks?: unknown[] })?.hooks
      if (!Array.isArray(handlers)) {
        kept.push(group)
        continue
      }
      const survivors = handlers.filter((h) => !isOurHook((h as { command?: unknown })?.command))
      if (survivors.length === handlers.length) {
        kept.push(group)
        continue
      }
      removed += handlers.length - survivors.length
      if (survivors.length) kept.push({ ...(group as object), hooks: survivors })
    }

    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }

  return { hooks: Object.keys(hooks).length ? hooks : null, removed }
}

export function readAgentHooks(spec: AgentHookSpec): AgentConfigInfo {
  const file = spec.settingsPath()
  const base = { id: spec.id, label: spec.label, path: file, note: spec.note }
  if (!existsSync(file)) return { ...base, exists: false, hooksInstalled: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const { added } = mergeHooks(spec, parsed.hooks, '')
    // Nothing left to add *or refresh* means every hook we install is already
    // there and still says what this version says. An install from an older
    // build whose commands have since changed reports false, so Settings offers
    // to bring it up to date rather than calling it done.
    return { ...base, exists: true, hooksInstalled: added === 0 }
  } catch {
    return { ...base, exists: true, hooksInstalled: false }
  }
}

/**
 * Installs or removes our handlers, and nothing else.
 *
 * Every write we make outside our own data folder has an exact inverse, and
 * both directions go through here. An integration you cannot turn off is not a
 * setting, it is damage — and the user's settings file is theirs. The original
 * is backed up before either direction touches it.
 */
export function setAgentHooks(
  spec: AgentHookSpec,
  enabled: boolean,
  iawPath: string
): { ok: boolean; error?: string; path: string } {
  const file = spec.settingsPath()
  try {
    let config: Record<string, unknown> = {}

    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      if (raw.trim()) {
        try {
          config = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return {
            ok: false,
            error: `${path.basename(file)} is not valid JSON — not touching it`,
            path: file,
          }
        }
      }
      copyFileSync(file, file + '.iaw-backup')
    } else {
      if (!enabled) return { ok: true, path: file } // nothing of ours to remove
      mkdirSync(path.dirname(file), { recursive: true })
    }

    if (enabled) {
      config.hooks = mergeHooks(spec, config.hooks, iawPath).hooks
    } else {
      const { hooks } = stripHooks(spec, config.hooks)
      if (hooks) config.hooks = hooks
      else delete config.hooks
    }

    writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
    return { ok: true, path: file }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), path: file }
  }
}
