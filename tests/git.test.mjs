// The git panes, against a real git in a throwaway repository.
//
// Not mocked, for the same reason the worktree suite is not: everything worth
// getting wrong here is git's behaviour rather than ours — which column of
// `--porcelain=v2` means picked and which means changed, what `-z` does to a
// rename, whether unpicking works in a repository whose first save has not been
// made yet. A fake git would agree with whatever this file assumed, which is
// exactly the assumption under test.
//
// The graph layout is the exception and is tested on its own, with hand-built
// shapes: a fork and a merge are three lines of input and the whole picture
// turns on them, so they are worth stating in full rather than hoping a real
// repository happens to contain one.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-git-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: { git: 'src/main/git.ts', graph: 'src/shared/gitGraph.ts', words: 'src/shared/gitWords.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  external: ['electron'],
})
const G = await import(`file://${out}/git.js`)
const Graph = await import(`file://${out}/graph.js`)
const Words = await import(`file://${out}/words.js`)

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

// --------------------------------------------------------------- the picture

const lay = (pairs) => Graph.layoutGraph(pairs.map(([sha, ...parents]) => ({ sha, parents })))

check('a straight line stays in one column', () => {
  const rows = lay([['c', 'b'], ['b', 'a'], ['a']])
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0])
  assert.deepEqual(rows[0].in, [], 'the newest save has nothing pointing at it')
  assert.deepEqual(rows[0].out, [0])
  assert.deepEqual(rows[2].out, [], 'the first save in a project came from nothing')
  assert.equal(Graph.graphWidth(rows), 1)
})

check('two lines from one save get a column each, and meet again', () => {
  //   t1  t2      two tips...
  //    \  /
  //     a         ...both from the same save
  const rows = lay([['t1', 'a'], ['t2', 'a'], ['a']])
  assert.equal(rows[0].lane, 0)
  assert.equal(rows[1].lane, 1, 'the second tip is pushed into its own column')
  assert.deepEqual(rows[1].through, [0], "and the first tip's line passes it by")
  assert.deepEqual(rows[2].in.sort(), [0, 1], 'both columns converge on the save they share')
  assert.equal(rows[2].lane, 0, 'the leftmost column wins, so long lines do not drift right')
  assert.equal(Graph.graphWidth(rows), 2)
})

check('a join-up save forks downwards and the diamond closes', () => {
  //     m         a merge commit...
  //    / \
  //   a   b       ...of two lines...
  //    \ /
  //     c         ...that started from one save
  const rows = lay([['m', 'a', 'b'], ['a', 'c'], ['b', 'c'], ['c']])
  const [m, a, b, c] = rows
  assert.deepEqual(m.out.sort(), [0, 1], 'two saves before it means two lines leaving below')
  assert.deepEqual(a.through, [1], "b's line passes a by")
  assert.deepEqual(b.through, [0], "and a's line passes b by")
  assert.deepEqual(c.in.sort(), [0, 1], 'both come back together at the save they share')
  assert.equal(Graph.graphWidth(rows), 2, 'and it never needs a third column')
})

check('a column is reused once the line using it has ended', () => {
  // The side line ends at `a`; the next unrelated tip should take column 1 back
  // rather than starting a third.
  const rows = lay([['t1', 'a'], ['t2', 'a'], ['a'], ['t3', 'z'], ['z']])
  assert.equal(Graph.graphWidth(rows), 2)
  assert.equal(rows[3].lane, 0, 'a tip after everything closed starts at the left again')
})

// ------------------------------------------------------------- the glossary

/** A tooltip anybody actually finishes reading, in characters. */
const TOOLTIP_LIMIT = 90

check('every word has a plain word and explains itself without jargon', () => {
  assert.ok(Words.GIT_WORDS.length > 20)
  for (const word of Words.GIT_WORDS) {
    assert.ok(word.plain.trim(), `${word.term} has no plain word`)
    assert.ok(word.meaning.length > 20, `${word.term} is not explained`)
    assert.notEqual(word.plain, word.term, `${word.term} is not translated`)
  }
  // The rule the whole thing turns on: a git word appearing inside another
  // word's explanation is translated on the spot. Spot-check the ones most
  // likely to drift, since these are the explanations people read first.
  for (const term of ['staged', 'push', 'ahead', 'behind']) {
    const word = Words.gitWord(term)
    if (/\bcommits?\b/.test(word.meaning)) {
      assert.match(word.meaning, /saves? \(commits?\)|commits? \(saves?\)/, `"${term}" uses "commit" untranslated`)
    }
  }
})

