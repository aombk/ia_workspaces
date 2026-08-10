// End-to-end smoke test of the session broker against a REAL shell.
//
//   node tests/host.smoke.mjs
//
// Not named `*.test.mjs` on purpose: it starts a real PowerShell, takes about
// fifteen seconds, and is a check on the machine rather than on the logic. The
// unit suite in `host.test.mjs` covers the same paths with a fake pty and runs
// in milliseconds.
//
// What it proves is the one claim the whole subsystem exists to make: the
// client goes away, the shell keeps running, and a new client is handed both
// the output it missed and a still-interactive prompt.
import { createRequire } from 'node:module'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'package.json'))
const pty = require('@lydell/node-pty')

const tmp = path.join(os.tmpdir(), 'iaw-host-smoke')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })

await build({
  entryPoints: { protocol: 'src/host/protocol.ts', server: 'src/host/server.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: tmp,
  external: ['@lydell/node-pty'],
  absWorkingDir: root,
})
const Proto = await import(`file://${tmp}/protocol.js`)
const { startHostServer } = await import(`file://${tmp}/server.js`)

const posix = process.platform !== 'win32'
// A test-only address, so this can never collide with the broker the app uses.
const address = posix
  ? path.join(tmp, 'smoke.sock')
  : `\\\\.\\pipe\\iaw-smoke-${process.pid}`
const tokenPath = path.join(tmp, 'smoke.token')

const shell = posix
  ? { file: 'bash', args: ['--norc', '--noprofile'], cwd: os.homedir() }
  : { file: 'powershell.exe', args: ['-NoProfile', '-NoLogo'], cwd: root }

const server = startHostServer({
  address,
  tokenPath,
  idleCheckMs: 1_000_000,
  spawner: (spec) => {
    const p = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: spec.cols,
      rows: spec.rows,
      cwd: spec.cwd,
      env: spec.env,
    })
    return {
      get pid() { return p.pid },
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: () => p.kill(),
      onData: (cb) => p.onData(cb),
      onExit: (cb) => p.onExit(({ exitCode, signal }) => cb({ exitCode: exitCode ?? -1, signal })),
    }
  },
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(300)

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address)
    const waiters = new Map()
    let live = ''
    let backlog = ''
    let ref = 0
    const reader = new Proto.FrameReader((kind, payload) => {
      if (kind === Proto.FRAME_JSON) {
        const m = Proto.decodeJson(payload)
        const w = waiters.get(m.ref)
        if (w) { waiters.delete(m.ref); w(m) }
        return
      }
      const f = Proto.decodeData(payload)
      if (kind === Proto.FRAME_BACKLOG) backlog += f.data.toString()
      else live += f.data.toString()
    }, reject)
    socket.on('data', (c) => reader.push(c))
    socket.on('error', reject)
    socket.on('connect', () =>
      resolve({
        send: (m) =>
          new Promise((res) => {
            const r = ++ref
            waiters.set(r, res)
            socket.write(Proto.encodeJson({ ...m, ref: r }))
          }),
        type: (id, s) => socket.write(Proto.encodeData(Proto.FRAME_DATA, id, Buffer.from(s))),
        get live() { return live },
        get backlog() { return backlog },
        close: () => socket.destroy(),
      })
    )
  })
}

const token = () => fs.readFileSync(tokenPath, 'utf8').trim()
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
// The command echoes on the prompt line as well as producing output, so a
// marker is only proof of execution when it appears more than once.
const ran = (text, marker) => strip(text).split(marker).length > 2

let failures = 0
const expect = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : '\n        ' + detail}`)
  if (!ok) failures++
}
const say = (id, marker) => (posix ? `echo ${marker}\r` : `"${marker}"\r`)

console.log('Session broker, real shell\n')

// 1 — a real shell starts and answers.
const a = await connect()
await a.send({ t: 'hello', token: token(), protocol: Proto.PROTOCOL_VERSION })
const spawned = await a.send({
  t: 'spawn',
  id: 'smoke-1',
  file: shell.file,
  args: shell.args,
  cwd: shell.cwd,
  env: { ...process.env },
  cols: 100,
  rows: 30,
})
expect('spawn accepted', spawned.t === 'ok', JSON.stringify(spawned))
await a.send({ t: 'attach', id: 'smoke-1' })
await sleep(1800)

// Read the pid from `list` rather than from the spawn reply: ConPTY has not
// assigned one yet when spawn returns, and asserting on that 0 would compare
// two zeroes later and call it a match.
const settled = (await a.send({ t: 'list' })).data.find((s) => s.id === 'smoke-1')
const pid = settled?.pid ?? 0
expect('a real pid resolves once ConPTY has one', pid > 0, JSON.stringify(settled))

a.type('smoke-1', say('smoke-1', 'MARKER-ALPHA'))
await sleep(2500)
expect('the shell ran a command', ran(a.live, 'MARKER-ALPHA'), strip(a.live).slice(-200))

// 2 — the client vanishes, and output arrives with nobody listening at all.
a.close()
await sleep(400)
const b = await connect()
await b.send({ t: 'hello', token: token(), protocol: Proto.PROTOCOL_VERSION })
await b.send({ t: 'attach', id: 'smoke-1' })
b.type('smoke-1', say('smoke-1', 'MARKER-BETA'))
await sleep(2200)
b.close()
await sleep(400)

// 3 — a brand-new client reattaches and is handed the history.
const c = await connect()
await c.send({ t: 'hello', token: token(), protocol: Proto.PROTOCOL_VERSION })
const list = await c.send({ t: 'list' })
const row = list.data.find((s) => s.id === 'smoke-1')
expect('the session outlived both clients', !!row && row.alive, JSON.stringify(list.data))
expect(
  'it is the same process, not a new one',
  pid > 0 && row?.pid === pid,
  `${row?.pid} vs ${pid}`
)
const re = await c.send({ t: 'attach', id: 'smoke-1' })
expect('reattach reports it alive', re.data?.alive === true, JSON.stringify(re.data))
await sleep(700)
expect('backlog replays the first command', ran(c.backlog, 'MARKER-ALPHA'), strip(c.backlog).slice(-300))
expect('backlog replays what happened while detached', ran(c.backlog, 'MARKER-BETA'), strip(c.backlog).slice(-300))

// 4 — and it is still a live shell, not a recording.
c.type('smoke-1', say('smoke-1', 'MARKER-GAMMA'))
await sleep(2500)
expect('the reattached shell still accepts input', ran(c.live, 'MARKER-GAMMA'), strip(c.live).slice(-200))

// 5 — closing a pane is the one thing that really ends it.
await c.send({ t: 'kill', id: 'smoke-1' })
await sleep(900)
const after = await c.send({ t: 'list' })
expect('kill removes the session', !after.data.some((s) => s.id === 'smoke-1'), JSON.stringify(after.data))

c.close()
server.close()
await sleep(300)
console.log(failures === 0 ? '\nSMOKE PASSED' : `\nSMOKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
