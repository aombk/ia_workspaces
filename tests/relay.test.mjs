// Relay's write rule, against a real git repository and a real folder.
//
// The rule is the whole feature and it is invisible from the screen: a file
// either appears in the shared folder or it does not, and both outcomes look
// identical from inside the app. Everything here is therefore about *when
// nothing happens* — the idle project that must never write, the change that
// must wait, the change undone inside the wait that must never be published at
// all. Those are the assertions that stop a well-meaning edit turning the delay
// back into a heartbeat.
//
// The clock is stubbed rather than waited on. `relay.ts` reads `Date.now()`
// through the global, so the bundle can be given a clock that jumps two minutes
// in one line — and a suite that genuinely slept for the settle delay would be
// a suite nobody runs.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-relay-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { relay: 'src/main/relay.ts', crypto: 'src/main/shareCrypto.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const R = await import(`file://${out}/relay.js`)
const { unseal } = await import(`file://${out}/crypto.js`)

let passed = 0
const checkAsync = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

// ------------------------------------------------------------------ fixtures

/** The app's own data folder — where this machine's identity is written down. */
const dataDir = path.join(out, 'appdata')
/** Standing in for the synced drive. */
const shared = path.join(out, 'share')
const relayDir = path.join(shared, 'ia_workspaces-relay')

const repo = path.join(out, 'repo')
fs.mkdirSync(repo)
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()

git('init', '--initial-branch=main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test Person')
git('config', 'commit.gpgsign', 'false')
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
git('add', 'a.txt')
git('commit', '-m', 'groundwork')

// A remote, because "not sent" is a comparison and there is nothing to compare
// against without one. A repository with no remote reports `unsent: 0` and
// `hasRemote: false` — which is git being right, and is why the pane has a
// separate sentence for it.
const bare = path.join(out, 'origin.git')
execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { windowsHide: true })
git('remote', 'add', 'origin', bare)
git('push', '-u', 'origin', 'main')

fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
git('commit', '-am', 'first save')

const entries = [{ cwd: repo, name: 'alpha', open: true }]
const publish = () => R.publishRelay(dataDir, shared, entries)

/** A clock the tests move by hand. Real time never advances inside the bundle. */
const realNow = Date.now
let clock = realNow()
Date.now = () => clock
/** Two minutes and a bit — past `SETTLE_MS`. */
const waitOutTheDelay = () => {
  clock += 2 * 60 * 1000 + 1000
}

/** Every file this machine has written, and when it last wrote each. */
function written() {
  const found = {}
  for (const project of fs.existsSync(relayDir) ? fs.readdirSync(relayDir) : []) {
    for (const file of fs.readdirSync(path.join(relayDir, project))) {
      // State records only. The `cmd-` files beside them are sealed blobs, not
      // JSON, which is the entire point of them.
      if (file.startsWith('cmd-')) continue
      const full = path.join(relayDir, project, file)
      found[`${project}/${file}`] = {
        at: fs.statSync(full).mtimeMs,
        record: JSON.parse(fs.readFileSync(full, 'utf8')),
      }
    }
  }
  return found
}

const only = () => {
  const files = written()
  const names = Object.keys(files)
  assert.equal(names.length, 1, `expected exactly one record, found ${names.length}`)
  return files[names[0]]
}

// --------------------------------------------------------------------- tests

await checkAsync('the folder being blank is off, and is said so rather than shown as empty', async () => {
  const relay = await R.publishRelay(dataDir, '   ', entries)
  assert.equal(relay.problem, 'off')
  assert.equal(relay.machine, '', 'nothing identifies itself when the feature is not on')
  assert.ok(!fs.existsSync(relayDir), 'and nothing is created anywhere')
})

