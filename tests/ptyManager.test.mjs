// PtyManager's lifecycle edges: what happens when a pane is closed, reopened or
// loses its shell at an awkward moment.
//
// The backend is faked — the broker has its own suite — because every bug here
// is about ordering on *this* side: a kill that lands while a spawn is still
// awaiting, a timer armed for one shell firing into its replacement, a shell
// that died taking its agent's "blocked" state nowhere. None of them is visible
// until somebody notices a shell they closed is still running.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-ptymanager-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { ptyManager: 'src/main/ptyManager.ts', types: 'src/shared/types.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron', '@xterm/headless', '@xterm/addon-serialize'],
  // No real pty is ever spawned here, and the native module cannot be loaded
  // from a bundle in the temp folder anyway.
  plugins: [
    {
      name: 'no-pty',
      setup(b) {
        b.onResolve({ filter: /^@lydell\/node-pty$/ }, () => ({ path: 'pty', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: "export function spawn() { throw new Error('no pty in tests') }",
        }))
      },
    },
  ],
  // The bundle is ESM but some of what it pulls in still says `require`.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
const { PtyManager } = await import(`file://${out}/ptyManager.js`)
const { DEFAULT_SETTINGS } = await import(`file://${out}/types.js`)

let passed = 0
const checkAsync = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms))

