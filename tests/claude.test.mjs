// Round-trip check for the Claude Code integration: installing then removing it
// must leave settings.json indistinguishable from the file we started with,
// while never touching hooks or keys the user set themselves.
//
// Runs against a throwaway HOME so the real ~/.claude is never involved.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-claude-'))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const outfile = path.join(sandbox, 'claudeConfig.mjs')
await build({
  entryPoints: ['src/main/claudeConfig.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
})

const { readClaudeSettings, setClaudeIntegration } = await import(`file://${outfile}`)
const settingsFile = path.join(sandbox, '.claude', 'settings.json')
// The app's own data folder, where the note about what we replaced lives.
const stateDir = path.join(sandbox, 'appdata')

/**
 * The absolute path the hooks name.
 *
 * A bare `iaw` only resolves on the PATH of terminals this app spawned, so the
 * installed hooks carry the full path — see `claudeConfig.ts`.
 */
const IAW = 'C:\\Users\\test\\AppData\\Roaming\\ia_workspaces\\bin-electron\\iaw'

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

console.log('Claude Code integration')

// A config the user already owns: their own notification choice, their own hook
// on one of the events we also use, and unrelated settings.
const original = {
  model: 'opus',
  preferredNotifChannel: 'iterm2_with_bell',
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
    PreToolUse: [{ hooks: [{ type: 'command', command: 'echo untouched' }] }],
  },
}
fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
fs.writeFileSync(settingsFile, JSON.stringify(original, null, 2) + '\n')
const before = fs.readFileSync(settingsFile, 'utf8')

check('reports not-installed on an untouched file', () => {
  const info = readClaudeSettings()
  assert.equal(info.exists, true)
  assert.equal(info.bellEnabled, false)
  assert.equal(info.hooksInstalled, false)
})

check('installing reports success', () => {
  const res = setClaudeIntegration(true, stateDir, IAW)
  assert.equal(res.ok, true, res.error)
})

check('installing sets the bell and both hooks', () => {
  const info = readClaudeSettings()
  assert.equal(info.bellEnabled, true)
  assert.equal(info.hooksInstalled, true)
})

check("installing keeps the user's own hook on a shared event", () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const commands = config.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
  assert.ok(commands.includes('echo mine'))
  // The hook names the shim by absolute path, so the bare word never appears.
  assert.ok(commands.some((c) => c.includes('/iaw" notify --quiet')))
})

check('the conversation id is recorded on startup and on every prompt', () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  // Two events, because `SessionStart` alone reports an id for a conversation
  // that may never be had — and never written, and so never resumable.
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const commands = config.hooks[event].flatMap((g) => g.hooks.map((h) => h.command))
    assert.ok(
      commands.some((c) => c.includes('/iaw" session --quiet')),
      `${event} does not record the session`
    )
  }
})

check('installing twice adds nothing further', () => {
  setClaudeIntegration(true, stateDir, IAW)
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const ours = config.hooks.Stop.flatMap((g) => g.hooks).filter((h) =>
    h.command.includes(String.raw`/iaw" notify`)
  )
  assert.equal(ours.length, 1)
})

// Submitting a prompt is the only answer we can read without guessing, so it
// clears `blocked` — a pane must not sit on "waiting for you" through the whole
// turn that prompt kicked off. Focus deliberately does not do this; see
// `agentState.ts`.
check('submitting a prompt reports the pane unblocked', () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const commands = config.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command))
  assert.ok(
    commands.some((c) => c.includes('report-agent --run-start --unblocked')),
    'UserPromptSubmit does not clear the blocked flag'
  )
})

// An install from an older build is not "already there": if what our handler
// runs has changed since, leaving it alone means the upgrade never reaches
// anyone who installed before it.
check('an outdated handler of ours is reported as not installed', () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const groups = config.hooks.UserPromptSubmit
  for (const group of groups) {
    for (const handler of group.hooks) {
      if (handler.command.includes('report-agent')) {
        // Exactly what the previous version wrote.
        handler.command = handler.command.replace(' --run-start --unblocked', ' --run-start')
      }
    }
  }
  fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2) + '\n')
  assert.equal(readClaudeSettings().hooksInstalled, false)
})

check('installing over it rewrites the stale handler in place', () => {
  setClaudeIntegration(true, stateDir, IAW)
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const commands = config.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command))
  // Updated, not duplicated: one handler of ours on the event, and it is current.
  const ours = commands.filter((c) => c.includes('report-agent'))
  assert.equal(ours.length, 1)
  assert.ok(ours[0].includes('--run-start --unblocked'))
  assert.equal(readClaudeSettings().hooksInstalled, true)
})

// The path is not part of the instruction. A user who moved the app, or an
// install from a build that wrote the bare word, is still current — rewriting
// their config over a spelling difference is churn, not an upgrade.
check('a handler naming a different path is left alone', () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  const groups = config.hooks.UserPromptSubmit
  let rewritten = ''
  for (const group of groups) {
    for (const handler of group.hooks) {
      if (handler.command.includes('report-agent')) {
        handler.command = handler.command.replaceAll(`"${IAW.replaceAll('\\', '/')}"`, 'iaw')
        rewritten = handler.command
      }
    }
  }
  assert.ok(rewritten.includes('iaw report-agent'), 'the fixture did not rewrite the path')
  fs.writeFileSync(settingsFile, JSON.stringify(config, null, 2) + '\n')
  assert.equal(readClaudeSettings().hooksInstalled, true)
  // Restore the absolute-path spelling for the removal checks below.
  setClaudeIntegration(true, stateDir, IAW)
})

check('a backup of the original is kept', () => {
  assert.ok(fs.existsSync(settingsFile + '.iaw-backup'))
})

check('removing reports success', () => {
  const res = setClaudeIntegration(false, stateDir, IAW)
  assert.equal(res.ok, true, res.error)
})

check('removing restores the file exactly', () => {
  const after = fs.readFileSync(settingsFile, 'utf8')
  assert.deepEqual(JSON.parse(after), JSON.parse(before))
})

check("removing leaves the user's own notification choice alone", () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(config.preferredNotifChannel, 'iterm2_with_bell')
})

check('removing leaves unrelated hooks alone', () => {
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(config.hooks.PreToolUse[0].hooks[0].command, 'echo untouched')
})

// The other shape: a file we created ourselves, with nothing of the user's.
fs.rmSync(path.join(sandbox, '.claude'), { recursive: true, force: true })
check('installing creates the file when absent', () => {
  const res = setClaudeIntegration(true, stateDir, IAW)
  assert.equal(res.ok, true, res.error)
  assert.ok(fs.existsSync(settingsFile))
})

check('removing leaves no empty husks behind', () => {
  setClaudeIntegration(false, stateDir, IAW)
  const config = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.deepEqual(config, {}, 'no orphan hooks object, no orphan event keys')
})

check('removing is safe when there is no file at all', () => {
  fs.rmSync(path.join(sandbox, '.claude'), { recursive: true, force: true })
  const res = setClaudeIntegration(false, stateDir, IAW)
  assert.equal(res.ok, true)
})

check('a malformed settings.json is refused rather than overwritten', () => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, '{ not json')
  const res = setClaudeIntegration(true, stateDir, IAW)
  assert.equal(res.ok, false)
  assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ not json')
})

fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