await checkAsync('the first look publishes at once, without waiting out the delay', async () => {
  const relay = await publish()
  assert.ok(relay.machine, 'this machine names itself once it has somewhere to write')
  const { record } = only()
  assert.equal(record.name, 'alpha')
  assert.equal(record.branch, 'main')
  assert.equal(record.unsent, 1, 'a save with nowhere to go is a save that has not been sent')
  assert.deepEqual(record.unsentSubjects, ['first save'], 'and it is named, not just counted')
  assert.equal(record.hasRemote, true)
})

await checkAsync('an unchanged project writes nothing at all — there is no heartbeat', async () => {
  const before = only().at
  await publish()
  clock += 60 * 60 * 1000 // an hour of an idle afternoon
  await publish()
  await publish()
  assert.equal(only().at, before, 'the file on the disk was never touched again')
})

await checkAsync('a change waits, and is not published on the sweep that finds it', async () => {
  const before = only().at
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
  await publish()
  assert.equal(only().at, before, 'the clock started; nothing was written')
  clock += 30 * 1000
  await publish()
  assert.equal(only().at, before, 'and half a minute later it is still waiting')
})

await checkAsync('once the delay is out, what is written is the state now', async () => {
  // A second file appears while the first change is still waiting. The record
  // must describe both — the clock is not restarted, and what it publishes is
  // whatever is true when it expires rather than what started it.
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
  git('add', 'b.txt')
  waitOutTheDelay()
  await publish()
  const { record } = only()
  assert.deepEqual(record.changed, ['a.txt', 'b.txt'], 'both, and repository-relative')
  assert.equal(record.untracked, 0)
})

await checkAsync('a change undone inside the delay is never published', async () => {
  const before = only().at
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n')
  await publish() // starts the clock
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n') // ...and puts it back
  waitOutTheDelay()
  await publish()
  assert.equal(only().at, before, 'nothing differed by the time the clock ran out')
})

await checkAsync('an untracked file is counted and never named', async () => {
  fs.writeFileSync(path.join(repo, 'secrets.env'), 'TOKEN=hunter2\n')
  await publish()
  waitOutTheDelay()
  await publish()
  const { record } = only()
  assert.equal(record.untracked, 1, 'it is counted, so the machine is not silently wrong')
  assert.ok(
    !JSON.stringify(record).includes('secrets.env'),
    'and its name is nowhere in the file — not in changed, not anywhere'
  )
  fs.rmSync(path.join(repo, 'secrets.env'))
})

await checkAsync('a tag on an abandoned line is not counted as unsent work', async () => {
  // The bug this test exists for, found by looking at a real record. `main` was
  // fully pushed and the record claimed thirteen saves not sent — all of them
  // held alive by one `backup-before-reset` tag on a line abandoned months
  // earlier. `RepoStatus.unsent` counts every ref, which is right for the
  // history pane marking rows and wrong for a sentence that names a branch.
  // A feature built to stop somebody worrying must not invent worries.
  git('checkout', '-b', 'abandoned')
  fs.writeFileSync(path.join(repo, 'dead.txt'), 'went nowhere\n')
  git('add', 'dead.txt')
  git('commit', '-m', 'a road not taken')
  git('tag', 'backup-before-reset')
  git('checkout', 'main')
  git('branch', '-D', 'abandoned') // the tag alone keeps it reachable

  git('push') // main is now level with origin
  await publish() // starts the clock
  waitOutTheDelay()
  await publish()
  const { record } = only()
  assert.equal(record.unsent, 0, 'main is level, whatever a tag elsewhere is holding on to')
  assert.deepEqual(record.unsentSubjects, [])
  assert.equal(record.upstream, 'origin/main')
})

await checkAsync('a branch that has never been sent is a state, not a zero', async () => {
  git('checkout', '-b', 'brand-new')
  fs.writeFileSync(path.join(repo, 'c.txt'), 'fresh\n')
  git('add', 'c.txt')
  git('commit', '-m', 'nowhere yet')
  await publish() // starts the clock
  waitOutTheDelay()
  await publish()
  const { record } = only()
  assert.equal(record.branch, 'brand-new')
  assert.equal(record.upstream, undefined, 'no upstream is how the pane knows to say so')
  assert.equal(record.unsent, 0, 'git has nothing to count it against, and does not pretend to')
  git('checkout', 'main')
})

