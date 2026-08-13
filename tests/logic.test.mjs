// Behavioural checks for the new pure-logic modules. Bundled with esbuild so
// the real TypeScript runs, not a re-implementation of it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-logic-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    activityMonitor: 'src/main/activityMonitor.ts',
    agentState: 'src/main/agentState.ts',
    scrollback: 'src/main/scrollback.ts',
    claudeConfig: 'src/main/claudeConfig.ts',
    phantomExit: 'src/main/phantomExit.ts',
    controlSurface: 'src/main/controlSurface.ts',
    browserPane: 'src/renderer/browserPane.ts',
    // The zoom ladder moved here when every pane learned to use it.
    auxPane: 'src/renderer/auxPane.ts',
    platform: 'src/shared/platform.ts',
    orphans: 'src/main/orphans.ts',
    events: 'src/main/events.ts',
    vault: 'src/main/vault.ts',
    paneBuffer: 'src/renderer/paneBuffer.ts',
    programWheel: 'src/renderer/programWheel.ts',
    agentSessions: 'src/main/agentSessions.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})

const { ActivityMonitor } = await import(`file://${out}/activityMonitor.js`)
const { AgentStateRegistry, keyBytes, encodeKey } = await import(`file://${out}/agentState.js`)
const { RingBuffer, stripEscapes } = await import(`file://${out}/scrollback.js`)
const { isPhantomExit, classifyReapIdentity, mayReap } = await import(
  `file://${out}/phantomExit.js`
)
const { buildTree, flattenPanes } = await import(`file://${out}/controlSurface.js`)
const { normalise } = await import(`file://${out}/browserPane.js`)
const { stepZoom } = await import(`file://${out}/auxPane.js`)
const { withBinDir, ipcAddress, isPipeAddress, pathAncestors, parentDir, samePath, parseUserPath } =
  await import(`file://${out}/platform.js`)
const { isOrphan, selectOrphans, ORPHAN_GRACE_MS } = await import(`file://${out}/orphans.js`)
const { EventLog, parseCategories } = await import(`file://${out}/events.js`)
const { SessionVault } = await import(`file://${out}/vault.js`)
const { bufferWhileHidden, drainPending, clearPending } = await import(
  `file://${out}/paneBuffer.js`
)
const { wheelTicks } = await import(`file://${out}/programWheel.js`)
const { acceptSession, resumeCommand, RECORD_REFRESH_MS } = await import(
  `file://${out}/agentSessions.js`
)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------- ActivityMonitor
console.log('ActivityMonitor')
{
  const events = []
  const m = new ActivityMonitor(
    { onActive: (id) => events.push(`active:${id}`), onIdle: (id) => events.push(`idle:${id}`) },
    () => 1000
  )
  m.start('p1')

  check('below threshold is not active', () => {
    m.feed('p1', 500)
    assert.equal(events.length, 0)
    assert.equal(m.isActive('p1'), false)
  })

  check('crossing the threshold fires active once', () => {
    m.feed('p1', 1600)
    m.feed('p1', 100)
    m.feed('p1', 100)
    assert.deepEqual(events, ['active:p1'])
  })

  await sleep(1300)
  check('going quiet fires idle exactly once', () => {
    assert.deepEqual(events, ['active:p1', 'idle:p1'])
  })

  check('a trickle after idle does not re-fire', () => {
    m.feed('p1', 50)
    m.feed('p1', 50)
    assert.deepEqual(events, ['active:p1', 'idle:p1'])
  })

  check('a fresh burst re-arms the cycle', () => {
    m.feed('p1', 2500)
    assert.deepEqual(events, ['active:p1', 'idle:p1', 'active:p1'])
  })

  m.stop('p1')
}
{
  // The short-agent-reply case the throughput detector alone cannot see.
  const events = []
  const m = new ActivityMonitor(
    { onActive: (id) => events.push(`active:${id}`), onIdle: (id) => events.push(`idle:${id}`) },
    () => 1000
  )
  m.start('p2')
  m.beginTurn('p2')
  check('beginTurn makes a tiny reply count as a turn', () => {
    m.feed('p2', 6) // "Done.\n" — nowhere near 2 KB
    assert.deepEqual(events, ['active:p2'])
  })
  await sleep(1300)
  check('and that turn still resolves to idle', () => {
    assert.deepEqual(events, ['active:p2', 'idle:p2'])
  })
  m.stop('p2')
}

