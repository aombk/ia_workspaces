// End-to-end checks for the control channel: the real CLI talking to the real
// server over a real pipe, with a handler wired the way main.ts wires it.
//
// The unit tests cover the decisions; this covers the plumbing between them,
// which is where `ask` lives. Nothing else in the app holds a connection open
// waiting for a human, so nothing else would have caught a deferred reply that
// never arrives, arrives twice, or arrives out of order.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-control-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    cli: 'src/main/cli.ts',
    controlServer: 'src/main/controlServer.ts',
    agentState: 'src/main/agentState.ts',
    controlSurface: 'src/main/controlSurface.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})

const { runCli } = await import(`file://${out}/cli.js`)
const { startControlServer } = await import(`file://${out}/controlServer.js`)
const { AgentStateRegistry } = await import(`file://${out}/agentState.js`)
const { buildTree, flattenPanes } = await import(`file://${out}/controlSurface.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------- fixtures

const PANE = 'pane-1'
const agents = new AgentStateRegistry(() => {})
const written = []
const state = {
  activeWorkspaceId: 'w1',
  workspaces: [
    {
      id: 'w1',
      name: 'api',
      cwd: 'C:\\api',
      activeTabId: 't1',
      tabs: [{ id: 't1', activePaneId: PANE, panes: [{ id: PANE, cwd: 'C:\\api', shell: 'powershell' }] }],
    },
  ],
}

// The same dispatch main.ts installs, minus the parts that need a live PTY.
const server = startControlServer('test', (req, ctx) => {
  switch (req.method) {
    case 'ping':
      return { ok: true }
    case 'ask':
      return new Promise((resolve) => {
        const requestId = `r${Date.now()}${Math.random()}`
        let settled = false
        const finish = (choice) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({
            ok: true,
            data: {
              choice: choice.id,
              label: choice.label,
              outcome: choice.id ? 'answered' : 'abandoned',
            },
          })
        }
        const timer = setTimeout(() => {
          agents.abandonAsk(PANE, requestId)
          finish({ id: '', label: '' })
        }, req.timeout ?? 120_000)
        ctx.onAbort(() => {
          agents.abandonAsk(PANE, requestId)
          finish({ id: '', label: '' })
        })
        const ok = agents.ask(req.paneId, req.question ?? '', req.choices ?? [], {
          requestId,
          settle: finish,
        })
        if (!ok) {
          clearTimeout(timer)
          settled = true
          resolve({ ok: false, error: 'no answerable choices' })
        }
      })
    case 'answer-agent': {
      const delivered = agents.deliverAnswer(req.paneId, req.choice)
      return delivered
        ? { ok: true, data: { label: delivered.label } }
        : { ok: false, error: 'pane is not waiting on a declared choice' }
    }
    case 'agent-state':
      return { ok: true, data: agents.agentStateFor?.(req.paneId) ?? agents.all() }
    case 'tree':
      return { ok: true, data: buildTree(state, () => true) }
    case 'list-panes': {
      const panes = flattenPanes(buildTree(state, () => true))
      return { ok: true, data: req.paneId ? panes.filter((p) => p.id === req.paneId) : panes }
    }
    case 'send':
      written.push(req.text ?? '')
      return { ok: true }
    case 'send-key':
      written.push(req.key ?? '')
      return { ok: true }
    case 'read-screen':
      return { ok: true, data: { text: 'line one\nline two' } }
  }
  return { ok: false, error: 'unknown method' }
})

// Wait for the listener; a named pipe binds asynchronously.
await sleep(150)

process.env.IAW_PANE_ID = PANE
process.env.IAW_WORKSPACE_ID = 'w1'
process.env.IAW_PIPE = server.address
process.env.IAW_TOKEN = server.token

// Output capture, attributed by async context rather than by swapping the
// stream around each call. Several of these tests run two CLI calls at once —
// that is the point of them — and a patch installed and torn down per call
// would hand one caller's output to the other, or drop it on the floor.
const capture = new AsyncLocalStorage()
const realWrite = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) }
process.stdout.write = (chunk, ...rest) => {
  const sink = capture.getStore()
  if (!sink) return realWrite.out(chunk, ...rest)
  sink.stdout.push(String(chunk))
  return true
}
process.stderr.write = (chunk, ...rest) => {
  const sink = capture.getStore()
  if (!sink) return realWrite.err(chunk, ...rest)
  sink.stderr.push(String(chunk))
  return true
}

/** Runs the CLI, returning its exit code and what it printed. */
function cli(...argv) {
  const sink = { stdout: [], stderr: [] }
  return capture.run(sink, async () => {
    const code = await runCli(argv, out)
    return { code, stdout: sink.stdout.join(''), stderr: sink.stderr.join('') }
  })
}

const CHOICES = JSON.stringify([
  { id: 'yes', label: 'Yes', key: 'y' },
  { id: 'no', label: 'No', key: 'n', isDefault: true },
])

// ---------------------------------------------------------------------- tests

console.log('Control channel')

await check('ping reaches the server', async () => {
  const res = await cli('ping')
  assert.equal(res.code, 0)
})

await check('an unauthorised caller is refused', async () => {
  const real = process.env.IAW_TOKEN
  process.env.IAW_TOKEN = 'not-the-token'
  const res = await cli('ping')
  process.env.IAW_TOKEN = real
  assert.equal(res.code, 1)
  assert.match(res.stderr, /unauthorized/)
})

console.log('ask')

await check('ask waits, then prints the choice a human picked', async () => {
  const pending = cli('ask', '--question', 'Run it?', '--choices', CHOICES)
  // The CLI has to have reached the server and blocked before the answer goes
  // in, or this would be testing a race rather than the wait.
  await sleep(250)
  assert.equal(agents.snapshot(PANE).state, 'blocked')

  const delivered = agents.deliverAnswer(PANE, 'yes')
  assert.equal(delivered.id, 'yes')

  const res = await pending
  assert.equal(res.code, 0)
  assert.equal(res.stdout.trim(), 'yes')
})

await check('the pane is unblocked once the answer is delivered', () => {
  assert.equal(agents.snapshot(PANE).state, 'idle')
})

await check('--json carries the label and the outcome', async () => {
  const pending = cli('ask', '--question', 'Run it?', '--choices', CHOICES, '--json')
  await sleep(250)
  agents.deliverAnswer(PANE, 'no')
  const res = await pending
  assert.equal(res.code, 0)
  assert.deepEqual(JSON.parse(res.stdout), { choice: 'no', label: 'No', outcome: 'answered' })
})

await check('nobody answering exits 2 with nothing on stdout', async () => {
  const res = await cli('ask', '--question', 'Run it?', '--choices', CHOICES, '--timeout', '0.4')
  assert.equal(res.code, 2)
  assert.equal(res.stdout, '')
  assert.match(res.stderr, /nobody answered/)
  // …and the pane is not left showing a question nobody is waiting on.
  assert.equal(agents.snapshot(PANE).state, 'idle')
})

await check('an ask with no answerable choice is refused outright', async () => {
  const res = await cli('ask', '--question', 'Run it?', '--choices', '[{"id":"x","label":"X"}]')
  assert.equal(res.code, 1)
  assert.match(res.stderr, /no answerable choices/)
})

await check('choices can come from a file, as a hook has to send them', async () => {
  const file = path.join(out, 'choices.json')
  fs.writeFileSync(file, CHOICES)
  const pending = cli('ask', '--question', 'Run it?', '--choices', `@${file}`)
  await sleep(250)
  agents.deliverAnswer(PANE, 'yes')
  assert.equal((await pending).stdout.trim(), 'yes')
})

await check('a second ask displaces the first, and the first still answers', async () => {
  const one = cli('ask', '--question', 'One?', '--choices', CHOICES)
  await sleep(250)
  const two = cli('ask', '--question', 'Two?', '--choices', CHOICES)
  await sleep(250)

  // The displaced caller is owed an answer even though it is not the one on
  // screen any more.
  const first = await one
  assert.equal(first.code, 2)

  assert.equal(agents.snapshot(PANE).blockedReason, 'Two?')
  agents.deliverAnswer(PANE, 'yes')
  assert.equal((await two).stdout.trim(), 'yes')
})

await check('a slow ask does not block another pane\'s call', async () => {
  const pending = cli('ask', '--question', 'Run it?', '--choices', CHOICES, '--timeout', '3')
  await sleep(250)
  // Same connection pool, different request: this must answer immediately
  // rather than queue behind the ask.
  const start = Date.now()
  assert.equal((await cli('ping')).code, 0)
  assert.ok(Date.now() - start < 1500, 'ping waited on the parked ask')

  agents.deliverAnswer(PANE, 'yes')
  await pending
})

console.log('looking around')

await check('tree returns the workspace document', async () => {
  const res = await cli('tree')
  assert.equal(res.code, 0)
  const tree = JSON.parse(res.stdout)
  assert.equal(tree.workspaces[0].name, 'api')
  assert.equal(tree.workspaces[0].tabs[0].panes[0].id, PANE)
})

await check('list-panes narrows to one pane when asked', async () => {
  const all = JSON.parse((await cli('list-panes')).stdout)
  assert.equal(all.length, 1)
  const one = JSON.parse((await cli('list-panes', '--pane', PANE)).stdout)
  assert.equal(one[0].id, PANE)
  const none = JSON.parse((await cli('list-panes', '--pane', 'nope')).stdout)
  assert.equal(none.length, 0)
})

await check('read-screen prints the text as text', async () => {
  const res = await cli('read-screen', '--lines', '50')
  assert.equal(res.code, 0)
  assert.equal(res.stdout, 'line one\nline two\n')
})

await check('send takes its text positionally, and --enter is opt-in', async () => {
  written.length = 0
  await cli('send', 'npm test')
  await cli('send', 'npm test', '--enter')
  assert.deepEqual(written, ['npm test', 'npm test\r'])
})

await check('send-key takes its key positionally', async () => {
  written.length = 0
  await cli('send-key', 'c', '--ctrl')
  assert.deepEqual(written, ['c'])
})

server.close()
console.log(`\n${passed} checks passed`)