await checkAsync('another machine is read back, and told apart from this one', async () => {
  const mine = only().record
  const theirs = {
    ...mine,
    machine: 'macbook-deadbeef',
    label: 'MACBOOK',
    path: '/Users/someone/work/alpha',
    unsent: 2,
    unsentSubjects: ['fixed the parser', 'wip'],
    changed: ['src/main/git.ts'],
    at: clock - 14 * 60 * 1000,
  }
  const project = Object.keys(written())[0].split('/')[0]
  fs.writeFileSync(path.join(relayDir, project, 'macbook-deadbeef.json'), JSON.stringify(theirs))

  const relay = await publish()
  const records = relay.byProject[project]
  assert.equal(records.length, 2)
  const other = records.find((r) => r.machine !== relay.machine)
  assert.equal(other.label, 'MACBOOK')
  assert.deepEqual(other.changed, ['src/main/git.ts'])
  assert.equal(relay.keys[repo], project, 'and the local folder maps to the key they share')
})

await checkAsync('a sync client’s conflict copy does not become a second machine', async () => {
  // OneDrive keeps both sides of a simultaneous write as `name-MACHINE.json`,
  // Dropbox as `name (conflicted copy).json`. Both end in `.json`, so both are
  // read — and a machine appearing twice with two different accounts of itself
  // makes the pane look broken in exactly the situation it exists for.
  const project = Object.keys(written()).find((n) => n.includes('macbook')) ?? Object.keys(written())[0]
  const dir = path.join(relayDir, project.split('/')[0])
  const original = JSON.parse(fs.readFileSync(path.join(dir, 'macbook-deadbeef.json'), 'utf8'))
  fs.writeFileSync(
    path.join(dir, 'macbook-deadbeef (conflicted copy 2026-08-21).json'),
    JSON.stringify({ ...original, unsent: 99, at: original.at - 60_000 })
  )

  const relay = await publish()
  const records = relay.byProject[project.split('/')[0]]
  const macbooks = records.filter((r) => r.machine === 'macbook-deadbeef')
  assert.equal(macbooks.length, 1, 'one machine, one row, however many files it left')
  assert.equal(macbooks[0].unsent, 2, 'and the newer of the two is the one believed')
})

await checkAsync('one repository in two different folders is one project', async () => {
  // The case the whole feature stands on. The same repository is
  // `C:/rootCloud/dev/thing` here and `~/work/thing` on a laptop, and a key made
  // from the path would file the two machines under two projects and merge
  // nothing. The remote is what they have in common, so a clone into a folder of
  // a different name must still land on the same key.
  const twin = path.join(out, 'elsewhere', 'renamed-by-someone')
  fs.mkdirSync(path.dirname(twin), { recursive: true })
  execFileSync('git', ['clone', bare, twin], { windowsHide: true })
  const relay = await R.publishRelay(dataDir, shared, [
    { cwd: repo, name: 'alpha', open: true },
    { cwd: twin, name: 'alpha on the laptop', open: false },
  ])
  assert.equal(relay.keys[twin], relay.keys[repo], 'same remote, one project')
  assert.ok(relay.keys[twin].startsWith('git-'), 'and it is the remote that decided it')
})

await checkAsync('a folder git is not watching is left out entirely', async () => {
  const plain = path.join(out, 'not-a-repo')
  fs.mkdirSync(plain, { recursive: true })
  const relay = await R.publishRelay(dataDir, shared, [{ cwd: plain, name: 'notes', open: false }])
  assert.equal(relay.keys[plain], undefined, 'no key, no record, no empty row on anyone else’s screen')
})