check('origin/HEAD is not a line of saves and is never offered as one', () => {
  // git shortens `refs/remotes/origin/HEAD` to plain `origin`, so a filter on
  // the short name misses it and the branch list gains a chip called "origin"
  // that cannot be switched to.
  const raw = [
    ['refs/heads/main', 'main', 'origin/main', '', '*', 'aaaaaaa', '1700000000', '', 'a save'].join('\x1f'),
    ['refs/remotes/origin/HEAD', 'origin', '', '', ' ', 'aaaaaaa', '1700000000', '', 'a save'].join('\x1f'),
    ['refs/remotes/origin/main', 'origin/main', '', '', ' ', 'aaaaaaa', '1700000000', '', 'a save'].join('\x1f'),
  ].join('\n')
  assert.deepEqual(
    G.parseBranches(raw).map((b) => b.name),
    ['main', 'origin/main']
  )
  // And the same pointer must not become a badge on a row, where it would sit
  // beside the branch it merely names.
  assert.deepEqual(
    G.parseRefs('HEAD -> main, origin/main, origin/HEAD, tag: v1.00').map((r) => `${r.kind}:${r.name}`),
    ['head:main', 'remote:origin/main', 'tag:v1.00']
  )
})

check('the tooltip is one line, and the page keeps the long version', () => {
  // The distinction the two lengths exist for: a tooltip is read with the
  // cursor already moving, so a paragraph in one is a paragraph nobody
  // finishes. This is the check that stops `short` quietly growing into
  // `meaning` one helpful clause at a time.
  for (const word of Words.GIT_WORDS) {
    assert.ok(word.short?.trim(), `${word.term} has no one-line meaning`)
    assert.ok(
      word.short.length <= TOOLTIP_LIMIT,
      `${word.term}: the tooltip line is ${word.short.length} characters, over ${TOOLTIP_LIMIT}`
    )
    assert.ok(!word.short.includes('\n'), `${word.term}: a one-line meaning has one line`)
    assert.ok(
      word.short.length < word.meaning.length,
      `${word.term}: the short meaning is not shorter than the long one`
    )
  }
  const tip = Words.tooltipFor('commit')
  assert.match(tip, /commit — save/, 'the pair comes first, so hovering teaches the word')
  assert.ok(tip.length <= TOOLTIP_LIMIT + 40, 'and the whole tooltip stays hoverable')
})

check('a term we do not carry comes back untouched rather than empty', () => {
  assert.equal(Words.plainOf('bisect'), 'bisect')
  assert.equal(Words.plainOf('commit'), 'save')
})

// ------------------------------------------------------ what git said, plainly

check('a refused push is explained as protection, not as damage', () => {
  const hint = G.hintFor('! [rejected] main -> main (non-fast-forward)')
  assert.match(hint, /GitHub has saves/)
  assert.match(hint, /nothing is lost/i, 'the sentence people need at that moment')
})

check('the errors worth explaining all have a sentence', () => {
  const cases = [
    'fatal: could not read Username for https://github.com: terminal prompts disabled',
    'Please tell me who you are.',
    'nothing to commit, working tree clean',
    'CONFLICT (content): Merge conflict in a.txt',
    'error: Your local changes to the following files would be overwritten by checkout',
    'fatal: The current branch main has no upstream branch',
    'fatal: unable to access https://github.com/: Could not resolve host: github.com',
    'fatal: Unable to create index.lock: another git process seems to be running',
  ]
  for (const text of cases) assert.ok(G.hintFor(text), `no plain sentence for: ${text}`)
  assert.equal(G.hintFor('some message git has never printed'), undefined)
})

// ------------------------------------------------------ against a real git

const repo = path.join(out, 'repo')
fs.mkdirSync(repo)
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()

git('init', '--initial-branch=main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'Test Person')
git('config', 'commit.gpgsign', 'false')

await checkAsync('a folder git is not watching is reported, not guessed at', async () => {
  const outside = path.join(out, 'not-a-repo')
  fs.mkdirSync(outside, { recursive: true })
  const status = await G.repoStatus(outside)
  assert.equal(status.root, '', 'no root means no repository, and every caller checks that first')
  assert.deepEqual(status.files, [])
})

await checkAsync('an untracked file is listed as new to git, and is not picked', async () => {
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
  const status = await G.repoStatus(repo)
  assert.ok(status.root, 'a folder git is watching answers with its root')
  assert.equal(status.files.length, 1)
  const [file] = status.files
  assert.equal(file.repoPath, 'a.txt')
  assert.equal(file.untracked, true)
  assert.equal(file.picked, '', 'nothing is picked until you pick it')
  assert.equal(status.branch, 'main')
})

await checkAsync('picking moves a file into the next save without touching disk', async () => {
  const before = fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')
  const res = await G.pick(repo, ['a.txt'])
  assert.equal(res.ok, true, res.error)
  const status = await G.repoStatus(repo)
  assert.equal(status.files[0].picked, 'A')
  assert.equal(status.files[0].untracked, false)
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), before, 'the file itself is untouched')
})

