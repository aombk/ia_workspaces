// Surviving a power cut with the workspace document intact.
//
// This suite exists because the app lost every workspace on a real machine, and
// the code that was supposed to prevent it looked correct. It wrote to a
// temporary file and renamed — which protects against a *process* dying
// mid-write, and not at all against the power going out: `writeFileSync`
// returns when the bytes are in the operating system's cache, and the rename is
// a metadata change the filesystem journals on its own schedule. The machine
// came back with a file of exactly the right length containing 55,052 NUL
// bytes.
//
// So the NUL case is the centrepiece here. It is not a hypothetical failure
// mode and it is not one that any amount of reading the old code would suggest.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-store-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { store: 'src/main/store.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const { Store } = await import(`file://${out}/store.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

/** A store on its own folder, so no test can see another's files. */
let n = 0
function fresh() {
  const dir = path.join(out, `s${n++}`)
  fs.mkdirSync(dir, { recursive: true })
  return { dir, store: new Store(dir), file: path.join(dir, 'workspace.json') }
}

const doc = (count) => ({
  version: 3,
  workspaces: Array.from({ length: count }, (_, i) => ({ id: `w${i}`, name: `project ${i}` })),
})

check('a saved document comes back', () => {
  const { store, dir } = fresh()
  store.save(doc(3))
  store.flush()
  assert.equal(new Store(dir).state.workspaces.length, 3)
})

check('the version before the current one is kept beside it', () => {
  const { store, dir } = fresh()
  store.save(doc(5))
  store.flush()
  store.save(doc(6))
  store.flush()

  const backup = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json.bak'), 'utf8'))
  assert.equal(backup.workspaces.length, 5, 'the backup holds what was there before the last save')
  assert.equal(new Store(dir).state.workspaces.length, 6, 'and the live file holds the newest')
})

check('a file of NUL bytes is recovered from the backup, not read as empty', () => {
  // Exactly what a power cut leaves behind: the right name, the right length,
  // no contents. Read as an empty document it would wipe every workspace, which
  // is the failure this whole file is about.
  const { store, dir, file } = fresh()
  store.save(doc(9))
  store.flush()
  store.save(doc(10))
  store.flush()

  const length = fs.statSync(file).size
  fs.writeFileSync(file, Buffer.alloc(length))

  const recovered = new Store(dir).state
  assert.equal(recovered.workspaces.length, 9, 'the previous version is what survives')
  assert.ok(fs.existsSync(`${file}.corrupt`), 'and the unreadable one is kept, for looking at')
})

check('the recovered document is written back, so the next launch is clean', () => {
  const { store, dir, file } = fresh()
  store.save(doc(4))
  store.flush()
  store.save(doc(7))
  store.flush()
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size))

  new Store(dir) // recovers
  // A second launch that never saved anything must still find the workspaces.
  assert.equal(new Store(dir).state.workspaces.length, 4)
})

check('truncated JSON is recovered too', () => {
  const { store, dir, file } = fresh()
  store.save(doc(2))
  store.flush()
  store.save(doc(8))
  store.flush()
  const half = fs.readFileSync(file, 'utf8').slice(0, 40)
  fs.writeFileSync(file, half, 'utf8')

  assert.equal(new Store(dir).state.workspaces.length, 2)
})

check('an empty file is not an empty document', () => {
  const { store, dir, file } = fresh()
  store.save(doc(3))
  store.flush()
  store.save(doc(5))
  store.flush()
  fs.writeFileSync(file, '', 'utf8')

  assert.equal(new Store(dir).state.workspaces.length, 3, 'zero bytes means damage, never "no workspaces"')
})

check('saving the same document twice writes once', () => {
  // Fifty things call save, and most changes never reach this document. A write
  // that changes nothing is still a window in which a crash can destroy the
  // file, so the cheapest durability available is not writing.
  const { store, dir, file } = fresh()
  store.save(doc(4))
  store.flush()
  const first = fs.statSync(file).mtimeMs

  store.save(doc(4))
  store.flush()
  assert.equal(fs.statSync(file).mtimeMs, first, 'identical contents, untouched file')
  assert.ok(
    !fs.existsSync(path.join(dir, 'workspace.json.bak')),
    'and no backup, because nothing was replaced'
  )
})

check('a first run with nothing on disk is not damage', () => {
  const { store } = fresh()
  assert.deepEqual(store.state, {}, 'no file is an ordinary new install')
})

check('no backup and a broken file still starts, rather than refusing to', () => {
  const { dir, file } = fresh()
  fs.writeFileSync(file, '{ not json', 'utf8')
  assert.deepEqual(new Store(dir).state, {}, 'a blank start beats a window that will not open')
})

check('a pending change is not undone by something reading the state', () => {
  // The bug this exists for: deleting a workspace scheduled a save, a window
  // resize read `state` before it landed, adopted the older document from the
  // disk, and saved that instead. The workspace came back on the next launch,
  // deleted and then un-deleted by a resize.
  const { store, dir } = fresh()
  store.save(doc(3))
  store.flush()

  store.save(doc(1)) // two of them removed; the write is now pending
  assert.equal(store.state.workspaces.length, 1, 'the reader sees what this process believes')

  store.flush()
  assert.equal(new Store(dir).state.workspaces.length, 1, 'and that is what reached the disk')
})

check('patching one field leaves the rest of the document alone', () => {
  const { store, dir } = fresh()
  store.save(doc(4))
  store.flush()

  store.patch({ window: { width: 100, height: 200 } })
  store.flush()

  const after = new Store(dir).state
  assert.equal(after.workspaces.length, 4, 'the workspaces are untouched')
  assert.deepEqual(after.window, { width: 100, height: 200 })
})

check('patching does not resurrect what a pending change removed', () => {
  const { store, dir } = fresh()
  store.save(doc(5))
  store.flush()

  store.save(doc(2))                                  // three removed, not yet written
  store.patch({ window: { width: 10, height: 10 } })  // a resize lands on top
  store.flush()

  assert.equal(new Store(dir).state.workspaces.length, 2, 'the removal survived the resize')
})

console.log(`\n${passed} checks passed`)