await checkAsync('commands are published only with a passphrase, and only sealed', async () => {
  const commands = ['npm run release', 'psql postgres://me:hunter2@db/app']
  const entry = [{ cwd: repo, name: 'alpha', open: true, commands }]

  // No passphrase: nothing is written, however loudly it is asked for. There
  // must be no path that puts a command line in the folder in the clear.
  await R.publishRelay(dataDir, shared, entry)
  const project = Object.keys(written())[0].split('/')[0]
  const dir = path.join(relayDir, project)
  assert.equal(
    fs.readdirSync(dir).filter((f) => f.startsWith('cmd-')).length,
    0,
    'no passphrase, no commands — not even redacted ones'
  )

  const relay = await R.publishRelay(dataDir, shared, entry, 'a shared passphrase')
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('cmd-'))
  assert.equal(files.length, 1)

  const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8')
  assert.ok(raw.startsWith('iaw1.'), 'sealed, and it says so')
  assert.ok(!raw.includes('npm run release'), 'a command you can read in the folder is the whole problem')
  assert.ok(!raw.includes('hunter2'))

  // And redacted before it was sealed. Belt and braces: the password must not
  // be in there even for somebody who has the passphrase.
  const opened = JSON.parse(unseal(raw, 'a shared passphrase'))
  assert.ok(
    !JSON.stringify(opened).includes('hunter2'),
    'the password is gone before the encryption, not only behind it'
  )
  assert.ok(opened.commands.some((c) => c.includes('postgres://me')), 'and the command still says what it was')

  // This machine's own file is not read back: its commands are already in its
  // own history, fresher than anything it wrote to a synced drive.
  assert.deepEqual(relay.commandsByProject[project] ?? [], [])
})

await checkAsync('a changed command list waits, but the first look of a session does not', async () => {
  const project = Object.keys(written())[0].split('/')[0]
  const dir = path.join(relayDir, project)
  const file = path.join(dir, fs.readdirSync(dir).find((f) => f.startsWith('cmd-')))
  const before = fs.statSync(file).mtimeMs

  // A new command, part-way through a session: held back. Publishing on the
  // next sweep after every command is a few kilobytes per project all day.
  const grown = [{ cwd: repo, name: 'alpha', open: true, commands: ['npm run release', 'git push'] }]
  await R.publishRelay(dataDir, shared, grown, 'a shared passphrase')
  assert.equal(fs.statSync(file).mtimeMs, before, 'the clock started; nothing was written')

  clock += 16 * 60 * 1000
  await R.publishRelay(dataDir, shared, grown, 'a shared passphrase')
  assert.notEqual(fs.statSync(file).mtimeMs, before, 'and once the wait is out, it goes')
})

await checkAsync('another machine’s commands come back, and only for the right passphrase', async () => {
  const project = Object.keys(written())[0].split('/')[0]
  const dir = path.join(relayDir, project)
  const mine = fs.readdirSync(dir).find((f) => f.startsWith('cmd-'))
  // Stand in for a second machine by copying this one's sealed file under
  // another name — same passphrase, different machine id.
  fs.writeFileSync(
    path.join(dir, 'cmd-macbook-deadbeef.json'),
    fs.readFileSync(path.join(dir, mine), 'utf8')
  )

  const right = await R.publishRelay(
    dataDir,
    shared,
    [{ cwd: repo, name: 'alpha', open: true }],
    'a shared passphrase'
  )
  const found = right.commandsByProject[project] ?? []
  assert.equal(found.length, 1, 'the other machine is read; this one is skipped')
  assert.ok(found[0].commands.includes('npm run release'))

  const wrong = await R.publishRelay(
    dataDir,
    shared,
    [{ cwd: repo, name: 'alpha', open: true }],
    'the wrong passphrase'
  )
  assert.deepEqual(
    wrong.commandsByProject[project] ?? [],
    [],
    'a machine that cannot read them sees nothing, and that is not an error'
  )
})

Date.now = realNow
console.log(`\n${passed} checks passed`)