await checkAsync('unpicking works before the first save exists', async () => {
  // The case `git restore --staged` cannot do, and the reason this uses reset:
  // there is no HEAD yet to restore from, and picking-then-changing-your-mind
  // is the first thing anyone does in a new project.
  const res = await G.unpick(repo, ['a.txt'])
  assert.equal(res.ok, true, res.error)
  const status = await G.repoStatus(repo)
  assert.equal(status.files[0].untracked, true, 'back to being new to git')
  await G.pick(repo, ['a.txt'])
})

await checkAsync('a save with no message is refused before git is asked', async () => {
  const res = await G.save(repo, '   ')
  assert.equal(res.ok, false)
  assert.match(res.hint, /saying what it is/)
})

await checkAsync('saving keeps the picked files and clears the list', async () => {
  const res = await G.save(repo, 'first save')
  assert.equal(res.ok, true, res.error)
  const status = await G.repoStatus(repo)
  assert.deepEqual(status.files, [], 'nothing is different from the last save any more')
  assert.ok(status.head, 'and there is now a save to be sitting on')
})

await checkAsync('with nowhere to send to, no save is singled out as unsent', async () => {
  // The band says "this project has no copy anywhere else" once. Marking every
  // row as well would be the same sentence, repeated per save.
  const status = await G.repoStatus(repo)
  assert.equal(status.hasRemote, false)
  assert.deepEqual(status.unsent, [])
})