// -------------------------------------------------------- AgentStateRegistry
console.log('AgentStateRegistry')
{
  const seen = []
  const r = new AgentStateRegistry((s) => seen.push(s))

  check('never reported is unknown', () => {
    assert.equal(r.snapshot('a').state, 'unknown')
  })

  check('run refcount nests', () => {
    r.report('a', { runStart: true })
    r.report('a', { runStart: true })
    assert.equal(r.snapshot('a').state, 'working')
    r.report('a', { runEnd: true })
    assert.equal(r.snapshot('a').state, 'working', 'inner subagent must not clear the outer run')
    r.report('a', { runEnd: true })
    assert.equal(r.snapshot('a').state, 'idle')
  })

  check('replayed reports are dropped by seq', () => {
    r.report('a', { runStart: true, seq: 5 })
    assert.equal(r.snapshot('a').runDepth, 1)
    assert.equal(r.report('a', { runEnd: true, seq: 3 }), false)
    assert.equal(r.snapshot('a').runDepth, 1)
    r.report('a', { runEnd: true, seq: 6 })
    assert.equal(r.snapshot('a').runDepth, 0)
  })

  check('blocked beats a running turn', () => {
    r.report('b', { runStart: true })
    r.report('b', { blocked: 'permission: Bash' })
    const s = r.snapshot('b')
    assert.equal(s.state, 'blocked')
    assert.equal(s.blockedReason, 'permission: Bash')
  })

  check('unanswerable choices are rejected at report time', () => {
    assert.equal(
      r.report('c', { blocked: 'pick', choices: [{ id: 'x', label: 'X' }] }),
      false,
      'a choice with neither key nor text cannot be sent'
    )
    assert.equal(r.snapshot('c').state, 'unknown')
  })

  check('a mixed set keeps only the sendable choices', () => {
    r.report('d', {
      blocked: 'Run it?',
      choices: [
        { id: 'y', label: 'Yes', key: '1', isDefault: true },
        { id: 'bad', label: 'Nope' },
        { id: 'n', label: 'No', text: 'no\r' },
      ],
    })
    assert.deepEqual(
      r.snapshot('d').choices.map((c) => c.id),
      ['y', 'n']
    )
  })

  check('answering requires a blocked pane', () => {
    assert.equal(r.resolveAnswer('a', 'y'), null)
  })

  check('answering requires a declared choice', () => {
    assert.equal(r.resolveAnswer('d', 'not-declared'), null)
  })

  check('a declared choice resolves to the bytes it declared', () => {
    assert.equal(r.resolveAnswer('d', 'y').data, '1')
    assert.equal(r.resolveAnswer('d', 'n').data, 'no\r')
    assert.equal(r.resolveAnswer('d').data, '1', 'no id named picks the default')
  })

  check('answering does NOT clear blocked', () => {
    r.markAnswered('d')
    const s = r.snapshot('d')
    assert.equal(s.state, 'blocked', 'only the agent may declare itself unblocked')
    assert.ok(s.answeredAt)
  })

  check('the agent clearing it is what unblocks', () => {
    r.report('d', { unblocked: true })
    assert.equal(r.snapshot('d').state, 'idle')
    assert.deepEqual(r.snapshot('d').choices, [])
  })

  check('metadata expires', async () => {
    r.report('e', { model: 'opus', ttl: 30 })
    assert.equal(r.snapshot('e').model, 'opus')
  })

  check('release returns the pane to unknown', () => {
    r.release('e')
    assert.equal(r.snapshot('e').state, 'unknown')
  })

  check('the key vocabulary is closed', () => {
    assert.equal(keyBytes('enter'), '\r')
    assert.equal(keyBytes('3'), '3')
    assert.equal(keyBytes('ctrl+c'), '\x03')
    assert.equal(keyBytes('rm -rf /'), null)
    assert.equal(keyBytes('F13'), null)
  })
}
{
  const r = new AgentStateRegistry(() => {})
  r.report('t', { model: 'opus', ttl: 30 })
  await sleep(60)
  check('stale metadata is not shown', () => {
    assert.equal(r.snapshot('t').model, undefined)
  })
}

// ----------------------------------------------------------------- RingBuffer
console.log('RingBuffer')
{
  check('reads back in order before wrapping', () => {
    const ring = new RingBuffer(64)
    ring.write(Buffer.from('hello '))
    ring.write(Buffer.from('world'))
    assert.equal(ring.readAll().toString(), 'hello world')
  })

  check('keeps the newest bytes after wrapping', () => {
    const ring = new RingBuffer(8)
    ring.write(Buffer.from('abcdefghij'))
    assert.equal(ring.readAll().toString(), 'cdefghij')
  })

  check('wraps across several writes', () => {
    const ring = new RingBuffer(8)
    for (const c of 'abcdefghijkl') ring.write(Buffer.from(c))
    assert.equal(ring.readAll().toString(), 'efghijkl')
  })

  check('grows instead of reserving the ceiling up front', () => {
    const ring = new RingBuffer(1024 * 1024)
    ring.write(Buffer.from('x'.repeat(10)))
    assert.equal(ring.readAll().toString(), 'x'.repeat(10))
    ring.write(Buffer.from('y'.repeat(200_000)))
    const all = ring.readAll().toString()
    assert.equal(all.length, 200_010)
    assert.ok(all.startsWith('xxxxxxxxxx'))
  })
}

// ---------------------------------------------------------------- phantom exit
console.log('Phantom exit')
{
  const alive = () => true
  const dead = () => false

  check('a code-less, signal-less exit with a live pid is a phantom', () => {
    assert.equal(isPhantomExit(null, undefined, 4242, alive), true)
    assert.equal(isPhantomExit(undefined, null, 4242, alive), true)
  })

  check('an exit that reports a code is real, even code 0', () => {
    assert.equal(isPhantomExit(0, undefined, 4242, alive), false)
    assert.equal(isPhantomExit(1, undefined, 4242, alive), false)
  })

  check('a signalled death is real — the signal is what killed it', () => {
    assert.equal(isPhantomExit(null, 9, 4242, alive), false)
  })

  check('a code-less exit whose pid is gone is just an exit', () => {
    assert.equal(isPhantomExit(null, undefined, 4242, dead), false)
  })

  check('no usable pid means no claim either way', () => {
    assert.equal(isPhantomExit(null, undefined, undefined, alive), false)
    assert.equal(isPhantomExit(null, undefined, 0, alive), false)
    assert.equal(isPhantomExit(null, undefined, -1, alive), false)
  })

  check('a start time close to ours is proof enough to reap', () => {
    const identity = classifyReapIdentity({
      spawnedAt: 1_000_000,
      currentStartTime: 1_000_400,
      looksLikeOurShell: true,
    })
    assert.equal(identity, 'start-time')
    assert.equal(mayReap(identity), true)
  })

  check('a start time that disagrees is a recycled pid — never reap', () => {
    const identity = classifyReapIdentity({
      spawnedAt: 1_000_000,
      currentStartTime: 9_000_000,
      // A fresh powershell.exe wearing our old number still looks like ours,
      // which is exactly why the clock has to win over the image name.
      looksLikeOurShell: true,
    })
    assert.equal(identity, 'unconfirmed')
    assert.equal(mayReap(identity), false)
  })

  check('an unreadable start time falls back to the image name', () => {
    assert.equal(
      classifyReapIdentity({ spawnedAt: 1, currentStartTime: null, looksLikeOurShell: true }),
      'heuristic'
    )
    assert.equal(
      classifyReapIdentity({ spawnedAt: 1, currentStartTime: null, looksLikeOurShell: false }),
      'unconfirmed'
    )
  })
}

