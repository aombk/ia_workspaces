// The session broker: framing, the ring's cursor, the session table, and one
// end-to-end pass over a real socket.
//
// The pty is faked throughout. What is being tested is the thing that has to be
// right for a shell to survive the app closing — that sessions outlive clients,
// that a reattach is handed exactly what it missed, and that an exit is not
// lost when nobody was listening. None of that needs a real shell, and all of
// it is impossible to check by hand without quitting the app.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-host-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    protocol: 'src/host/protocol.ts',
    ring: 'src/host/ring.ts',
    sessions: 'src/host/sessions.ts',
    server: 'src/host/server.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron', '@lydell/node-pty'],
})

const P = await import(`file://${out}/protocol.js`)
const { RingBuffer } = await import(`file://${out}/ring.js`)
const { SessionTable } = await import(`file://${out}/sessions.js`)
const { startHostServer } = await import(`file://${out}/server.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}
const checkAsync = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

// ------------------------------------------------------------------ framing
console.log('Framing')
{
  check('a frame round-trips', () => {
    const frames = []
    const r = new P.FrameReader((k, p) => frames.push([k, p]), () => assert.fail('no error'))
    r.push(P.encodeJson({ t: 'list', ref: 1 }))
    assert.equal(frames.length, 1)
    assert.equal(frames[0][0], P.FRAME_JSON)
    assert.deepEqual(P.decodeJson(frames[0][1]), { t: 'list', ref: 1 })
  })

  check('several frames in one chunk all arrive', () => {
    const frames = []
    const r = new P.FrameReader((k, p) => frames.push([k, p]), () => assert.fail('no error'))
    r.push(Buffer.concat([
      P.encodeJson({ t: 'list', ref: 1 }),
      P.encodeJson({ t: 'list', ref: 2 }),
      P.encodeData(P.FRAME_DATA, 'pane-a', Buffer.from('hello')),
    ]))
    assert.equal(frames.length, 3)
    assert.equal(P.decodeData(frames[2][1]).data.toString(), 'hello')
  })

  check('a frame split across chunks is reassembled', () => {
    // Split inside the length field itself, which is the case a naive reader
    // gets wrong: two bytes of a u32 is not a short frame, it is no frame.
    const whole = P.encodeData(P.FRAME_DATA, 'pane-a', Buffer.from('abcdefghij'))
    const frames = []
    const r = new P.FrameReader((k, p) => frames.push([k, p]), () => assert.fail('no error'))
    r.push(whole.subarray(0, 2))
    assert.equal(frames.length, 0)
    assert.equal(r.pending, 2)
    r.push(whole.subarray(2, 9))
    assert.equal(frames.length, 0)
    r.push(whole.subarray(9))
    assert.equal(frames.length, 1)
    assert.equal(P.decodeData(frames[0][1]).data.toString(), 'abcdefghij')
  })

  check('an id with multi-byte characters survives', () => {
    const framed = P.decodeData(P.encodeData(P.FRAME_DATA, 'pané-→-id', Buffer.from([0x1b, 0x5b, 0x30])).subarray(5))
    assert.equal(framed.id, 'pané-→-id')
    assert.deepEqual([...framed.data], [0x1b, 0x5b, 0x30])
  })

  check('binary payloads are not mangled', () => {
    // Every byte value, including the newline that rules out a delimiter.
    const raw = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const framed = P.decodeData(P.encodeData(P.FRAME_DATA, 'x', raw).subarray(5))
    assert.deepEqual([...framed.data], [...raw])
  })

  check('an impossible length kills the stream instead of resyncing', () => {
    let error = ''
    const r = new P.FrameReader(() => assert.fail('no frame'), (m) => (error = m))
    const bogus = Buffer.alloc(5)
    bogus.writeUInt32LE(P.MAX_FRAME + 1, 0)
    r.push(bogus)
    assert.match(error, /exceeds/)
    // And stays dead: there is no way to find the next boundary.
    r.push(P.encodeJson({ t: 'list', ref: 1 }))
  })
}

// --------------------------------------------------------------------- ring
console.log('Ring cursor')
{
  check('a fresh reader gets everything and is not called truncated', () => {
    const ring = new RingBuffer(1024)
    ring.write(Buffer.from('hello world'))
    const slice = ring.readFrom(0)
    assert.equal(slice.data.toString(), 'hello world')
    assert.equal(slice.truncated, false)
    assert.equal(slice.cursor, 11)
  })

  check('a caught-up reader gets nothing', () => {
    const ring = new RingBuffer(1024)
    ring.write(Buffer.from('abc'))
    assert.equal(ring.readFrom(3).data.length, 0)
  })

  check('a reader that fell behind gets exactly what it missed', () => {
    const ring = new RingBuffer(1024)
    ring.write(Buffer.from('abcdef'))
    const slice = ring.readFrom(2)
    assert.equal(slice.data.toString(), 'cdef')
    assert.equal(slice.truncated, false)
  })

  check('a cursor the ring has overwritten reports truncation', () => {
    const ring = new RingBuffer(8)
    ring.write(Buffer.from('0123456789ABCDEF')) // wraps well past 8 bytes
    const slice = ring.readFrom(1)
    assert.equal(slice.truncated, true)
    assert.equal(slice.data.toString(), '89ABCDEF')
    assert.equal(slice.cursor, 16)
  })

  check('a never-seen session is not reported as truncated', () => {
    // cursor 0 means "I have nothing", which is not the same as "I lost some".
    const ring = new RingBuffer(8)
    ring.write(Buffer.from('0123456789'))
    assert.equal(ring.readFrom(0).truncated, false)
  })
}

// ------------------------------------------------------------ session table
console.log('Session table')
{
  const makeFake = () => {
    const fake = {
      pid: 4242,
      written: [],
      killed: false,
      _data: null,
      _exit: null,
      write(d) { fake.written.push(d) },
      resize() {},
      kill() { fake.killed = true },
      onData(cb) { fake._data = cb },
      onExit(cb) { fake._exit = cb },
    }
    return fake
  }
  const spec = (id) => ({ id, file: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })

  const build = () => {
    const events = { data: [], exit: [] }
    let last = null
    const table = new SessionTable(
      () => (last = makeFake()),
      {
        onData: (id, d, clients) => events.data.push([id, d.toString(), [...clients]]),
        onExit: (id, e) => events.exit.push([id, e]),
      }
    )
    return { table, events, pty: () => last }
  }

  check('output is ringed even with nobody attached', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    pty()._data('before anyone looked')
    const { result, backlog } = table.attach('a', 'client-1')
    assert.equal(backlog.toString(), 'before anyone looked')
    assert.equal(result.alive, true)
  })

  check('re-spawning a live id is a no-op, not a replacement', () => {
    // What a restarted app does for every pane it restores.
    const { table, pty } = build()
    table.create(spec('a'))
    const first = pty()
    const res = table.create(spec('a'))
    // The pid comes back on this path too — a restarting app re-registers the
    // pid map from it, which is how `iaw` still finds a pane whose shell has
    // been running since before this instance of the app existed.
    assert.deepEqual(res, { ok: true, existing: true, pid: 4242 })
    assert.equal(pty(), first)
    assert.equal(first.killed, false)
  })

  check('detaching leaves the session running', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    table.attach('a', 'client-1')
    table.detach('a', 'client-1')
    assert.equal(table.has('a'), true)
    pty()._data('still going')
    assert.equal(table.attach('a', 'client-2').backlog.toString(), 'still going')
  })

  check('a client disappearing detaches it everywhere but kills nothing', () => {
    const { table } = build()
    table.create(spec('a'))
    table.create(spec('b'))
    table.attach('a', 'gone')
    table.attach('b', 'gone')
    table.detachAll('gone')
    assert.equal(table.count, 2)
    assert.deepEqual(table.list().map((s) => s.attached), [0, 0])
  })

  check('reattaching with a cursor gets only the gap', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    pty()._data('first')
    const first = table.attach('a', 'c1')
    table.detach('a', 'c1')
    pty()._data('second')
    const again = table.attach('a', 'c1', first.result.cursor)
    assert.equal(again.backlog.toString(), 'second')
  })

  check('an exit is held until a client acknowledges it', () => {
    const { table, events, pty } = build()
    table.create(spec('a'))
    table.attach('a', 'c1')
    pty()._exit({ exitCode: 3 })
    assert.deepEqual(events.exit, [['a', { exitCode: 3, signal: undefined }]])
    // Still listed, so a client that was closed at the time can still learn.
    assert.equal(table.has('a'), true)
    assert.equal(table.list()[0].alive, false)
    table.ackExit('a', 'c1')
    assert.equal(table.has('a'), false)
  })

  check('one client acknowledging does not rob the other', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    table.attach('a', 'c1')
    table.attach('a', 'c2')
    pty()._exit({ exitCode: 0 })
    table.ackExit('a', 'c1')
    assert.equal(table.has('a'), true, 'c2 has not been told yet')
    table.ackExit('a', 'c2')
    assert.equal(table.has('a'), false)
  })

  check('attaching to a dead session still yields its output and its exit', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    pty()._data('last words')
    pty()._exit({ exitCode: 1 })
    const { result, backlog } = table.attach('a', 'late')
    assert.equal(result.alive, false)
    assert.deepEqual(result.exit, { exitCode: 1, signal: undefined })
    assert.equal(backlog.toString(), 'last words')
  })

  check('killing is the only thing that destroys a session', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    const p = pty()
    assert.equal(table.kill('a'), true)
    assert.equal(p.killed, true)
    assert.equal(table.has('a'), false)
  })

  check('writes reach the shell, and stop when it is gone', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    assert.equal(table.write('a', Buffer.from('ls\r')), true)
    assert.deepEqual(pty().written, ['ls\r'])
    pty()._exit({ exitCode: 0 })
    assert.equal(table.write('a', Buffer.from('too late')), false)
  })

  check('idle is false while a dead-but-unacknowledged session remains', () => {
    const { table, pty } = build()
    table.create(spec('a'))
    table.attach('a', 'c1')
    pty()._exit({ exitCode: 0 })
    assert.equal(table.idle, false, 'the exit still has to reach somebody')
    table.ackExit('a', 'c1')
    assert.equal(table.idle, true)
  })
}

// ------------------------------------------------------------------ the wire
console.log('End to end over a socket')
{
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\iaw-hosttest-${process.pid}`
      : path.join(out, 'test.sock')
  const tokenPath = path.join(out, 'test.token')

  const fakes = []
  const server = startHostServer({
    address,
    tokenPath,
    idleCheckMs: 1_000_000, // never during the test
    // Nor the short empty-exit: this suite connects and disconnects constantly
    // while holding nothing, which is exactly what that timer reacts to.
    emptyExitMs: 1_000_000,
    spawner: () => {
      const fake = {
        pid: 99,
        written: [],
        write(d) { fake.written.push(d) },
        resize() {},
        kill() { fake._exit?.({ exitCode: 0 }) },
        onData(cb) { fake._data = cb },
        onExit(cb) { fake._exit = cb },
      }
      fakes.push(fake)
      return fake
    },
  })

  /** A minimal client: framing, hello, and request/reply by `ref`. */
  function connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect(address)
      const waiters = new Map()
      const data = []
      let ref = 0
      const reader = new P.FrameReader((kind, payload) => {
        if (kind === P.FRAME_JSON) {
          const m = P.decodeJson(payload)
          const w = waiters.get(m.ref)
          if (w) { waiters.delete(m.ref); w(m) }
          else data.push({ kind: 'event', message: m })
          return
        }
        const framed = P.decodeData(payload)
        data.push({ kind: kind === P.FRAME_BACKLOG ? 'backlog' : 'live', id: framed.id, text: framed.data.toString() })
      }, reject)

      socket.on('data', (c) => reader.push(c))
      socket.on('error', reject)
      socket.on('connect', () => {
        const client = {
          data,
          send(message) {
            const r = ++ref
            return new Promise((res) => {
              waiters.set(r, res)
              socket.write(P.encodeJson({ ...message, ref: r }))
            })
          },
          writeData: (id, text) => socket.write(P.encodeData(P.FRAME_DATA, id, Buffer.from(text))),
          close: () => socket.destroy(),
        }
        resolve(client)
      })
    })
  }

  const settle = () => new Promise((r) => setTimeout(r, 60))
  const token = () => fs.readFileSync(tokenPath, 'utf8')

  await checkAsync('a bad token is refused and the connection dropped', async () => {
    const c = await connect()
    const res = await c.send({ t: 'hello', token: 'wrong'.padEnd(48, 'x'), protocol: P.PROTOCOL_VERSION })
    assert.equal(res.t, 'error')
    assert.match(res.message, /unauthorized/)
    c.close()
  })

  await checkAsync('a protocol mismatch is named rather than guessed at', async () => {
    const c = await connect()
    const res = await c.send({ t: 'hello', token: token(), protocol: 999 })
    assert.equal(res.t, 'error')
    assert.match(res.message, /protocol 999 unsupported/)
    c.close()
  })

  await checkAsync('spawn, attach and live output reach the client', async () => {
    const c = await connect()
    assert.equal((await c.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })).t, 'hello')
    assert.equal((await c.send({ t: 'spawn', id: 'p1', file: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })).t, 'ok')
    assert.equal((await c.send({ t: 'attach', id: 'p1' })).data.alive, true)
    fakes[0]._data('live bytes')
    await settle()
    assert.deepEqual(c.data.filter((d) => d.kind === 'live'), [{ kind: 'live', id: 'p1', text: 'live bytes' }])
    c.close()
  })

  await checkAsync('the client going away leaves the shell running', async () => {
    // The whole feature, in one check: a client vanishes, more output arrives
    // with nobody listening, a NEW client attaches and is handed all of it.
    fakes[0]._data(' while away')
    await settle()
    const fresh = await connect()
    await fresh.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })
    const res = await fresh.send({ t: 'attach', id: 'p1' })
    assert.equal(res.data.alive, true)
    await settle()
    const backlog = fresh.data.filter((d) => d.kind === 'backlog')
    assert.equal(backlog.length, 1)
    assert.equal(backlog[0].text, 'live bytes while away')
    fresh.close()
  })

  await checkAsync('a cursor reattach is handed only the gap', async () => {
    const c = await connect()
    await c.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })
    const first = await c.send({ t: 'attach', id: 'p1' })
    fakes[0]._data('|new')
    await settle()
    const again = await c.send({ t: 'attach', id: 'p1', cursor: first.data.cursor })
    await settle()
    const backlog = c.data.filter((d) => d.kind === 'backlog').pop()
    assert.equal(backlog.text, '|new')
    assert.equal(again.data.truncated, false)
    c.close()
  })

  await checkAsync('attach resolves before its backlog is delivered', async () => {
    // Written to confirm the opposite, and it disproved it — which is why it
    // stays. The reply and the backlog are two writes and arrive in two reads,
    // so the attach continuation runs first and the backlog lands afterwards.
    //
    // The point is that neither order may be *relied upon*: it depends on how
    // the OS chooses to coalesce two writes, which differs by transport and by
    // payload size. So nothing downstream decides anything in that
    // continuation — PtyManager settles a reattached pane's `claude --resume`
    // line before it attaches at all, where no delivery timing can reach it.
    const c = await connect()
    await c.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })
    await c.send({
      t: 'spawn', id: 'p-order', file: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24,
    })
    fakes[fakes.length - 1]._data('REPLAYED-PROMPT')
    await settle()

    await c.send({ t: 'attach', id: 'p-order' })
    // Read immediately in the continuation — no settle, no timer.
    const atResolve = c.data.filter((d) => d.kind === 'backlog' && d.id === 'p-order').length
    await settle()
    const later = c.data.filter((d) => d.kind === 'backlog' && d.id === 'p-order').length
    assert.equal(atResolve, 0, 'not yet delivered when attach resolves')
    assert.equal(later, 1, 'but it does arrive')
    // Tidied up, or the session-count assertions further down see two.
    await c.send({ t: 'kill', id: 'p-order' })
    c.close()
  })

  await checkAsync('keystrokes travel as data frames and reach the shell', async () => {
    const c = await connect()
    await c.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })
    await c.send({ t: 'attach', id: 'p1' })
    c.writeData('p1', 'echo hi\r')
    await settle()
    assert.ok(fakes[0].written.includes('echo hi\r'))
    c.close()
  })

  await checkAsync('an exit is announced and then acknowledged away', async () => {
    const c = await connect()
    await c.send({ t: 'hello', token: token(), protocol: P.PROTOCOL_VERSION })
    await c.send({ t: 'attach', id: 'p1' })
    fakes[0]._exit({ exitCode: 7 })
    await settle()
    const event = c.data.find((d) => d.kind === 'event' && d.message.t === 'exit')
    assert.equal(event.message.exitCode, 7)
    assert.equal((await c.send({ t: 'list' })).data.length, 1, 'held until acknowledged')
    await c.send({ t: 'ackExit', id: 'p1' })
    assert.equal((await c.send({ t: 'list' })).data.length, 0)
    c.close()
  })

  await checkAsync('the token file is 0600 on posix', async () => {
    if (process.platform === 'win32') return
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600)
  })

  server.close()
  await settle()
}

console.log(`\n${passed} checks passed`)
