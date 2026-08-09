/**
 * Repairs the agent hooks this app installed into `~/.claude/settings.json`.
 *
 * Builds before this one wrote `iaw notify …` — the bare word — which only
 * resolves on the PATH of a terminal this app spawned. Anywhere else, Claude
 * Code reported `iaw: command not found` on every Stop.
 *
 * Toggling the integration off and on in Settings does the same thing, but only
 * once you are running a build new enough to write the fixed form. This is the
 * way out for anyone who is not, and it is idempotent: run it twice and the
 * second run reports nothing to do.
 *
 *   node tools/fix-hooks.mjs           # show what it would change
 *   node tools/fix-hooks.mjs --write   # change it
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = path.join(os.homedir(), '.claude', 'settings.json')
const shim = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'ia_workspaces',
  'bin-electron',
  'iaw'
)

const write = process.argv.includes('--write')

if (!fs.existsSync(settings)) {
  console.log(`No ${settings} — nothing to do.`)
  process.exit(0)
}

const raw = fs.readFileSync(settings, 'utf8')
let config
try {
  config = JSON.parse(raw)
} catch (err) {
  console.error(`${settings} is not valid JSON — refusing to touch it.`)
  console.error(String(err))
  process.exit(1)
}

/** Ours, in any form a previous build may have written. */
const isOurs = (command) =>
  typeof command === 'string' && /(^|[\s"/\\])iaw(\.cmd)?"? (notify|session)\b/.test(command)

/** The fixed form: absolute path, quiet, and unable to fail the hook. */
function repair(command) {
  const verb = /\bsession\b/.test(command) ? 'session' : 'notify'
  const body = /--body "([^"]*)"/.exec(command)?.[1]
  const quoted = `"${shim.replace(/\\/g, '/')}"`
  const hush = ' 2>/dev/null || true'
  if (verb === 'session') return `${quoted} session --quiet${hush}`
  return `${quoted} notify --quiet --title "Claude Code" --body "${body ?? 'needs you'}"${hush}`
}

const changes = []
for (const [event, groups] of Object.entries(config.hooks ?? {})) {
  if (!Array.isArray(groups)) continue
  for (const group of groups) {
    for (const handler of group?.hooks ?? []) {
      if (!isOurs(handler?.command)) continue
      const next = repair(handler.command)
      if (next === handler.command) continue
      changes.push({ event, from: handler.command, to: next })
      handler.command = next
    }
  }
}

if (!changes.length) {
  console.log('Nothing to repair — the hooks already name the shim by path.')
  process.exit(0)
}

for (const c of changes) {
  console.log(`${c.event}:`)
  console.log(`  - ${c.from}`)
  console.log(`  + ${c.to}`)
}

if (!write) {
  console.log(`\n${changes.length} hook(s) would change. Re-run with --write to apply.`)
  process.exit(0)
}

fs.copyFileSync(settings, `${settings}.before-fix-hooks`)
fs.writeFileSync(settings, JSON.stringify(config, null, 2) + '\n')
console.log(`\n${changes.length} hook(s) repaired.`)
console.log(`Previous file kept at ${settings}.before-fix-hooks`)