// ------------------------------------------------------------------ ask waiter
console.log('Ask waiter')
{
  const choices = [
    { id: 'yes', label: 'Yes', key: 'y' },
    { id: 'no', label: 'No', key: 'n', isDefault: true },
  ]
  const waiterFor = (settled) => ({ requestId: 'r1', settle: (c) => settled.push(c) })

  check('an ask blocks the pane and shows its choices', () => {
    const r = new AgentStateRegistry(() => {})
    assert.equal(r.ask('p', 'Run it?', choices, waiterFor([])), true)
    const state = r.snapshot('p')
    assert.equal(state.state, 'blocked')
    assert.equal(state.blockedReason, 'Run it?')
    assert.equal(state.choices.length, 2)
  })

  check('an ask with nothing answerable is refused', () => {
    const r = new AgentStateRegistry(() => {})
    assert.equal(r.ask('p', 'Run it?', [{ id: 'x', label: 'X' }], waiterFor([])), false)
    assert.equal(r.snapshot('p').state, 'unknown')
  })

  check('answering settles the waiter and clears blocked', () => {
    const settled = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'Run it?', choices, waiterFor(settled))
    const delivered = r.deliverAnswer('p', 'yes')
    assert.equal(delivered.id, 'yes')
    assert.deepEqual(settled.map((c) => c.id), ['yes'])
    // Unlike the typed relay, this one knows the answer arrived.
    assert.equal(r.snapshot('p').state, 'idle')
    assert.equal(r.snapshot('p').choices.length, 0)
  })

  check('no choice named picks the default', () => {
    const settled = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'Run it?', choices, waiterFor(settled))
    assert.equal(r.deliverAnswer('p').id, 'no')
  })

  check('a pane with no waiter falls through to the typed relay', () => {
    const r = new AgentStateRegistry(() => {})
    r.report('p', { blocked: 'Run it?', choices })
    assert.equal(r.deliverAnswer('p', 'yes'), null)
    assert.equal(r.resolveAnswer('p', 'yes').data, 'y')
  })

  check('abandoning settles the waiter with nothing and unblocks', () => {
    const settled = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'Run it?', choices, waiterFor(settled))
    r.abandonAsk('p', 'r1')
    assert.deepEqual(settled.map((c) => c.id), [''])
    assert.equal(r.snapshot('p').state, 'idle')
  })

  check('a stale timeout cannot clear a newer question', () => {
    const first = []
    const second = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'One?', choices, { requestId: 'r1', settle: (c) => first.push(c) })
    r.ask('p', 'Two?', choices, { requestId: 'r2', settle: (c) => second.push(c) })
    // Replacing the first ask owes its caller an answer.
    assert.deepEqual(first.map((c) => c.id), [''])
    r.abandonAsk('p', 'r1')
    assert.equal(r.snapshot('p').blockedReason, 'Two?')
    assert.equal(second.length, 0)
  })

  check('closing the pane settles anything parked on it', () => {
    const settled = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'Run it?', choices, waiterFor(settled))
    r.release('p')
    assert.deepEqual(settled.map((c) => c.id), [''])
  })

  check('an agent that says it is unblocked settles its own ask', () => {
    const settled = []
    const r = new AgentStateRegistry(() => {})
    r.ask('p', 'Run it?', choices, waiterFor(settled))
    r.report('p', { unblocked: true })
    assert.deepEqual(settled.map((c) => c.id), [''])
    assert.equal(r.snapshot('p').state, 'idle')
  })
}

// -------------------------------------------------------------------- send-key
console.log('Key encoding')
{
  check('ctrl on a letter is the classic subtraction', () => {
    assert.equal(encodeKey('c', { ctrl: true }), '\x03')
    assert.equal(encodeKey('d', { ctrl: true }), '\x04')
  })

  check('alt is an escape prefix', () => {
    assert.equal(encodeKey('b', { alt: true }), '\x1bb')
  })

  check('shift capitalises a letter and leaves the rest alone', () => {
    assert.equal(encodeKey('a', { shift: true }), 'A')
    assert.equal(encodeKey('enter', { shift: true }), '\r')
  })

  check('named keys still resolve, and unknown ones do not', () => {
    assert.equal(encodeKey('enter', {}), '\r')
    assert.equal(encodeKey('up', {}), '\x1b[A')
    assert.equal(encodeKey('f13', {}), null)
    assert.equal(keyBytes('f13'), null)
  })
}

