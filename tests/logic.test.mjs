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

console.log(`\n${passed} checks passed`)
