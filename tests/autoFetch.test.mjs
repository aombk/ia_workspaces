// Background fetch, against real repositories and a real git.
//
// What has to hold is all about nobody watching: work pushed elsewhere arrives,
// a repository is not fetched twice in the throttle window however many things
// ask, a failure is not retried every minute, and nothing ever stops to ask for
// a password.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(fs.realpathSync(os.tmpdir()), 'iaw-autofetch-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { git: 'src/main/git.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const G = await import(`file://${out}/git.js`)

let passed = 0
const checkAsync = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// One remote, and two machines' clones of it.
const bare = path.join(out, 'origin.git')
git(out, 'init', '-q', '--bare', '--initial-branch=main', bare)
const here = path.join(out, 'here')
const there = path.join(out, 'there')
git(out, 'clone', '-q', bare, here)
fs.writeFileSync(path.join(here, 'a.txt'), 'one\n')
git(here, 'add', '.')
git(here, 'commit', '-q', '-m', 'first')
git(here, 'push', '-q', '-u', 'origin', 'main')
git(out, 'clone', '-q', bare, there)

const behind = () => Number(git(here, 'rev-list', '--count', 'HEAD..origin/main'))

console.log('Background fetch')

await checkAsync('work pushed from another machine arrives, and nothing of ours moves', async () => {
  fs.writeFileSync(path.join(there, 'b.txt'), 'from the other machine\n')
  git(there, 'add', '.')
  git(there, 'commit', '-q', '-m', 'pushed elsewhere')
  git(there, 'push', '-q')
  const head = git(here, 'rev-parse', 'HEAD')
  assert.equal(behind(), 0, 'not known before the fetch')
  const res = await G.backgroundFetch(here, 0)
  assert.equal(res.status, 'fetched', res.error)
  assert.equal(res.root, here)
  assert.equal(behind(), 1, 'known after it')
  assert.equal(git(here, 'rev-parse', 'HEAD'), head, 'the branch did not move')
  assert.ok(!fs.existsSync(path.join(here, 'b.txt')), 'no file arrived in the folder')
})

await checkAsync('fetched again inside the window is skipped', async () => {
  const res = await G.backgroundFetch(here, 60_000)
  assert.equal(res.status, 'skipped')
})

await checkAsync('asked twice at once, it fetches once', async () => {
  const [a, b] = await Promise.all([G.backgroundFetch(here, 0), G.backgroundFetch(path.join(here), 0)])
  assert.equal(a.status, 'fetched')
  assert.deepEqual(a, b, 'the second caller got the first fetch, not one of its own')
})

await checkAsync('a folder with no remote, or no repository, is skipped', async () => {
  const lone = path.join(out, 'lone')
  fs.mkdirSync(lone)
  assert.equal((await G.backgroundFetch(lone, 0)).status, 'skipped')
  git(lone, 'init', '-q')
  assert.equal((await G.backgroundFetch(lone, 0)).status, 'skipped')
})

await checkAsync('a failure is reported, then left alone for the back-off', async () => {
  const broken = path.join(out, 'broken')
  git(out, 'clone', '-q', bare, broken)
  git(broken, 'remote', 'set-url', 'origin', path.join(out, 'gone.git'))
  const first = await G.backgroundFetch(broken, 0)
  assert.equal(first.status, 'failed')
  assert.ok(first.error)
  assert.equal((await G.backgroundFetch(broken, 0)).status, 'skipped', 'not retried straight away')
})

await checkAsync('a remote that wants credentials fails instead of asking', async () => {
  const locked = path.join(out, 'locked')
  git(out, 'clone', '-q', bare, locked)
  // Nothing listens here: whatever git or a helper would do next, it must not
  // wait for a person. Bounded well under the network timeout.
  git(locked, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/nobody/nothing.git')
  const started = Date.now()
  const res = await G.backgroundFetch(locked, 0)
  assert.equal(res.status, 'failed')
  assert.ok(Date.now() - started < 30_000, 'it gave up rather than waiting')
})

await checkAsync('a save, send or tag waits for a background fetch to finish first', async () => {
  const slow = path.join(out, 'slow')
  git(out, 'clone', '-q', bare, slow)
  // A remote that takes a second and a half to answer, so the fetch is
  // certainly still running when the tag is asked for. `ext::` runs a command
  // as the transport; it is off unless a repository allows it.
  git(slow, 'config', 'protocol.ext.allow', 'always')
  git(slow, 'remote', 'set-url', 'origin', `ext::sh -c sleep% 1.5;% git-upload-pack% '${bare}'`)
  const order = []
  const fetched = G.backgroundFetch(slow, 0).then((res) => order.push(`fetch:${res.status}`))
  await new Promise((r) => setTimeout(r, 200))
  const tagged = G.addTag(slow, 'HEAD', 'waited').then((res) => order.push(`tag:${res.ok}`))
  await Promise.all([fetched, tagged])
  assert.deepEqual(order, ['fetch:fetched', 'tag:true'], 'the tag was made after the fetch, not during it')
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