// -------------------------------------------------------------- escape strippi
console.log('Escape stripping')
{
  check('colour and cursor sequences go, the text stays', () => {
    assert.equal(stripEscapes('\x1b[31mred\x1b[0m'), 'red')
    assert.equal(stripEscapes('a\x1b[2Kb'), 'ab')
  })

  check('an OSC title report goes, however it is terminated', () => {
    assert.equal(stripEscapes('\x1b]0;a title\x07text'), 'text')
    assert.equal(stripEscapes('\x1b]7;file://x\x1b\\text'), 'text')
  })

  check('carriage returns go so lines split cleanly', () => {
    assert.deepEqual(stripEscapes('one\r\ntwo\r\n').split('\n'), ['one', 'two', ''])
  })

  check('newlines and tabs survive; other control bytes do not', () => {
    assert.equal(stripEscapes('a\tb\nc\x00\x07d'), 'a\tb\ncd')
  })
}

// --------------------------------------------------------------- control tree
console.log('Control surface')
{
  const state = {
    activeWorkspaceId: 'w1',
    workspaces: [
      {
        id: 'w1',
        name: 'api',
        cwd: 'C:\\api',
        branch: 'main',
        activeTabId: 't1',
        tabs: [
          {
            id: 't1',
            customTitle: null,
            activePaneId: 'p2',
            panes: [
              { id: 'p1', cwd: 'C:\\api', autoTitle: 'pwsh', shell: 'powershell' },
              { id: 'p2', kind: 'diff', cwd: 'C:\\api', customTitle: 'Changes', shell: 'powershell' },
            ],
          },
        ],
      },
      { id: 'w2', name: 'web', parentId: 'w1', cwd: 'C:\\web', tabs: [] },
    ],
  }

  check('the document projects to workspaces, tabs and panes', () => {
    const tree = buildTree(state, (id) => id === 'p1')
    assert.equal(tree.workspaces.length, 2)
    assert.equal(tree.workspaces[0].active, true)
    assert.equal(tree.workspaces[1].parentId, 'w1')
    assert.equal(tree.workspaces[0].tabs[0].panes[0].live, true)
    assert.equal(tree.workspaces[0].tabs[0].panes[1].live, false)
  })

  check('a pane with no kind is a terminal', () => {
    const tree = buildTree(state, () => false)
    assert.equal(tree.workspaces[0].tabs[0].panes[0].kind, 'terminal')
    assert.equal(tree.workspaces[0].tabs[0].panes[1].kind, 'diff')
  })

  check('an unnamed tab is shown by its active pane', () => {
    const tree = buildTree(state, () => false)
    assert.equal(tree.workspaces[0].tabs[0].title, 'Changes')
  })

  check('flattening gives every pane once', () => {
    assert.deepEqual(
      flattenPanes(buildTree(state, () => false)).map((p) => p.id),
      ['p1', 'p2']
    )
  })

  check('a shape we do not recognise is empty, not an error', () => {
    assert.deepEqual(buildTree(null, () => false).workspaces, [])
    assert.deepEqual(buildTree('nonsense', () => false).workspaces, [])
    assert.deepEqual(buildTree({ workspaces: 'no' }, () => false).workspaces, [])
    assert.deepEqual(buildTree({ workspaces: [{ noId: true }] }, () => false).workspaces, [])
  })
}

// ------------------------------------------------------------ browser address
console.log('Browser address bar')
{
  check('a bare host:port is an address, not a scheme', () => {
    assert.equal(normalise('localhost:5173'), 'http://localhost:5173')
    assert.equal(normalise('127.0.0.1:8080/app'), 'http://127.0.0.1:8080/app')
  })

  check('a bare host gets http', () => {
    assert.equal(normalise('example.com'), 'http://example.com')
    assert.equal(normalise('localhost'), 'http://localhost')
  })

  check('a real URL is left alone', () => {
    assert.equal(normalise('https://example.com/a?b=c'), 'https://example.com/a?b=c')
    assert.equal(normalise('  http://x.dev  '), 'http://x.dev')
  })

  check('file:, data: and javascript: are refused', () => {
    assert.equal(normalise('file:///C:/Windows/win.ini'), '')
    assert.equal(normalise('data:text/html,<script>alert(1)</script>'), '')
    assert.equal(normalise('javascript:alert(1)'), '')
  })

  check('a search phrase is refused rather than guessed at', () => {
    // Turning this into a query would hand what was typed to a search engine.
    assert.equal(normalise('how do i exit vim'), '')
    assert.equal(normalise(''), '')
  })
}

// ----------------------------------------------------------------- page zoom
console.log('Browser zoom steps')
{
  check('stepping lands on the stops a browser has', () => {
    assert.equal(stepZoom(1, 'in'), 1.1)
    assert.equal(stepZoom(1.1, 'in'), 1.25)
    assert.equal(stepZoom(1, 'out'), 0.9)
  })

  check('it comes back to exactly 100%', () => {
    // The whole reason for discrete stops: a multiplier never returns to 1.
    assert.equal(stepZoom(stepZoom(1, 'in'), 'out'), 1)
    assert.equal(stepZoom(stepZoom(1, 'out'), 'in'), 1)
  })

  check('both ends clamp instead of running off', () => {
    assert.equal(stepZoom(5, 'in'), 5)
    assert.equal(stepZoom(0.25, 'out'), 0.25)
  })

  check('a factor between stops snaps to the nearest before stepping', () => {
    // Nothing writes one of these today, but a value restored from a future
    // build's document must not send the zoom to an extreme.
    // 1.13 is nearest 1.1, so it steps from there rather than from 1.25.
    assert.equal(stepZoom(1.13, 'in'), 1.25)
    assert.equal(stepZoom(1.13, 'out'), 1)
  })
}

