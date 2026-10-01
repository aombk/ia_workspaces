// What one store change costs in round trips to the host.
//
// A store change happens several times a second while an agent is printing,
// and two things answered every one of them with a message to the main
// process: the sidebar asking which programs are running (three round trips),
// and the time tracker saying which project is in front of you. Both answers
// change far more slowly than that. These pin down that a burst of changes
// costs a burst of nothing — and that the answers still arrive.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-emit-cost-'))

// The renderer modules reach for `window` and `document`; only the parts they
// touch on these paths are here.
let focused = true
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} }
globalThis.document = { hasFocus: () => focused }

await build({
  entryPoints: {
    state: 'src/renderer/state.ts',
    backend: 'src/backend/index.ts',
    appsMenu: 'src/renderer/ui/appsMenu.ts',
    timeMonitor: 'src/renderer/ui/timeMonitor.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  splitting: true,
})

const calls = { supported: 0, reason: 0, running: 0, beats: [] }
const { setBackend } = await import(`file://${out}/backend.js`)
setBackend({
  loadState: async () => ({
    version: 4,
    activeWorkspaceId: 'a',
    workspaces: [
      { id: 'a', name: 'one', cwd: '/one', color: '#888888', tabs: [], activeTabId: null },
      { id: 'b', name: 'two', cwd: '/two', color: '#888888', tabs: [], activeTabId: null },
    ],
  }),
  saveState: async () => {},
  onExternalStateChange: () => () => {},
  timeBeat: async (cwd, name) => {
    calls.beats.push(`${cwd}|${name}`)
  },
  timeSpans: async () => [],
  apps: {
    supported: async () => {
      calls.supported++
      return true
    },
    reason: async () => {
      calls.reason++
      return ''
    },
    running: async () => {
      calls.running++
      return []
    },
  },
})

const { store } = await import(`file://${out}/state.js`)
const { refreshRunningAppsLazily, refreshRunningApps } = await import(`file://${out}/appsMenu.js`)
const { initTimeMonitor } = await import(`file://${out}/timeMonitor.js`)
await store.load()

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}
const settle = () => new Promise((r) => setTimeout(r, 10))

console.log('One store change, in round trips')

await check('a burst of sidebar draws asks the host about programs once', async () => {
  for (let i = 0; i < 50; i++) refreshRunningAppsLazily()
  await settle()
  for (let i = 0; i < 50; i++) refreshRunningAppsLazily()
  await settle()
  assert.deepEqual([calls.supported, calls.reason, calls.running], [1, 1, 1])
})

await check('starting a program still refreshes the list straight away', async () => {
  await refreshRunningApps()
  assert.deepEqual([calls.supported, calls.reason, calls.running], [2, 2, 2])
})

await check('the time tracker speaks on news, not on every change', async () => {
  initTimeMonitor()
  await settle()
  const first = calls.beats.length
  assert.equal(calls.beats.at(-1), '/one|one')
  // Unrelated changes: nothing about which project is in front changed.
  for (let i = 0; i < 20; i++) store.updateSettings({ showTabCount: i % 2 === 0 })
  await settle()
  assert.equal(calls.beats.length, first)
  // Switching workspace is news, and goes straight out.
  store.setActiveWorkspace('b')
  await settle()
  assert.equal(calls.beats.length, first + 1)
  assert.equal(calls.beats.at(-1), '/two|two')
  // So is the window losing the focus, when the next change comes along.
  focused = false
  store.updateSettings({ showTabCount: true })
  await settle()
  assert.equal(calls.beats.at(-1), '|')
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
// The time tracker's own clock is an interval that never ends on its own.
process.exit(0)
