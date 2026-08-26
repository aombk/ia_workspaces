// What a pane is asking of you, and what settles it.
//
// This suite exists because of a bug that was reported the only way this one
// ever could be: somebody sat typing into a pane that was blinking at them, in
// a workspace that was blinking at them, and nothing they could do from inside
// that pane would stop it. Attention was cleared by three *navigation* events —
// mounting a different tab, clicking a notification, refocusing the window —
// and a signal that arrived while you were already in the pane had none of them
// available. Leaving the tab and coming back was the only way out.
//
// So the centrepiece here is "already here": every check that matters puts the
// signal on the pane the user is looking at and asserts that it does not stick.
// The rest guards the ordering and the two-level settling, which are the parts
// most likely to be quietly broken by a later change.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-attention-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// state.ts reaches for the timer functions off `window`, for the injected
// backend adapter, and — the one this suite actually cares about — for
// `document.hasFocus()`, which is half of `isAttended`. Focus is a thing the
// tests drive, so it is a variable rather than a constant.
let focused = true
globalThis.window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
}
globalThis.document = {
  hasFocus: () => focused,
}

await build({
  entryPoints: {
    state: 'src/renderer/state.ts',
    backend: 'src/backend/index.ts',
    palette: 'src/renderer/ui/palette.ts',
    markdown: 'src/renderer/markdown.ts',
    wsl: 'src/shared/wsl.ts',
    types: 'src/shared/types.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  splitting: true,
})

const { store, louder } = await import(`file://${out}/state.js`)
const { setBackend } = await import(`file://${out}/backend.js`)

let pending = {}
setBackend({
  loadState: async () => pending,
  saveState: async () => {},
  onExternalStateChange: () => () => {},
})

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

/**
 * Two workspaces, two tabs each, one pane per tab.
 *
 * Enough shape to ask every question this suite asks: a pane you are in, a pane
 * in the same tab's workspace that you are not, and a whole other workspace.
 */
const pane = (id) => ({ id, cwd: '/tmp', autoTitle: '' })
const mkTab = (id) => ({
  id,
  customTitle: null,
  panes: [pane(`${id}-p`)],
  layout: { kind: 'leaf', paneId: `${id}-p` },
  activePaneId: `${id}-p`,
})
const mkWorkspace = (id) => ({
  id,
  name: id,
  cwd: '/tmp',
  color: '#888888',
  tabs: [mkTab(`${id}-t1`), mkTab(`${id}-t2`)],
  activeTabId: `${id}-t1`,
})

async function reset() {
  focused = true
  pending = {
    version: 3,
    workspaces: [mkWorkspace('w1'), mkWorkspace('w2')],
    activeWorkspaceId: 'w1',
  }
  await store.load()
  // A clean slate between checks: the sets outlive a document load.
  for (const w of store.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        store.clearAttention(p.id)
        store.forgetPaneStatus(p.id)
      }
    }
  }
  store.settleAttended()
}

/** The agent report shape `setPaneAgent` stores, at whatever state is wanted. */
const agent = (paneId, state) => ({
  paneId,
  state,
  awaitingHuman: state === 'blocked',
  runDepth: state === 'working' ? 1 : 0,
  blockedReason: state === 'blocked' ? 'permission' : null,
  choices: [],
  answeredAt: null,
  updatedAt: 0,
})

const HERE = 'w1-t1-p' // the active pane of the active tab of the active workspace
const SAME_WS = 'w1-t2-p' // another tab in the same workspace
const AWAY = 'w2-t1-p' // a different workspace entirely

console.log('The pane you are in')

await check('a notice on the pane you are looking at never latches', async () => {
  await reset()
  store.markAttention(HERE)
  assert.equal(store.paneDemand(HERE), 'none', 'you are looking straight at it')
})

await check('an agent finishing in front of you does not blink at you', async () => {
  await reset()
  store.setPaneAgent(HERE, agent(HERE, 'working'))
  store.setPaneAgent(HERE, agent(HERE, 'idle'))
  assert.equal(store.paneDemand(HERE), 'none')
})

await check('a question arriving in front of you does not blink at you', async () => {
  await reset()
  store.setPaneAgent(HERE, agent(HERE, 'blocked'))
  assert.equal(store.paneDemand(HERE), 'none', 'the pane is settled')
  assert.equal(store.paneBlocked(HERE), true, 'but the question is still open')
})