// ------------------------------------------------------------- withBinDir
{
  // The regression these guard is not hypothetical: spreading `process.env`
  // and then setting `PATH` handed every Windows pane two PATH keys, which
  // took `iaw` off the PATH in PowerShell and broke every git command that
  // shells out. See `withBinDir`'s comment.
  check('windows keeps the OS spelling and emits exactly one PATH', () => {
    const env = withBinDir({ Path: 'C:\\one;C:\\two', WINDIR: 'C:\\WINDOWS' }, 'C:\\bin', 'windows')
    const keys = Object.keys(env).filter((k) => /^path$/i.test(k))
    assert.deepEqual(keys, ['Path'])
    assert.equal(env.Path, 'C:\\bin;C:\\one;C:\\two')
    assert.equal(env.WINDIR, 'C:\\WINDOWS')
  })

  check('a block that already carries both cases collapses to one', () => {
    // Belt and braces: whatever upstream hands us, the child gets one.
    const env = withBinDir({ Path: 'C:\\a', PATH: 'C:\\b' }, 'C:\\bin', 'windows')
    assert.equal(Object.keys(env).filter((k) => /^path$/i.test(k)).length, 1)
  })

  check('posix uses a colon and the posix spelling', () => {
    const env = withBinDir({ PATH: '/usr/bin:/bin' }, '/home/u/.bin', 'linux')
    assert.deepEqual(Object.keys(env).filter((k) => /^path$/i.test(k)), ['PATH'])
    assert.equal(env.PATH, '/home/u/.bin:/usr/bin:/bin')
  })

  check('no bin directory leaves the value untouched', () => {
    assert.equal(withBinDir({ PATH: '/usr/bin' }, null, 'linux').PATH, '/usr/bin')
  })

  check('a missing PATH still yields one, not undefined', () => {
    const env = withBinDir({ HOME: '/home/u' }, '/home/u/.bin', 'macos')
    assert.equal(env.PATH, '/home/u/.bin:')
  })

  check('undefined entries are dropped rather than stringified', () => {
    // `process.env` reads back undefined for a variable that is not set, and
    // 'undefined' is a plausible-looking directory name.
    const env = withBinDir({ PATH: '/bin', NOPE: undefined }, null, 'linux')
    assert.equal('NOPE' in env, false)
  })
}

// ------------------------------------------------------------- ipcAddress
{
  check('windows gets a named pipe, posix a socket file', () => {
    const dirs = { runtime: '/run/user/1000/ia_workspaces', tmp: '/tmp' }
    assert.equal(ipcAddress('windows', 'ptyhost', dirs), '\\\\.\\pipe\\iaw-ptyhost')
    assert.equal(ipcAddress('linux', 'ptyhost', dirs), '/run/user/1000/ia_workspaces/ptyhost.sock')
  })

  check('an over-long socket path falls back to the temp directory', () => {
    // sun_path is 104 bytes on macOS; a deep home must not silently truncate.
    const deep = `/Users/${'x'.repeat(90)}/Library/Application Support/ia_workspaces`
    const addr = ipcAddress('macos', 'ptyhost', { runtime: deep, tmp: '/tmp' })
    assert.equal(addr, '/tmp/iaw-ptyhost.sock')
  })

  check('pipe addresses are recognised, socket paths are not', () => {
    assert.equal(isPipeAddress('\\\\.\\pipe\\iaw-ptyhost'), true)
    assert.equal(isPipeAddress('/run/user/1000/ia_workspaces/ptyhost.sock'), false)
  })
}

// ------------------------------------------------------------- tree paths
{
  check('crumbs keep the root they need to still be paths', () => {
    assert.deepEqual(
      pathAncestors('macos', '/Users/me/dev').map((c) => c.path),
      ['/Users', '/Users/me', '/Users/me/dev']
    )
    // A bare drive letter is not a directory; `C:\` is.
    assert.deepEqual(
      pathAncestors('windows', 'C:\\Users\\me').map((c) => c.path),
      ['C:\\', 'C:\\Users', 'C:\\Users\\me']
    )
  })

  check('going up stops at the root instead of walking past it', () => {
    assert.equal(parentDir('macos', '/Users/me/dev'), '/Users/me')
    assert.equal(parentDir('macos', '/Users'), '/')
    assert.equal(parentDir('macos', '/'), '/')
    assert.equal(parentDir('windows', 'C:\\Users\\me'), 'C:\\Users')
    assert.equal(parentDir('windows', 'C:\\Users'), 'C:\\')
    assert.equal(parentDir('windows', 'C:\\'), 'C:\\')
  })

  check('path equality follows the filesystem, not the app', () => {
    assert.equal(samePath('macos', '/Users/Me/', '/users/me'), true)
    assert.equal(samePath('linux', '/home/Me', '/home/me'), false)
    assert.equal(samePath('windows', 'C:\\Dev\\', 'c:\\dev'), true)
  })

  check('a pasted path survives being pasted', () => {
    // The bug: a POSIX path copied out of one file tree came back as
    // `\Users\me\dev` in the next one, and the tree said "No such folder".
    assert.equal(parseUserPath('macos', '/Users/me/dev'), '/Users/me/dev')
    assert.equal(parseUserPath('macos', '  "/Users/me/my code"  '), '/Users/me/my code')
    assert.equal(parseUserPath('windows', 'C:/Users/me'), 'C:\\Users\\me')
  })

  check('~ expands, and only where it is a home directory', () => {
    assert.equal(parseUserPath('macos', '~/dev', '/Users/me'), '/Users/me/dev')
    assert.equal(parseUserPath('macos', '~', '/Users/me'), '/Users/me')
    // Somebody else's home on POSIX, and an ordinary folder name anywhere.
    assert.equal(parseUserPath('macos', '~root/bin', '/Users/me'), '~root/bin')
    // No home known: left alone rather than mangled into a relative path.
    assert.equal(parseUserPath('macos', '~/dev'), '~/dev')
  })
}

