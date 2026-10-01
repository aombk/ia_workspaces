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

  // Reopening a pane as another shell kills and respawns under the same id. The
  // old shell reports its exit a moment later, and believing it painted
  // "[process exited]" over a pane whose new shell was running fine.
  check('a killed shell says nothing once its id has been reused', () => {
    const { table, events, pty } = build()
    table.create(spec('a'))
    const old = pty()
    table.kill('a')
    table.create(spec('a'))
    const fresh = pty()

    old._data('goodbye')
    old._exit({ exitCode: -1073741510 })
    assert.deepEqual(events.data, [])
    assert.deepEqual(events.exit, [])

    // The replacement is untouched by any of it, and still speaks for itself.
    fresh._data('hello')
    fresh._exit({ exitCode: 0 })
    assert.deepEqual(events.data, [['a', 'hello', []]])
    assert.deepEqual(events.exit, [['a', { exitCode: 0, signal: undefined }]])
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
  // Binding waits on a probe of the address now, so the suite waits for it.
  let listening
  const ready = new Promise((r) => (listening = r))
  const server = startHostServer({
    address,
    tokenPath,
    onListening: () => listening(),
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

  await ready

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

  await checkAsync('the backlog arrives exactly once, whenever it arrives', async () => {
    // The reply and the backlog are two writes, and whether they arrive in one
    // read or two is the OS's choice — a named pipe on Windows splits them and
    // the attach continuation runs first; a unix socket on macOS coalesces them
    // and the backlog is already in hand by then. Both were observed, which is
    // why this asserts only what is actually guaranteed: it arrives, and it
    // arrives once.
    //
    // So no order may be relied upon downstream, and none is — PtyManager
    // settles a reattached pane's `claude --resume` line before it attaches at
    // all, where no delivery timing can reach it. That is the property this
    // check exists to protect; the timing itself is not ours to pin down.
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
    const backlog = c.data.filter((d) => d.kind === 'backlog' && d.id === 'p-order')
    assert.ok(atResolve <= 1, 'never more than the one backlog, however it is coalesced')
    assert.equal(backlog.length, 1, 'and it does arrive, exactly once')
    assert.equal(backlog[0].text, 'REPLAYED-PROMPT')
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

// ------------------------------------------------------------ backpressure
console.log('Backpressure')
{
  const fakePty = () => {
    const fake = {
      pid: 7,
      paused: 0,
      resumed: 0,
      write() {},
      resize() {},
      kill() {},
      pause() { fake.paused++ },
      resume() { fake.resumed++ },
      onData(cb) { fake._data = cb },
      onExit(cb) { fake._exit = cb },
    }
    return fake
  }
  const spec = (id) => ({ id, file: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 })

  check('a blocked client pauses the shell, and catching up resumes it', () => {
    let pty
    const table = new SessionTable(() => (pty = fakePty()), { onData() {}, onExit() {} })
    table.create(spec('a'))
    table.attach('a', 'c1')
    table.block('a', 'c1')
    table.block('a', 'c1')
    assert.equal(pty.paused, 1, 'paused once, however often it is told')
    table.unblockClient('c1')
    assert.equal(pty.resumed, 1)
  })

  check('two blocked clients both have to catch up', () => {
    let pty
    const table = new SessionTable(() => (pty = fakePty()), { onData() {}, onExit() {} })
    table.create(spec('a'))
    table.attach('a', 'c1')
    table.attach('a', 'c2')
    table.block('a', 'c1')
    table.block('a', 'c2')
    table.unblockClient('c1')
    assert.equal(pty.resumed, 0, 'c2 is still behind')
    table.detachAll('c2') // c2 leaves instead of catching up
    assert.equal(pty.resumed, 1, 'a client that left holds nothing back')
  })

  check('a session nobody is attached to cannot be paused', () => {
    // Its output has nowhere to go but the ring, and the ring is the point.
    let pty
    const table = new SessionTable(() => (pty = fakePty()), { onData() {}, onExit() {} })
    table.create(spec('a'))
    table.block('a', 'c1')
    assert.equal(pty.paused, 0)
  })

  await checkAsync('a client that stops reading pauses its shells until it drains', async () => {
    const address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\iaw-hosttest-bp-${process.pid}`
        : path.join(out, 'bp.sock')
    const tokenPath = path.join(out, 'bp.token')
    let pty
    let listening
    const ready = new Promise((r) => (listening = r))
    const server = startHostServer({
      address,
      tokenPath,
      idleCheckMs: 1_000_000,
      emptyExitMs: 1_000_000,
      clientHighWater: 64 * 1024,
      spawner: () => (pty = fakePty()),
      onListening: () => listening(),
    })
    await ready

    const socket = net.connect(address)
    await new Promise((r) => socket.once('connect', r))
    const token = fs.readFileSync(tokenPath, 'utf8')
    socket.write(P.encodeJson({ t: 'hello', ref: 1, token, protocol: P.PROTOCOL_VERSION }))
    socket.write(P.encodeJson({ t: 'spawn', ref: 2, id: 'bp', file: 'sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24 }))
    socket.write(P.encodeJson({ t: 'attach', ref: 3, id: 'bp' }))
    await new Promise((r) => setTimeout(r, 60))
    socket.pause() // the app stops reading

    const chunk = 'x'.repeat(32 * 1024)
    for (let i = 0; i < 400 && pty.paused === 0; i++) {
      pty._data(chunk)
      await new Promise((r) => setImmediate(r))
    }
    assert.equal(pty.paused, 1, 'the shell was paused rather than queued without limit')

    socket.on('data', () => {})
    socket.resume() // and catches up
    for (let i = 0; i < 100 && pty.resumed === 0; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(pty.resumed, 1, 'and resumed once the client drained')

    socket.destroy()
    server.close()
  })
}

// ------------------------------------------------------------- two brokers
console.log('Two brokers, one address')
if (process.platform !== 'win32') {
  const start = (address, tokenPath) =>
    new Promise((resolve) => {
      const server = startHostServer({
        address,
        tokenPath,
        idleCheckMs: 1_000_000,
        emptyExitMs: 1_000_000,
        spawner: () => { throw new Error('unused') },
        onListening: () => resolve({ server, ok: true }),
        onListenError: (err) => resolve({ server, ok: false, err }),
      })
    })

  /** Connects and greets; resolves with the reply, or null when nobody answers. */
  const greet = (address, token) =>
    new Promise((resolve) => {
      const socket = net.connect(address)
      socket.on('error', () => resolve(null))
      const reader = new P.FrameReader((kind, payload) => {
        resolve(P.decodeJson(payload))
        socket.destroy()
      }, () => resolve(null))
      socket.on('data', (c) => reader.push(c))
      socket.on('connect', () =>
        socket.write(P.encodeJson({ t: 'hello', ref: 1, token, protocol: P.PROTOCOL_VERSION }))
      )
    })

  await checkAsync('a second broker on a live address loses, and leaves the first intact', async () => {
    const address = path.join(out, 'two.sock')
    const tokenPath = path.join(out, 'two.token')
    const first = await start(address, tokenPath)
    assert.equal(first.ok, true)
    const firstToken = fs.readFileSync(tokenPath, 'utf8')

    const second = await start(address, tokenPath)
    assert.equal(second.ok, false)
    assert.equal(second.err.code, 'EADDRINUSE', 'the ordinary race outcome, so the loser exits quietly')
    second.server.close()
    await new Promise((r) => setTimeout(r, 30))

    assert.ok(fs.existsSync(address), 'the live socket was not unlinked')
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), firstToken, 'nor its token replaced or removed')
    assert.equal((await greet(address, firstToken))?.t, 'hello', 'and the first broker still answers')
    first.server.close()
  })

  await checkAsync('a stale socket left by a crash is replaced', async () => {
    const address = path.join(out, 'stale.sock')
    const tokenPath = path.join(out, 'stale.token')
    // A listener killed outright leaves its socket file behind, answering nobody.
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(address)}, () => console.log('up'))`,
    ])
    await new Promise((r) => child.stdout.once('data', r))
    child.kill('SIGKILL')
    await new Promise((r) => child.once('exit', r))
    assert.ok(fs.existsSync(address), 'the crash left the file')

    const broker = await start(address, tokenPath)
    assert.equal(broker.ok, true)
    assert.equal((await greet(address, fs.readFileSync(tokenPath, 'utf8')))?.t, 'hello')
    broker.server.close()
  })

  await checkAsync('a broker displaced after binding does not take its successor down with it', async () => {
    // The narrow race the probe cannot close: the first broker's socket is
    // unlinked out from under it and a second binds in its place. When the
    // first exits it must not unlink the second's socket — which closing a
    // listening unix socket does by itself — nor delete the second's token.
    const address = path.join(out, 'displaced.sock')
    const tokenPath = path.join(out, 'displaced.token')
    const first = await start(address, tokenPath)
    assert.equal(first.ok, true)
    fs.rmSync(address)
    const second = await start(address, tokenPath)
    assert.equal(second.ok, true)
    const secondToken = fs.readFileSync(tokenPath, 'utf8')

    first.server.close()
    await new Promise((r) => setTimeout(r, 30))

    assert.ok(fs.existsSync(address), "the successor's socket is still there")
    assert.equal(fs.readFileSync(tokenPath, 'utf8'), secondToken, 'and so is its token')
    assert.equal((await greet(address, secondToken))?.t, 'hello', 'and it still answers')
    second.server.close()
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(fs.existsSync(tokenPath), false, 'its own exit still tidies up after itself')
  })
}

console.log(`\n${passed} checks passed`)