await checkAsync('the two halves of a part-picked file are told apart', async () => {
  // Pick one change, then make another. Git's whole point here is that these
  // are two different things, and a pane that showed one number would be lying
  // about what the next save contains.
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
  await G.pick(repo, ['a.txt'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n')

  const status = await G.repoStatus(repo)
  assert.equal(status.files.length, 1)
  assert.equal(status.files[0].picked, 'M', 'part of it is going into the next save')
  assert.equal(status.files[0].changed, 'M', 'and part of it is not')

  const picked = await G.fileDiff(repo, 'a.txt', { picked: true })
  const notPicked = await G.fileDiff(repo, 'a.txt', {})
  assert.match(picked, /\+two/)
  assert.ok(!/\+three/.test(picked), 'the picked half must not show the change made after picking')
  assert.match(notPicked, /\+three/)
})

await checkAsync('a rename keeps both names', async () => {
  await G.save(repo, 'second save')
  git('mv', 'a.txt', 'b.txt')
  const status = await G.repoStatus(repo)
  const [file] = status.files
  assert.equal(file.repoPath, 'b.txt')
  assert.equal(file.picked, 'R')
  assert.equal(file.from, 'a.txt', 'where it came from, which is the whole content of a rename')
  await G.save(repo, 'third save')
})

await checkAsync('the list of saves comes back newest first, with its shape', async () => {
  const commits = await G.history(repo)
  assert.equal(commits.length, 3)
  assert.equal(commits[0].subject, 'third save')
  assert.equal(commits[2].subject, 'first save')
  assert.equal(commits[2].parents.length, 0, 'the oldest came from nothing')
  assert.equal(commits[0].parents[0], commits[1].sha, 'and each one points at the one before it')
  assert.equal(commits[0].author, 'Test Person')
  assert.ok(commits[0].at > 0)
  assert.ok(commits[0].refs.some((r) => r.kind === 'head' && r.name === 'main'), 'HEAD is where you are')
})

await checkAsync('a message with blank lines in it survives the round trip', async () => {
  // The reason the log format uses its own separators rather than newlines.
  fs.writeFileSync(path.join(repo, 'c.txt'), 'x\n')
  await G.pick(repo, ['c.txt'])
  await G.save(repo, 'subject line\n\nA body with a blank line above it.\n\nAnd another.')
  const [newest] = await G.history(repo)
  assert.equal(newest.subject, 'subject line')
  assert.match(newest.body, /blank line above it/)
  assert.match(newest.body, /And another\./)
})

await checkAsync('starting a line of saves puts you on it, changing nothing else', async () => {
  const before = await G.history(repo)
  const res = await G.startBranch(repo, 'side')
  assert.equal(res.ok, true, res.error)
  const status = await G.repoStatus(repo)
  assert.equal(status.branch, 'side')
  assert.deepEqual((await G.history(repo)).map((c) => c.sha), before.map((c) => c.sha), 'no save was made')
})

await checkAsync('the picture of a real fork and a real merge is two columns wide', async () => {
  fs.writeFileSync(path.join(repo, 'side.txt'), 'side\n')
  await G.pick(repo, ['side.txt'])
  await G.save(repo, 'a save on the side line')

  git('switch', 'main')
  fs.writeFileSync(path.join(repo, 'main.txt'), 'main\n')
  await G.pick(repo, ['main.txt'])
  await G.save(repo, 'a save on the main line')
  git('merge', '--no-ff', 'side', '-m', 'glue the side line back in')

  const commits = await G.history(repo)
  const rows = Graph.layoutGraph(commits)
  assert.equal(commits[0].parents.length, 2, 'the newest save is a join-up save')
  assert.equal(rows[0].out.length, 2, 'so the picture forks below it')
  assert.ok(Graph.graphWidth(rows) >= 2, 'and needs a second column to draw')
  assert.ok(
    rows.some((r) => r.in.length > 1),
    'and somewhere below, the two columns come back together'
  )
})

await checkAsync('branches are listed with which one you are on', async () => {
  const branches = await G.branches(repo)
  const names = branches.map((b) => b.name).sort()
  assert.deepEqual(names, ['main', 'side'])
  const current = branches.find((b) => b.current)
  assert.equal(current.name, 'main')
  assert.equal(branches.every((b) => !b.remote), true, 'none of these are on GitHub')
  assert.ok(branches.every((b) => b.head && b.at > 0))
})

await checkAsync('going to another line of saves is refused rather than destructive', async () => {
  // A file that only exists on one line, changed but not saved, is the case
  // where git protects you — and the case where a client that forced it would
  // lose work. This asserts we do not force it.
  fs.writeFileSync(path.join(repo, 'main.txt'), 'changed and not saved\n')
  const res = await G.goTo(repo, 'side')
  const status = await G.repoStatus(repo)
  if (res.ok) {
    // Git carried the change across, which it does when the file is the same on
    // both lines. Nothing was lost either way, which is the thing under test.
    assert.match(fs.readFileSync(path.join(repo, 'main.txt'), 'utf8'), /changed and not saved/)
    assert.equal(status.branch, 'side')
    git('switch', 'main')
  } else {
    assert.equal(status.branch, 'main', 'a refusal leaves you where you were')
    assert.ok(res.hint, 'and says in plain words what it protected')
  }
})

await checkAsync('a save on any line GitHub has not got is marked, not just the one you are on', async () => {
  // A bare repository standing in for GitHub, so this exercises the real
  // push/track path rather than a fabricated remote.
  // The check above deliberately left an unsaved change behind; it would block
  // the switching this one does.
  git('checkout', '--', '.')
  const bare = path.join(out, 'origin.git')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', bare], { encoding: 'utf8', windowsHide: true })
  git('remote', 'add', 'origin', bare)
  git('switch', 'main')
  git('push', '--quiet', '--set-upstream', 'origin', 'main')

  let status = await G.repoStatus(repo)
  assert.equal(status.hasRemote, true)
  assert.deepEqual(status.unsent, [], 'everything reachable was just sent')

  // One save on a *different* line, which the ahead count for `main` will
  // never mention — and which is exactly as absent from GitHub.
  git('switch', 'side')
  fs.writeFileSync(path.join(repo, 'only-here.txt'), 'x\n')
  await G.pick(repo, ['only-here.txt'])
  await G.save(repo, 'a save on a line nobody sent')
  git('switch', 'main')

  status = await G.repoStatus(repo)
  assert.equal(status.ahead, 0, 'the line you are on is level, so the headline says nothing')
  assert.ok(status.unsent.length > 0, 'but the save on the other line is still only on this machine')
})

await checkAsync('a save that stopped part-way is noticed and reported', async () => {
  // A merge conflict left sitting there: the state where "save" would mean
  // something other than what the button says, so both panes refuse.
  // The check above may have left an unsaved change behind — deliberately, since
  // that is what it was testing — and it would block the switch below.
  git('checkout', '--', '.')
  git('switch', 'side')
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'from the side line\n')
  await G.pick(repo, ['clash.txt'])
  await G.save(repo, 'side version')
  git('switch', 'main')
  fs.writeFileSync(path.join(repo, 'clash.txt'), 'from the main line\n')
  await G.pick(repo, ['clash.txt'])
  await G.save(repo, 'main version')

  try {
    git('merge', 'side')
  } catch {
    /* the conflict is the point */
  }
  const status = await G.repoStatus(repo)
  assert.equal(status.inProgress, 'merge')
  assert.ok(
    status.files.some((f) => f.conflicted),
    'and the file git is asking about is marked as a question, not as a change'
  )
  git('merge', '--abort')
})

console.log(`\n${passed} checks passed`)