// ---------------------------------------------------------- wheel to a program
{
  // A 15px cell, which is what 13px type at line-height 1 measures.
  const CELL = 15
  const ROWS = 24
  const px = (deltaY) => ({ deltaY, deltaMode: 0 })

  check('a Mac wheel notch reaches the program as three lines, not one', () => {
    // The bug: xterm sends exactly one report per wheel event however far the
    // wheel turned, and on macOS a notch is ~40px where Windows sends 100. So
    // Claude Code moved a line where Terminal.app and iTerm2 move three.
    assert.equal(wheelTicks(px(40), CELL, ROWS, 0).ticks, 3)
    assert.equal(wheelTicks(px(-40), CELL, ROWS, 0).ticks, -3)
  })

  check('a notch covers the ground the pane itself would have covered', () => {
    // 100px of wheel scrolls the pane's own scrollback 125px, which is 8 lines
    // of a 15px cell. The program gets the same 8.
    assert.equal(wheelTicks(px(100), CELL, ROWS, 0).ticks, 8)
  })

  check('a trackpad accumulates instead of rounding away to nothing', () => {
    // Half a line each. Two of them are a line; on its own, one is nothing yet.
    const first = wheelTicks(px(6), CELL, ROWS, 0)
    assert.equal(first.ticks, 0)
    assert.equal(wheelTicks(px(6), CELL, ROWS, first.carry).ticks, 1)
  })

  check('the carry does not survive a change of direction as a jump', () => {
    const down = wheelTicks(px(6), CELL, ROWS, 0)
    assert.equal(wheelTicks(px(-6), CELL, ROWS, down.carry).ticks, 0)
  })

  check('a stuck device cannot fire a thousand lines at a program', () => {
    // A screen at a time is the ceiling, so a real page-mode wheel still gets
    // its whole page and nothing gets a hundred of them.
    assert.equal(wheelTicks(px(100_000), CELL, ROWS, 0).ticks, ROWS)
    assert.equal(wheelTicks(px(-100_000), CELL, ROWS, 0).ticks, -ROWS)
  })

  check('line and page deltas are read in their own units', () => {
    // Firefox reports lines; nothing Chromium does reports pages, but the
    // conversion is one line each way and cheaper than being wrong.
    assert.equal(wheelTicks({ deltaY: 3, deltaMode: 1 }, CELL, ROWS, 0).ticks, 3)
    assert.equal(wheelTicks({ deltaY: 1, deltaMode: 2 }, CELL, ROWS, 0).ticks, ROWS)
  })
}

// --------------------------------------------------------------- orphans
{
  // The only judgement in the app that ends a process the user did not ask to
  // end, so every one of these is a case where it must NOT fire.
  const NOW = 1_000_000_000
  const old = NOW - ORPHAN_GRACE_MS - 1
  const session = (over) => ({ id: 'p1', attached: 0, startedAt: old, ...over })

  check('an unreferenced, unattached, old session is an orphan', () => {
    assert.equal(isOrphan(session(), new Set(['other']), NOW), true)
  })

  check('a referenced pane is never an orphan', () => {
    // Referenced by ANY workspace, not just the open one — a closed workspace
    // can be reopened and must find its shells.
    assert.equal(isOrphan(session(), new Set(['p1']), NOW), false)
  })

  check('a session another instance is attached to is never an orphan', () => {
    assert.equal(isOrphan(session({ attached: 1 }), new Set(['other']), NOW), false)
  })

  check('a session younger than the grace period is never an orphan', () => {
    // The pane exists; the document just has not caught up yet.
    assert.equal(isOrphan(session({ startedAt: NOW - 1000 }), new Set(['other']), NOW), false)
  })

  check('the boundary of the grace period is not an orphan', () => {
    assert.equal(isOrphan(session({ startedAt: NOW - ORPHAN_GRACE_MS }), new Set(['x']), NOW), false)
  })

  check('an empty live set reaps nothing at all', () => {
    // A workspace document that failed to load is indistinguishable from a
    // fresh install, and acting on it would kill every shell the user has.
    assert.deepEqual(selectOrphans([session(), session({ id: 'p2' })], new Set(), NOW), [])
  })

  check('a sweep picks out only the abandoned ones', () => {
    const sessions = [
      session({ id: 'referenced' }),
      session({ id: 'attached-elsewhere', attached: 2 }),
      session({ id: 'just-created', startedAt: NOW - 5 }),
      session({ id: 'abandoned' }),
    ]
    const live = new Set(['referenced', 'some-other-pane'])
    assert.deepEqual(
      selectOrphans(sessions, live, NOW).map((s) => s.id),
      ['abandoned']
    )
  })
}

