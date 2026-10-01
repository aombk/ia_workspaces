// Files and sockets that hold secrets, and who else can reach them.
//
// The pid map carries the control token; the broker's socket is handed the
// broker token by every client that connects. Both are fine as long as they are
// this user's alone, and both used to be less private than that — the pid map
// world-readable and wiped wholesale by any instance, the socket's short-path
// fallback a fixed name in a directory every account can write to.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-privacy-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    pidMap: 'src/main/pidMap.ts',
    paths: 'src/host/paths.ts',
    platform: 'src/shared/platform.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const { PidMap } = await import(`file://${out}/pidMap.js`)
const { ensurePrivateDir, isOwnedByUs } = await import(`file://${out}/paths.js`)
const { ipcAddress } = await import(`file://${out}/platform.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const posix = process.platform !== 'win32'
const identity = { paneId: 'p', workspaceId: 'w', pipe: '/x.sock', token: 'secret' }
/** A pid that certainly belonged to a process and certainly no longer does. */
const deadPid = spawnSync(process.execPath, ['-e', '']).pid

console.log('Pid map')
{
  check('entries and their folder are private to this user', () => {
    if (!posix) return
    const dir = path.join(out, 'modes')
    const map = new PidMap(dir)
    map.register(process.pid, identity)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(fs.statSync(path.join(dir, `${process.pid}.json`)).mode & 0o777, 0o600)
  })

  check('an existing world-readable folder is tightened', () => {
    if (!posix) return
    const dir = path.join(out, 'loose')
    fs.mkdirSync(dir, { mode: 0o755 })
    fs.chmodSync(dir, 0o755)
    new PidMap(dir)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  })

  check("clearing removes this app's entries and the dead, never another live app's", () => {
    // The folder is shared by every running copy of the app. Startup and quit
    // used to wipe all of it, taking the `iaw` fallback away from another
    // instance's live panes.
    const dir = path.join(out, 'shared')
    const map = new PidMap(dir)
    const write = (name, entry) => fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(entry))

    map.register(process.pid, identity) // ours
    // Another app instance, alive, with a live shell. The test runner stands
    // in for both: it is alive and it is not us.
    write('other', { ...identity, pid: process.ppid, startedAt: 1, owner: process.ppid })
    write('orphan', { ...identity, pid: process.ppid, startedAt: 1, owner: deadPid }) // its app exited
    write('deadshell', { ...identity, pid: deadPid, startedAt: 1, owner: process.ppid }) // its shell exited
    write('legacy-live', { ...identity, pid: process.ppid, startedAt: 1 }) // older build, shell alive
    write('garbage', '{ half-written')

    map.clear()
    assert.deepEqual(fs.readdirSync(dir).sort(), ['legacy-live.json', 'other.json'])
  })
}

console.log('Socket addresses')
{
  check('the short-path fallback is a folder of this user’s, not a shared name', () => {
    const deep = `/home/${'x'.repeat(90)}/.local/share/ia_workspaces`
    assert.equal(
      ipcAddress('linux', 'ptyhost', { runtime: deep, tmp: '/tmp', uid: 1000 }),
      '/tmp/iaw-1000/ptyhost.sock'
    )
    // Without a uid the old spelling stands, for callers that do not pass one.
    assert.equal(ipcAddress('linux', 'ptyhost', { runtime: deep, tmp: '/tmp' }), '/tmp/iaw-ptyhost.sock')
  })

  check('a socket folder is created 0700 and accepted', () => {
    if (!posix) return
    const dir = path.join(out, 'sock-dir')
    ensurePrivateDir(dir)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    assert.equal(isOwnedByUs(dir, true), true)
  })

  check('a world-writable socket folder is refused', () => {
    if (!posix) return
    const dir = path.join(out, 'open-dir')
    fs.mkdirSync(dir)
    fs.chmodSync(dir, 0o777)
    assert.throws(() => ensurePrivateDir(dir), (err) => err.code === 'EACCES')
    assert.equal(isOwnedByUs(dir, true), false)
  })

  check('a folder owned by somebody else is refused', () => {
    if (!posix || process.getuid() === 0) return
    // `/` is root's on every POSIX machine this runs on.
    assert.equal(isOwnedByUs('/', true), false)
  })
}

console.log(`\n${passed} checks passed`)