await check('the workspace does not blink for a question you are sitting on', async () => {
  await reset()
  store.setPaneAgent(HERE, agent(HERE, 'blocked'))
  assert.equal(store.workspaceDemand('w1'), 'none')
})

await check('typing settles a notice that arrived before you got there', async () => {
  await reset()
  focused = false // it arrived while you were elsewhere
  store.markAttention(HERE)
  assert.equal(store.paneDemand(HERE), 'notice')

  focused = true // now you are back, and you type
  store.settleAttended()
  assert.equal(store.paneDemand(HERE), 'none')
})

console.log('The panes you are not in')

await check('a notice elsewhere in the same workspace does latch', async () => {
  await reset()
  store.markAttention(SAME_WS)
  assert.equal(store.paneDemand(SAME_WS), 'notice')
  assert.equal(store.workspaceDemand('w1'), 'notice')
})

await check('a finished agent elsewhere raises a notice', async () => {
  await reset()
  store.setPaneAgent(AWAY, agent(AWAY, 'working'))
  assert.equal(store.paneDemand(AWAY), 'none', 'working is not a demand')
  store.setPaneAgent(AWAY, agent(AWAY, 'idle'))
  assert.equal(store.paneDemand(AWAY), 'notice', 'finishing is')
})

await check('a blocked agent elsewhere outranks a notice', async () => {
  await reset()
  store.markAttention(AWAY)
  store.setPaneAgent(AWAY, agent(AWAY, 'blocked'))
  assert.equal(store.paneDemand(AWAY), 'blocked')
  assert.equal(store.workspaceDemand('w2'), 'blocked')
})

await check('an unfocused window settles nothing', async () => {
  await reset()
  focused = false
  store.markAttention(HERE)
  assert.equal(store.paneDemand(HERE), 'notice', 'you are not actually there')
})

console.log('Folding upward')

await check('a tab takes the loudest of its panes', async () => {
  await reset()
  const tab = store.workspaces[1].tabs[0]
  store.markAttention(AWAY)
  assert.equal(store.tabDemand(tab), 'notice')
  store.setPaneAgent(AWAY, agent(AWAY, 'blocked'))
  assert.equal(store.tabDemand(tab), 'blocked')
})

await check('louder() ranks blocked over notice over none', async () => {
  assert.equal(louder('none', 'notice'), 'notice')
  assert.equal(louder('notice', 'blocked'), 'blocked')
  assert.equal(louder('blocked', 'notice'), 'blocked')
  assert.equal(louder('none', 'none'), 'none')
})

await check('a collapsed parent reports what is hidden under it', async () => {
  await reset()
  // w2 is not nested under w1 in this document, so the subtree of w1 is w1
  // alone — the fold must not invent a demand that is not there.
  store.setPaneAgent(AWAY, agent(AWAY, 'blocked'))
  assert.equal(store.workspaceDemand('w1', true), 'none')
  assert.equal(store.workspaceDemand('w2', true), 'blocked')
})

console.log('The two levels settle separately')

await check('visiting the workspace does not settle the pane that asked', async () => {
  await reset()
  // The question lands in the *other* tab of the workspace you are in, so the
  // workspace is settled by being here and the tab is not.
  store.setPaneAgent(SAME_WS, agent(SAME_WS, 'blocked'))
  const other = store.workspaces[0].tabs[1]

  assert.equal(store.tabDemand(other), 'blocked', 'the tab still wants you')
  assert.equal(
    store.workspaceDemand('w1'),
    'none',
    'the workspace is settled: you are already in it'
  )
})

await check('a second question re-arms a settled pane', async () => {
  await reset()
  focused = false
  store.setPaneAgent(AWAY, agent(AWAY, 'blocked'))
  assert.equal(store.paneDemand(AWAY), 'blocked')

  // Answered, and then asked again. The pane was seen once; the new question
  // has not been.
  store.setPaneAgent(AWAY, agent(AWAY, 'idle'))
  store.setPaneAgent(AWAY, agent(AWAY, 'blocked'))
  assert.equal(store.paneDemand(AWAY), 'blocked', 'a new question is unseen again')
})

console.log()
console.log(`${passed} checks passed`)