// ------------------------------------------------------------- event log
console.log('Event log')
{
  check('events are numbered from one and come back in order', () => {
    const log = new EventLog()
    log.emit('pane', 'exit', { paneId: 'p1' })
    log.emit('agent', 'blocked', { paneId: 'p2' })
    const page = log.since(0)
    assert.deepEqual(page.events.map((e) => e.seq), [1, 2])
    assert.deepEqual(page.events.map((e) => e.type), ['exit', 'blocked'])
    assert.equal(page.cursor, 2)
    assert.equal(page.gap, false)
  })

  check('a cursor returns only what came after it', () => {
    const log = new EventLog()
    log.emit('pane', 'a')
    log.emit('pane', 'b')
    log.emit('pane', 'c')
    assert.deepEqual(log.since(2).events.map((e) => e.type), ['c'])
  })

  check('a caught-up reader gets an empty page, not a gap', () => {
    const log = new EventLog()
    log.emit('pane', 'a')
    const page = log.since(1)
    assert.deepEqual(page.events, [])
    assert.equal(page.gap, false)
  })

  check('a cursor from another boot is a gap, not silence', () => {
    // The failure this prevents: a reader holding seq 900 across a restart
    // being told "nothing new" by a log that has only reached 2 — forever.
    const log = new EventLog()
    log.emit('pane', 'a')
    log.emit('pane', 'b')
    const page = log.since(900, { boot: 'a-previous-run' })
    assert.equal(page.gap, true)
    assert.equal(page.events.length, 2, 'and it is given everything still held')
    assert.notEqual(page.boot, 'a-previous-run')
  })

  check('the matching boot is not a gap', () => {
    const log = new EventLog()
    log.emit('pane', 'a')
    assert.equal(log.since(0, { boot: log.boot }).gap, false)
  })

  check('categories filter without renumbering', () => {
    const log = new EventLog()
    log.emit('pane', 'exit')
    log.emit('agent', 'blocked')
    log.emit('alert', 'bell')
    const page = log.since(0, { categories: ['agent', 'alert'] })
    assert.deepEqual(page.events.map((e) => e.seq), [2, 3])
    assert.equal(page.cursor, 3, 'the cursor tracks the log, not the filtered view')
  })

  check('a limit keeps the newest, not the oldest', () => {
    const log = new EventLog()
    for (let i = 0; i < 10; i++) log.emit('pane', `e${i}`)
    const page = log.since(0, { limit: 3 })
    assert.deepEqual(page.events.map((e) => e.type), ['e7', 'e8', 'e9'])
  })

  check('unknown categories are dropped rather than matching nothing', () => {
    assert.deepEqual(parseCategories('agent,nonsense,alert'), ['agent', 'alert'])
    assert.equal(parseCategories('nonsense'), undefined)
    assert.equal(parseCategories(''), undefined)
    assert.equal(parseCategories(undefined), undefined)
  })

  await (async () => {
    const log = new EventLog()
    log.emit('pane', 'already here')
    const t0 = Date.now()
    await log.wait(0, 5000, () => {})
    passed++
    console.log('  ok', 'waiting returns at once when something is already newer')
    assert.ok(Date.now() - t0 < 200)
  })()

  await (async () => {
    const log = new EventLog()
    const waited = log.wait(0, 5000, () => {})
    setTimeout(() => log.emit('agent', 'blocked'), 40)
    await waited
    passed++
    console.log('  ok', 'waiting wakes when an event arrives')
    assert.equal(log.lastSeq, 1)
  })()

  await (async () => {
    const log = new EventLog()
    const t0 = Date.now()
    // The deadline timer is unref'd on purpose — in the app a follower's own
    // socket is what keeps the loop alive, and a pending poll should never be
    // the reason the process cannot exit. Here there is no socket, so the test
    // supplies the reference itself.
    const keepAlive = setTimeout(() => {}, 5000)
    await log.wait(0, 60, () => {})
    clearTimeout(keepAlive)
    passed++
    console.log('  ok', 'waiting gives up at its deadline')
    assert.ok(Date.now() - t0 >= 50)
  })()

  await (async () => {
    // A caller that hangs up must not leave a waiter holding the connection
    // until its deadline.
    const log = new EventLog()
    let abort = () => {}
    const waited = log.wait(0, 60_000, (fn) => (abort = fn))
    abort()
    await waited
    passed++
    console.log('  ok', 'a caller hanging up releases the waiter')
  })()
}