/** A backend whose spawn can be held open, recording everything it is asked. */
function fakeBackend() {
  const log = []
  const envs = {}
  let gate = null
  const backend = {
    kind: 'broker',
    log,
    envs,
    hold() {
      let release
      gate = new Promise((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
    async spawn(spec) {
      log.push(`spawn:${spec.id}`)
      envs[spec.id] = spec.env
      if (gate) await gate
      log.push(`spawned:${spec.id}`)
      return { ok: true, existing: false, pid: process.pid }
    },
    attach: async (id) => ({ id, alive: true, cursor: 0, truncated: false }),
    detach() {},
    write: (id, data) => log.push(`write:${id}:${data}`),
    resize() {},
    kill: (id) => log.push(`kill:${id}`),
    list: async () => [],
    ackExit() {},
    setMeta() {},
    release() {},
  }
  return backend
}

function manager() {
  const backend = fakeBackend()
  const settings = {
    ...DEFAULT_SETTINGS,
    keepSessionsAlive: true,
    notifications: { ...DEFAULT_SETTINGS.notifications, onExit: false, onIdle: false, onCommandFinished: false },
  }
  const statuses = []
  const mgr = new PtyManager(
    {
      onData() {},
      onExit() {},
      onMeta() {},
      onAlert() {},
      onStatus: (s) => statuses.push(s),
      onOutcome() {},
    },
    () => settings,
    {
      notifyPipe: () => '',
      historyDir: () => out,
      // One per pane, as the control server issues them.
      tokenFor: (paneId) => `${paneId}.test-signature`,
      binDir: null,
      scrollback: {
        read: () => null,
        setSize() {},
        consume() {},
        track() {},
        push() {},
        flush: async () => {},
        drop() {},
        peek: () => null,
      },
      pidMap: { register() {}, unregister() {} },
      vault: { archive() {} },
      execPath: process.execPath,
      hostScript: '',
    }
  )
  // The broker connection is the one seam that matters; handing it over
  // directly is what `host()` would have done after connecting.
  mgr.backend = backend
  return { mgr, backend, statuses }
}

const request = (paneId, extra = {}) => ({
  paneId,
  workspaceId: 'ws',
  cwd: os.tmpdir(),
  shell: process.platform === 'win32' ? 'cmd' : 'bash',
  cols: 80,
  rows: 24,
  ...extra,
})

const resumeSession = () => ({
  tool: 'claude',
  id: '5a60f12b-7389-4c1c-a1fc-51e74d18b584',
  at: Date.now(),
})

await checkAsync('a pane closed while its spawn is in flight does not leave a shell running', async () => {
  const { mgr, backend } = manager()
  const release = backend.hold()
  const spawning = mgr.spawn(request('p1'))
  await settle()
  assert.ok(backend.log.includes('spawn:p1'), 'the broker has been asked')

  mgr.kill('p1') // the user closes it before the broker answers
  release()
  const result = await spawning

  assert.equal(result.ok, false)
  assert.equal(mgr.has('p1'), false, 'no session was registered for a closed pane')
  const spawnedAt = backend.log.indexOf('spawned:p1')
  assert.ok(
    backend.log.slice(spawnedAt).includes('kill:p1'),
    `the shell is killed after it exists, not only before: ${backend.log.join(' ')}`
  )
})

await checkAsync('reopening right behind a kill waits for the old spawn, then gets its own shell', async () => {
  const { mgr, backend } = manager()
  const release = backend.hold()
  const first = mgr.spawn(request('p2'))
  await settle()
  mgr.kill('p2')
  const second = mgr.spawn(request('p2'))
  release()
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, true)
  assert.equal(mgr.has('p2'), true)
  const log = backend.log.join(' ')
  // The old shell's kill lands before the replacement is asked for, so the
  // broker cannot hand the new pane the shell that is being ended.
  assert.ok(
    backend.log.lastIndexOf('kill:p2') < backend.log.lastIndexOf('spawn:p2'),
    `old shell ended before the new spawn: ${log}`
  )
})

await checkAsync('two spawns of one live pane share one shell', async () => {
  const { mgr, backend } = manager()
  const release = backend.hold()
  const a = mgr.spawn(request('p3'))
  const b = mgr.spawn(request('p3'))
  release()
  assert.equal((await a).ok, true)
  assert.equal((await b).ok, true)
  assert.equal(backend.log.filter((e) => e === 'spawn:p3').length, 1)
})

await checkAsync('a resume line queued for a killed shell is never typed into its replacement', async () => {
  // "Reopen as": kill, then spawn a different shell under the same pane id.
  // The old session's fallback timer used to survive the kill and type
  // `claude --resume …` into whatever was running there 1.5s later.
  const { mgr, backend } = manager()
  assert.equal((await mgr.spawn(request('p4', { resumeSession: resumeSession() }))).ok, true)
  mgr.kill('p4')
  assert.equal((await mgr.spawn(request('p4'))).ok, true)
  await settle(1800)
  const typed = backend.log.filter((e) => e.startsWith('write:p4:'))
  assert.deepEqual(typed, [], `nothing typed: ${typed.join(' ')}`)
  mgr.kill('p4')
})

await checkAsync('a resume line still goes in when nothing interrupts it', async () => {
  // The control for the check above: the timer itself still works.
  const { mgr, backend } = manager()
  await mgr.spawn(request('p5', { resumeSession: resumeSession() }))
  await settle(1800)
  assert.ok(backend.log.some((e) => e.startsWith('write:p5:claude --resume ')))
  mgr.kill('p5')
})

await checkAsync('a shell that exits on its own takes its agent state with it', async () => {
  const { mgr } = manager()
  await mgr.spawn(request('p6'))
  assert.equal(mgr.reportAgent('p6', { blocked: 'Approve the edit?' }), true)
  assert.equal(mgr.agentState('p6')[0].state, 'blocked')

  const asked = mgr.askAgent({
    paneId: 'p6',
    question: 'Proceed?',
    choices: [{ id: 'yes', label: 'Yes', key: 'enter' }],
    timeoutMs: 60_000,
    onAbort() {},
  })
  await settle()

  mgr.handleExit('p6', { exitCode: 0 })
  assert.notEqual(mgr.agentState('p6')[0].state, 'blocked', 'a dead pane is not waiting for anyone')
  const answer = await asked
  assert.equal(answer.result.outcome, 'abandoned', 'the asker is let go now, not at its timeout')
})

await checkAsync('losing the host releases agent state for every detached pane', async () => {
  const { mgr } = manager()
  await mgr.spawn(request('p7'))
  mgr.reportAgent('p7', { blocked: 'Approve?' })
  mgr.handleHostLost()
  assert.notEqual(mgr.agentState('p7')[0].state, 'blocked')
})

await checkAsync("a pane does not inherit the app's launcher's agent session", async () => {
  // As it is when the app was relaunched from inside a Claude Code session.
  const inherited = {
    CLAUDECODE: '1',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'd0cda58c-2163-496a-a208-07f06a4b328c',
    CLAUDE_PID: '41315',
  }
  const own = { CLAUDE_CODE_USE_BEDROCK: '1' }
  const saved = { ...process.env }
  Object.assign(process.env, inherited, own)
  try {
    const { mgr, backend } = manager()
    await mgr.spawn(request('p8'))
    const env = backend.envs.p8
    for (const name of Object.keys(inherited)) assert.equal(env[name], undefined, `${name} is dropped`)
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1', "the user's own setting passes through")
    assert.equal(env.IAW_PANE_ID, 'p8', 'and the pane still gets its own identity')
  } finally {
    for (const name of [...Object.keys(inherited), ...Object.keys(own)]) {
      if (name in saved) process.env[name] = saved[name]
      else delete process.env[name]
    }
  }
})

console.log(`\n${passed} checks passed`)
