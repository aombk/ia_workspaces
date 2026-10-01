// What a repository can make this app run without anybody typing `git`.
//
// The app runs `git status` on its own — for the explorer's markers and the git
// pane, every few seconds, on whatever folder a workspace points at — and
// `git diff` whenever a file is opened in the changes view. A repository's own
// `.git/config` can name programs for both to run. So a folder unpacked from an
// archive, merely opened, could run whatever its config says.
//
// Each check plants a command that leaves a file behind if it runs, then has
// the app do what it does on its own, and looks for the file. Against a real
// git: what matters is what git actually executes, and a fake would only agree
// with whatever this file assumed.
//
// Also here: the file search, whose paths came back with Windows separators on
// every platform, so no hit in a subfolder could be opened on a Mac.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-gitsafety-'))
await build({
  entryPoints: { git: 'src/main/git.ts', files: 'src/main/files.ts', worktrees: 'src/main/worktrees.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const G = await import(`file://${out}/git.js`)
const F = await import(`file://${out}/files.js`)
const W = await import(`file://${out}/worktrees.js`)

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

const posix = process.platform !== 'win32'

/** A repository whose config tries to run something, and the file it would leave. */
function plantedRepo(name) {
  const repo = path.join(out, name)
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--initial-branch=main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test Person')
  git('config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'src', 'deep', 'needle.txt'), 'a line with the needle in it\n')
  git('add', '-A')
  git('commit', '-m', 'first')
  fs.writeFileSync(path.join(repo, 'src', 'deep', 'needle.txt'), 'a line with the needle in it\nand another\n')

  const marker = path.join(repo, 'RAN')
  const script = path.join(repo, 'planted.sh')
  fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`)
  fs.chmodSync(script, 0o755)
  return { repo, git, marker, script, ran: () => fs.existsSync(marker) }
}

console.log('What a repository can make the app run')

if (posix) {
  await check('a planted fsmonitor command is not run by the git pane', async () => {
    const r = plantedRepo('fsmonitor-pane')
    r.git('config', 'core.fsmonitor', r.script)
    // The premise first: git really would run it. Without this, the check
    // below could pass because nothing was ever going to happen.
    execFileSync('git', ['status', '--porcelain'], { cwd: r.repo, windowsHide: true })
    assert.ok(r.ran(), 'plain git status should run the planted command')
    fs.rmSync(r.marker)

    await G.repoStatus(r.repo)
    assert.equal(r.ran(), false, 'the git pane ran a command the repository planted')
  })

  await check('nor by the file tree’s change markers', async () => {
    const r = plantedRepo('fsmonitor-tree')
    r.git('config', 'core.fsmonitor', r.script)
    await F.gitStatus(r.repo)
    assert.equal(r.ran(), false)
  })

  await check('nor by the worktree list', async () => {
    const r = plantedRepo('fsmonitor-worktrees')
    r.git('config', 'core.fsmonitor', r.script)
    await W.listWorktrees(r.repo)
    assert.equal(r.ran(), false)
  })

  await check('a planted external diff program is not run when a change is opened', async () => {
    const r = plantedRepo('ext-diff')
    r.git('config', 'diff.external', r.script)
    try {
      execFileSync('git', ['diff'], { cwd: r.repo, windowsHide: true, stdio: 'ignore' })
    } catch {
      // The planted program exits non-zero, so git reports it died — after
      // running it, which is the part being established.
    }
    assert.ok(r.ran(), 'plain git diff should run the planted program')
    fs.rmSync(r.marker)

    const pane = await G.fileDiff(r.repo, 'src/deep/needle.txt')
    const tree = await F.gitDiff(r.repo, path.join(r.repo, 'src', 'deep', 'needle.txt'), false)
    assert.equal(r.ran(), false, 'opening a diff ran a program the repository planted')
    // And the diff is still the real one, from git itself.
    assert.match(pane, /\+and another/)
    assert.match(tree, /\+and another/)
  })
}

console.log('Searching')

await check('a hit in a subfolder points at a file that exists', async () => {
  const r = plantedRepo('search')
  const hits = await F.searchWorkspace(r.repo, 'needle', false)
  assert.ok(hits.length > 0, 'the search found nothing')
  for (const hit of hits) assert.ok(fs.existsSync(hit.path), `${hit.path} does not exist`)
  assert.equal(hits[0].path, path.join(r.repo, 'src', 'deep', 'needle.txt'))
})

fs.rmSync(out, { recursive: true, force: true })
console.log(`\n${passed} checks passed`)