// ------------------------------------------------------------ session vault
console.log('Session vault')
{
  const dir = path.join(out, 'vault')
  const vault = new SessionVault(dir)
  const meta = { label: 'npm run build', cwd: 'C:\proj', workspace: 'w1' }

  check('a substantial transcript is written', () => {
    const file = vault.archive('x'.repeat(500), meta)
    assert.ok(file, 'a path comes back')
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /^# npm run build/, 'the label is the first line')
    assert.match(text, /# folder:\s+C:\proj/)
    assert.ok(text.includes('x'.repeat(500)), 'and the body survives intact')
  })

  check('a trivial one is not', () => {
    // A pane opened and closed by accident should not leave a file behind.
    assert.equal(vault.archive('hi', meta), null)
    assert.equal(vault.archive('', meta), null)
  })

  check('listing reads the label back out of the file', () => {
    const entries = vault.list()
    assert.ok(entries.length >= 1)
    assert.equal(entries[0].label, 'npm run build')
    assert.ok(entries[0].bytes > 500)
  })

  check('a label that is a path does not become one', () => {
    // The label reaches a filename, and a pane titled with a path would
    // otherwise try to write into directories that do not exist.
    const file = vault.archive('y'.repeat(400), {
      label: 'C:/rootCloud/dev/../x?*|',
      cwd: '',
      workspace: '',
    })
    assert.ok(file)
    assert.equal(path.dirname(file), dir, 'it stays in the vault folder')
    assert.equal(/[?*|]/.test(path.basename(file)), false)
  })

  check('an unwritable folder degrades rather than throwing', () => {
    // A read-only data directory should cost the feature, not the app.
    const nope = new SessionVault(path.join(out, 'vault', 'file-not-a-dir', 'deeper'))
    assert.doesNotThrow(() => nope.list())
  })
}

// ----------------------------------------------------------- hidden panes
{
  const buf = () => ({ pending: [], pendingBytes: 0, pendingTruncated: false })

  check('output is held rather than dropped', () => {
    const b = buf()
    bufferWhileHidden(b, 'one ')
    bufferWhileHidden(b, 'two')
    assert.deepEqual(drainPending(b), { text: 'one two', truncated: false })
  })

  check('draining empties the buffer', () => {
    const b = buf()
    bufferWhileHidden(b, 'x')
    drainPending(b)
    assert.deepEqual(drainPending(b), { text: '', truncated: false })
    assert.equal(b.pendingBytes, 0)
  })

  check('the cap drops the oldest and says so', () => {
    // The tail is what a revealed pane shows; the head is what nobody reads
    // first. So overflow costs the middle, and the pane admits it.
    const b = buf()
    for (const c of ['aaaa', 'bbbb', 'cccc']) bufferWhileHidden(b, c, 8)
    const out = drainPending(b)
    assert.equal(out.text, 'bbbbcccc')
    assert.equal(out.truncated, true)
  })

  check('a single chunk larger than the cap is kept, not discarded', () => {
    // Dropping it would leave a revealed pane blank rather than merely
    // trimmed, which is a worse answer than showing too much.
    const b = buf()
    bufferWhileHidden(b, 'x'.repeat(50), 8)
    assert.equal(drainPending(b).text.length, 50)
  })

  check('an empty write changes nothing', () => {
    const b = buf()
    bufferWhileHidden(b, '')
    assert.equal(b.pending.length, 0)
  })

  check('bytes are counted, not chunks', () => {
    const b = buf()
    bufferWhileHidden(b, 'abc')
    bufferWhileHidden(b, 'de')
    assert.equal(b.pendingBytes, 5)
  })

  check('clearing forgets a replaced shell output', () => {
    const b = buf()
    bufferWhileHidden(b, 'from the old shell', 4)
    clearPending(b)
    assert.deepEqual(drainPending(b), { text: '', truncated: false })
  })
}

// ------------------------------------------------------- agent conversations
{
  console.log('\nRecording an agent conversation')

  const NOW = 1_700_000_000_000
  const TRANSCRIPT = '/home/u/.claude/projects/-home-u-work/aaaaaaaa-bbbb-cccc.jsonl'
  // The transcript of a conversation that has had a turn; anything else has not
  // been written yet, which is what Claude Code does until the first turn ends.
  const onDisk = (p) => p === TRANSCRIPT
  const known = (over) => ({ tool: 'claude', id: 'old-session-id', at: NOW - 60_000, ...over })

  check('a pane with nothing recorded takes what it is given', () => {
    const rec = acceptSession(undefined, { id: 'new-id-9', transcript: '/nope' }, NOW, onDisk)
    assert.equal(rec.id, 'new-id-9')
    // Kept even though the file is not there yet: it is where the conversation
    // will be written, and resuming is what checks whether it was.
    assert.equal(rec.transcript, '/nope')
  })

  check('a startup id does not displace the conversation a pane was having', () => {
    const rec = acceptSession(
      known(),
      { id: 'fresh-id-1', transcript: '/nope', hookEvent: 'SessionStart' },
      NOW,
      onDisk
    )
    assert.equal(rec, null)
  })

  check('a conversation with a transcript on disk does displace it', () => {
    const rec = acceptSession(
      known(),
      { id: 'resumed-id', transcript: TRANSCRIPT, hookEvent: 'SessionStart' },
      NOW,
      onDisk
    )
    assert.equal(rec.id, 'resumed-id')
  })

  check('so does one the user has just submitted a prompt to', () => {
    const rec = acceptSession(
      known(),
      { id: 'second-conv', transcript: '/nope', hookEvent: 'UserPromptSubmit' },
      NOW,
      onDisk
    )
    assert.equal(rec.id, 'second-conv')
  })

  check('the same conversation re-reporting is not written through every time', () => {
    const rec = acceptSession(
      known({ id: 'same-id-1' }),
      { id: 'same-id-1', hookEvent: 'UserPromptSubmit' },
      NOW,
      onDisk
    )
    assert.equal(rec, null)
  })

  check('but it is written through often enough to keep its TTL fresh', () => {
    const at = NOW - RECORD_REFRESH_MS - 1
    const rec = acceptSession(known({ id: 'same-id-1', at }), { id: 'same-id-1' }, NOW, onDisk)
    assert.equal(rec.at, NOW)
  })

  console.log('\nResuming an agent conversation')

  check('a recorded conversation whose transcript is there is resumed', () => {
    const line = resumeCommand(known({ id: 'aaaaaaaa-bbbb', transcript: TRANSCRIPT }), NOW, onDisk)
    assert.equal(line, 'claude --resume aaaaaaaa-bbbb')
  })

  check('one whose transcript has gone is not — that is the error in the pane', () => {
    const line = resumeCommand(known({ id: 'aaaaaaaa-bbbb', transcript: '/gone' }), NOW, onDisk)
    assert.equal(line, null)
  })

  check('a record from before transcripts were carried is taken at its word', () => {
    const line = resumeCommand(known({ id: 'aaaaaaaa-bbbb' }), NOW, onDisk)
    assert.equal(line, 'claude --resume aaaaaaaa-bbbb')
  })

  check('a fortnight-old conversation is not reopened', () => {
    const at = NOW - 15 * 24 * 60 * 60 * 1000
    assert.equal(resumeCommand(known({ id: 'aaaaaaaa-bbbb', at }), NOW, onDisk), null)
  })

  check('an id that is not one Claude Code would issue never reaches a shell', () => {
    const id = 'x; rm -rf /'
    assert.equal(resumeCommand(known({ id, transcript: TRANSCRIPT }), NOW, onDisk), null)
  })

  check('a pane with no recorded conversation opens at a plain prompt', () => {
    assert.equal(resumeCommand(undefined, NOW, onDisk), null)
  })
}

console.log(`\n${passed} checks passed`)
