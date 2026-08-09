// Manual end-to-end check of the `iaw` CLI against a running app.
//
// Not part of `npm test`: it needs a live app with at least one pane, so it is
// run by hand — `node tests/e2e.manual.mjs` — after starting the app.
//
// It drives the real `iaw.cmd` shim, so what it exercises is exactly what a
// Claude Code hook would execute, exit codes included.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dataDir = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  'ia_workspaces'
)
const pidDir = path.join(dataDir, 'pid-map')

let entries = []
try {
  entries = fs.readdirSync(pidDir).filter((f) => f.endsWith('.json'))
} catch {
  /* handled below */
}
if (!entries.length) {
  console.error('No panes registered. Start the app first (npm start), then re-run this.')
  process.exit(1)
}

const identity = JSON.parse(fs.readFileSync(path.join(pidDir, entries[0]), 'utf8'))
const iaw = path.join(dataDir, 'bin-electron', 'iaw.cmd')
if (!fs.existsSync(iaw)) {
  console.error(`No shim at ${iaw}.`)
  process.exit(1)
}

// The pane's own environment, exactly as a shell inside it would have.
const env = {
  ...process.env,
  IAW_PANE_ID: identity.paneId,
  IAW_PIPE: identity.pipe,
  IAW_TOKEN: identity.token,
}

const choicesFile = path.join(os.tmpdir(), 'iaw-e2e-choices.json')
fs.writeFileSync(
  choicesFile,
  JSON.stringify([
    { id: 'y', label: 'Allow once', key: '1', isDefault: true },
    { id: 'n', label: 'Deny', key: '2' },
  ])
)

let failures = 0
function run(label, args, expect = 0) {
  const res = spawnSync(iaw, args, { env, encoding: 'utf8', shell: true })
  const ok = res.status === expect
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(40)} exit=${res.status} (want ${expect})`)
  if (res.stderr?.trim()) console.log('        stderr:', res.stderr.trim())
  return res
}

console.log(`pane ${identity.paneId}\n`)

run('ping', ['ping'])
run('notify', ['notify', '--title', 'e2e', '--body', 'hello'])

// The reason string is deliberately URL-shaped ("scheme:rest"), which is the
// case that used to exit non-zero after succeeding.
run('report-agent, url-shaped reason', [
  'report-agent',
  '--blocked',
  '"permission: Bash(rm -rf build)"',
  '--choices',
  `@${choicesFile}`,
])

const state = run('agent-state', ['agent-state'])
const parsed = JSON.parse(state.stdout || '[]')
const pane = parsed.find((p) => p.paneId === identity.paneId)
const blockedOk = pane?.state === 'blocked' && pane.choices.length === 2
console.log(`${blockedOk ? 'ok  ' : 'FAIL'} pane reports blocked with 2 choices`)
if (!blockedOk) {
  failures++
  console.log('        got:', JSON.stringify(pane))
}

run('answer-agent', ['answer-agent', '--choice', 'y'])

const afterAnswer = JSON.parse(run('agent-state after answer', ['agent-state']).stdout || '[]')
const stillBlocked = afterAnswer.find((p) => p.paneId === identity.paneId)
const guardOk = stillBlocked?.state === 'blocked' && stillBlocked.answeredAt
console.log(`${guardOk ? 'ok  ' : 'FAIL'} answering does not clear blocked`)
if (!guardOk) failures++

run('report-agent --unblocked', ['report-agent', '--unblocked'])
run('answer-agent when not blocked is refused', ['answer-agent', '--choice', 'y'], 1)

console.log()
if (failures) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
