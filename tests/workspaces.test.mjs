// The workspace document: migration, and the row model the sidebar draws from.
//
// Worth its own suite because this is the one piece of state that is *already
// on disk* for every user — a normalisation that drops a field or a group that
// swallows its members is data loss, not a rendering bug.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-workspaces-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

// state.ts reaches for the timer functions off `window` and for the injected
// backend adapter. Neither exists outside a webview, and neither is what is
// under test, so both are stubbed rather than worked around.
globalThis.window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
}

await build({
  entryPoints: {
    state: 'src/renderer/state.ts',
    backend: 'src/backend/index.ts',
    palette: 'src/renderer/ui/palette.ts',
    markdown: 'src/renderer/markdown.ts',
    wsl: 'src/shared/wsl.ts',
    types: 'src/shared/types.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  // Shared so the store's `backend()` and the test's `setBackend()` are the
  // same module instance; bundled separately they would be two.
  splitting: true,
})

const { store, shellFor, paneLabel, tabLabel } = await import(`file://${out}/state.js`)
const { setBackend } = await import(`file://${out}/backend.js`)
const { PANE_KINDS } = await import(`file://${out}/types.js`)

let saved = null
setBackend({
  loadState: async () => pending,
  saveState: async (s) => {
    saved = s
  },
  onExternalStateChange: () => () => {},
})

let pending = {}
const load = async (doc) => {
  pending = doc
  await store.load()
}

let passed = 0
const check = async (name, fn) => {
  await fn()
  passed++
  console.log('  ok', name)
}

/** A workspace as it appears in a v2 file: no groups, no groupId. */
const ws = (id, name) => ({
  id,
  name,
  cwd: 'C:\\Projects',
  color: '#888888',
  tabs: [],
  activeTabId: null,
})

/** A tab with one terminal pane in it. */
const tab = (id) => ({
  id,
  customTitle: null,
  panes: [{ id: `${id}-p`, cwd: 'C:\\Projects', autoTitle: '', shell: 'powershell' }],
  layout: { kind: 'leaf', paneId: `${id}-p` },
  activePaneId: `${id}-p`,
})

/** Drawn order with nesting shown as indentation, e.g. "  child". */
const names = (rows) => rows.map((r) => '  '.repeat(r.depth) + r.workspace.name)

// ------------------------------------------------------------------ migration
console.log('Workspace document migration')

await check('a v2 file comes back untouched and all top-level', async () => {
  await load({ version: 2, workspaces: [ws('a', 'dev'), ws('b', 'audioDev')] })
  assert.deepEqual(
    store.workspaces.map((w) => w.name),
    ['dev', 'audioDev']
  )
  assert.equal(store.workspaces[0].parentId, null)
  assert.deepEqual(names(store.sidebarRows()), ['dev', 'audioDev'])
})

await check('a v1 group becomes a workspace holding its members', async () => {
  // Groups were a separate entity for one release. A sidebar arranged with them
  // must come back arranged the same way, with one concept in it instead of two.
  await load({
    version: 3,
    groups: [{ id: 'g1', name: 'Audio', collapsed: true }],
    workspaces: [{ ...ws('a', 'iaEffect'), groupId: 'g1' }, ws('b', 'loose')],
  })
  assert.deepEqual(names(store.sidebarRows(true)), ['Audio', '  iaEffect', 'loose'])
  const parent = store.workspaces.find((w) => w.name === 'Audio')
  assert.equal(parent.collapsed, true)
  // The stand-in needs somewhere for its own terminals to start.
  assert.equal(parent.cwd, 'C:\\Projects')
})

await check('a parent that does not exist is cut back to the top level', async () => {
  await load({ version: 3, workspaces: [{ ...ws('a', 'orphan'), parentId: 'missing' }] })
  assert.equal(store.workspaces[0].parentId, null)
  // The point: it is still drawn. An unpruned link is never walked, so the
  // workspace would be absent from the sidebar entirely.
  assert.deepEqual(names(store.sidebarRows()), ['orphan'])
})

await check('a cycle is broken rather than looped over', async () => {
  await load({
    version: 3,
    workspaces: [
      { ...ws('a', 'one'), parentId: 'b' },
      { ...ws('b', 'two'), parentId: 'a' },
    ],
  })
  // One link is cut, so the pair becomes a parent and a child rather than a
  // loop. What matters is that both are still drawn — an unbroken cycle is
  // never walked at all, and they would vanish from the sidebar together.
  assert.deepEqual(
    names(store.sidebarRows())
      .map((n) => n.trim())
      .sort(),
    ['one', 'two']
  )
})

await check('a pane kind this build has never heard of becomes a terminal', async () => {
  // Both builds share one workspace file, so a newer one may have written a
  // kind this build does not know. A terminal is the honest fallback: the
  // pane keeps its place and you get a shell, not an empty box.
  const tab = (kind) => ({
    id: 't1',
    panes: [{ id: 'p1', kind, cwd: 'C:\\Projects', autoTitle: '', shell: 'powershell' }],
    layout: { kind: 'leaf', paneId: 'p1' },
    activePaneId: 'p1',
  })
  await load({ version: 3, workspaces: [{ ...ws('a', 'dev'), tabs: [tab('hologram')] }] })
  assert.equal(store.workspaces[0].tabs[0].panes[0].kind, 'terminal')

  // A kind we *do* know, under the name it used to have: the editor pane was
  // called `notes` back when it could only ever open one file.
  await load({ version: 3, workspaces: [{ ...ws('a', 'dev'), tabs: [tab('notes')] }] })
  assert.equal(store.workspaces[0].tabs[0].panes[0].kind, 'editor')

  await load({ version: 3, workspaces: [{ ...ws('a', 'dev'), tabs: [tab('editor')] }] })
  assert.equal(store.workspaces[0].tabs[0].panes[0].kind, 'editor')
})

// -------------------------------------------------------------- new tabs
console.log('New tabs')

/**
 * What a listener sees the instant it is told a tab was added — which is when
 * the pane is built, so a field missing here is missing for good.
 */
const paneAtFirstSight = (workspaceId, add) => {
  let seen
  const off = store.subscribe(() => {
    seen ??= store.workspaces.find((w) => w.id === workspaceId)?.tabs.at(-1)?.panes[0]
  })
  add()
  off()
  return seen
}

await check('an editor tab carries its file before anyone is told', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev')] })
  const file = 'C:\\Projects\\dev\\thing.ts'
  const pane = paneAtFirstSight('a', () => store.addTabWith('a', 'editor', { file }))
  assert.equal(pane.kind, 'editor')
  // Set after the tab was announced, this was the project note instead: the
  // editor had already been built, and one with no file opens the note.
  assert.equal(pane.file, file)
})

await check('an editor tab asked for no file still asks for the note', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev')] })
  const pane = paneAtFirstSight('a', () => store.addTabWith('a', 'editor', {}))
  // Absent, not empty: absent is what sends the pane to the workspace's
  // NOTES.md, where an empty string would mean "untitled, nowhere to write".
  assert.equal(pane.file, undefined)
})

await check('a compare tab carries both sides', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev')] })
  const pane = paneAtFirstSight('a', () =>
    store.addTabWith('a', 'compare', { compareLeft: 'C:\\l.txt', compareRight: 'C:\\r.txt' })
  )
  assert.equal(pane.compareLeft, 'C:\\l.txt')
  assert.equal(pane.compareRight, 'C:\\r.txt')
})

// ------------------------------------------------------------------- labels
console.log('Labels')

await check('an editor tab is named for its file, not its path', () => {
  const pane = (over) => ({ id: 'p', kind: 'editor', cwd: 'C:\\p', autoTitle: '', ...over })
  assert.equal(paneLabel(pane({ file: 'C:\\Projects\\dev\\ia_workspaces\\NOTES.md' })), 'e: NOTES.md')
  // Forward slashes too: a path can arrive either way on Windows.
  assert.equal(paneLabel(pane({ file: 'C:/Projects/dev/app.json' })), 'e: app.json')
  assert.equal(paneLabel(pane({ file: 'bare.txt' })), 'e: bare.txt')
  // A trailing separator must not make the name empty.
  assert.equal(paneLabel(pane({ file: 'C:\\a\\b\\' })), 'e: b')
  // A tab with no file yet says so rather than naming a file it has not opened.
  // Lower case like every other tab name — the strip is the app's own furniture
  // and it reads as one thing only if it is consistent about that.
  assert.equal(paneLabel(pane({})), 'e: untitled')
  // A name the user typed always wins.
  assert.equal(paneLabel(pane({ file: 'C:\\x\\y.md', customTitle: 'Scratch' })), 'Scratch')
})

await check('a reader tab is named for its file too', () => {
  const pane = { id: 'p', kind: 'reader', cwd: 'C:\\p', autoTitle: '', file: 'C:\\a\\b\\read.me' }
  assert.equal(paneLabel(pane), 'read.me')
})

await check('the tab takes its name from the active pane', () => {
  const pane = { id: 'p1', kind: 'editor', cwd: 'C:\\p', autoTitle: '', file: 'C:\\a\\one.ts' }
  const tab = {
    id: 't',
    customTitle: null,
    panes: [pane],
    layout: { kind: 'leaf', paneId: 'p1' },
    activePaneId: 'p1',
  }
  assert.equal(tabLabel(tab), 'e: one.ts')
  // A split says how many panes it holds, after the name.
  assert.equal(tabLabel({ ...tab, panes: [pane, { ...pane, id: 'p2' }] }), 'e: one.ts (2)')
})

// ----------------------------------------------------------------- row model
console.log('Sidebar rows')

const nested = () => ({
  version: 3,
  workspaces: [
    ws('p', 'parent'),
    { ...ws('c1', 'child one'), parentId: 'p' },
    { ...ws('c2', 'child two'), parentId: 'p' },
    ws('x', 'other'),
  ],
})

await check('children are drawn under their parent, indented', async () => {
  await load(nested())
  assert.deepEqual(names(store.sidebarRows()), ['parent', '  child one', '  child two', 'other'])
})

await check('nesting goes deeper than one level', async () => {
  await load({
    version: 3,
    workspaces: [
      ws('a', 'top'),
      { ...ws('b', 'middle'), parentId: 'a' },
      { ...ws('c', 'bottom'), parentId: 'b' },
    ],
  })
  assert.deepEqual(names(store.sidebarRows()), ['top', '  middle', '    bottom'])
})

await check('a folded parent hides its children but stays listed', async () => {
  const doc = nested()
  doc.workspaces[0].collapsed = true
  await load(doc)
  assert.deepEqual(names(store.sidebarRows()), ['parent', 'other'])
  // ...and the rail ignores the fold, or those workspaces would be unreachable.
  assert.deepEqual(names(store.sidebarRows(true)), [
    'parent',
    '  child one',
    '  child two',
    'other',
  ])
})

await check('only a row with children reports having them', async () => {
  await load(nested())
  const rows = store.sidebarRows()
  assert.equal(rows[0].hasChildren, true)
  assert.equal(rows[1].hasChildren, false)
})

// ------------------------------------------------------------------ mutation
console.log('Nesting')

await check('nesting moves the workspace under its new parent', async () => {
  await load(nested())
  store.setWorkspaceParent('x', 'p')
  assert.deepEqual(names(store.sidebarRows()), [
    'parent',
    '  child one',
    '  child two',
    '  other',
  ])
})

await check('a whole subtree moves with the workspace', async () => {
  await load({
    version: 3,
    workspaces: [ws('a', 'first'), ws('b', 'second'), { ...ws('c', 'carried'), parentId: 'b' }],
  })
  store.setWorkspaceParent('b', 'a')
  assert.deepEqual(names(store.sidebarRows()), ['first', '  second', '    carried'])
})

await check('a workspace cannot be nested inside its own child', async () => {
  await load(nested())
  store.setWorkspaceParent('p', 'c1')
  // Refused: the subtree would detach from the tree and vanish from the sidebar.
  assert.deepEqual(names(store.sidebarRows()), ['parent', '  child one', '  child two', 'other'])
})

await check('lifting to the top level leaves the children behind', async () => {
  await load(nested())
  store.setWorkspaceParent('c1', null)
  assert.deepEqual(names(store.sidebarRows()), ['parent', '  child two', 'other', 'child one'])
})

await check('gaining a child opens a folded parent', async () => {
  const doc = nested()
  doc.workspaces[0].collapsed = true
  await load(doc)
  store.setWorkspaceParent('x', 'p')
  // Otherwise the workspace you just dropped disappears without explanation.
  assert.equal(store.workspaces.find((w) => w.id === 'p').collapsed, false)
})

// --------------------------------------------------------------- reordering
//
// Dragging a workspace is the oldest interaction in the sidebar and the drop
// handler was rewritten when groups arrived, so the ordering it produces is
// pinned here rather than left to be noticed by hand.
console.log('Reordering')

await check('a workspace can be dragged down the list', async () => {
  await load({ version: 3, workspaces: [ws('a', 'one'), ws('b', 'two'), ws('c', 'three')] })
  store.moveWorkspace(0, 2)
  assert.deepEqual(names(store.sidebarRows()), ['two', 'three', 'one'])
})

await check('a workspace can be dragged up the list', async () => {
  await load({ version: 3, workspaces: [ws('a', 'one'), ws('b', 'two'), ws('c', 'three')] })
  store.moveWorkspace(2, 0)
  assert.deepEqual(names(store.sidebarRows()), ['three', 'one', 'two'])
})

await check('reordering keeps a parent with its children', async () => {
  await load(nested())
  store.moveWorkspace(3, 0)
  assert.deepEqual(names(store.sidebarRows()), ['other', 'parent', '  child one', '  child two'])
})

// -------------------------------------------------------- the workspace root
//
// The root and the docked tree's folder are two values on purpose: only
// "Change folder…" moves the root, and browsing the tree moves only the tree.
console.log('Workspace root')

await check('the root moves, and nothing else does', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev'), ws('b', 'other')] })
  store.setWorkspaceCwd('a', 'C:\\Projects\\dev\\ia_workspaces')
  assert.equal(store.workspaces[0].cwd, 'C:\\Projects\\dev\\ia_workspaces')
  assert.equal(store.workspaces[1].cwd, 'C:\\Projects')
})

await check('browsing the tree leaves the root where it was', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev')] })
  store.setTreeCwd('a', 'C:\\Projects\\dev\\ia_workspaces\\src')
  assert.equal(store.workspaces[0].treeCwd, 'C:\\Projects\\dev\\ia_workspaces\\src')
  assert.equal(store.workspaces[0].cwd, 'C:\\Projects')
})

await check('a tree back at the root remembers nothing extra', async () => {
  await load({ version: 3, workspaces: [ws('a', 'dev')] })
  store.setTreeCwd('a', 'C:\\Projects\\dev')
  store.setTreeCwd('a', 'C:\\Projects')
  assert.equal(store.workspaces[0].treeCwd, undefined)
})

await check('moving the root takes the tree with it', async () => {
  await load({
    version: 3,
    workspaces: [{ ...ws('a', 'dev'), treeCwd: 'C:\\Projects\\dev\\ia_workspaces\\src' }],
  })
  assert.equal(store.workspaces[0].treeCwd, 'C:\\Projects\\dev\\ia_workspaces\\src')
  store.setWorkspaceCwd('a', 'C:\\somewhere\\else')
  // The remembered folder was inside the old root; keeping it would leave the
  // tree pointing at the project you just navigated away from.
  assert.equal(store.workspaces[0].treeCwd, undefined)
})

// ------------------------------------------------------------- moving tabs
//
// Dragging a tab onto another workspace's sidebar row. The panes come with it
// and keep running; only the two active-tab pointers need repairing.
console.log('Moving tabs between workspaces')

const withTabs = () => ({
  version: 3,
  workspaces: [
    { ...ws('a', 'source'), tabs: [tab('t1'), tab('t2')], activeTabId: 't1' },
    { ...ws('b', 'target'), tabs: [tab('t3')], activeTabId: 't3' },
  ],
})

await check('a tab moves to the workspace it was dropped on', async () => {
  await load(withTabs())
  assert.equal(store.moveTabToWorkspace('t1', 'b'), true)
  assert.deepEqual(
    store.workspaces.find((w) => w.id === 'a').tabs.map((t) => t.id),
    ['t2']
  )
  assert.deepEqual(
    store.workspaces.find((w) => w.id === 'b').tabs.map((t) => t.id),
    ['t3', 't1']
  )
})

await check('the source picks a new active tab, the target shows what it gained', async () => {
  await load(withTabs())
  store.moveTabToWorkspace('t1', 'b')
  // 't1' was what the source was showing, so it has to land on something else.
  assert.equal(store.workspaces.find((w) => w.id === 'a').activeTabId, 't2')
  assert.equal(store.workspaces.find((w) => w.id === 'b').activeTabId, 't1')
  assert.equal(store.state.activeWorkspaceId, 'b')
})

await check('moving the last tab out leaves the source with none', async () => {
  await load({
    version: 3,
    workspaces: [
      { ...ws('a', 'source'), tabs: [tab('only')], activeTabId: 'only' },
      ws('b', 'target'),
    ],
  })
  store.moveTabToWorkspace('only', 'b')
  const source = store.workspaces.find((w) => w.id === 'a')
  assert.deepEqual(source.tabs, [])
  assert.equal(source.activeTabId, null)
})

await check('a move to nowhere, or onto itself, is refused', async () => {
  await load(withTabs())
  assert.equal(store.moveTabToWorkspace('t1', 'a'), false)
  assert.equal(store.moveTabToWorkspace('missing', 'b'), false)
  assert.equal(store.moveTabToWorkspace('t1', 'missing'), false)
})

// ----------------------------------------------------------------------- wsl
//
// The one piece of translation a WSL workspace needs. Everything else in the
// app keeps speaking Windows paths, so if this is wrong the failure is a pane
// that silently opens somewhere else.
console.log('WSL paths')
const { parseWslPath, toWslSharePath, isWslPath } = await import(`file://${out}/wsl.js`)

await check('reads a distro and Linux path out of a share path', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj'), {
    distro: 'Ubuntu-22.04',
    path: '/home/me/proj',
  })
  // \\wsl$\ is the older spelling of the same share and still resolves.
  assert.deepEqual(parseWslPath('\\\\wsl$\\Ubuntu\\srv'), { distro: 'Ubuntu', path: '/srv' })
  // Case-insensitive, like the rest of Windows path handling.
  assert.equal(parseWslPath('\\\\WSL.LOCALHOST\\Ubuntu\\x').distro, 'Ubuntu')
})

await check('a distro root with no tail is the Linux root', () => {
  assert.deepEqual(parseWslPath('\\\\wsl.localhost\\Ubuntu'), { distro: 'Ubuntu', path: '/' })
})

await check('an ordinary Windows path is not a WSL path', () => {
  assert.equal(parseWslPath('C:\\Projects\\dev'), null)
  assert.equal(isWslPath('C:\\Projects'), false)
  // A UNC share that is not WSL must not be mistaken for one.
  assert.equal(parseWslPath('\\\\server\\share\\file'), null)
})

await check('the round trip returns the path it started with', () => {
  const share = toWslSharePath('Ubuntu', '/home/me/proj')
  assert.equal(share, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')
  assert.deepEqual(parseWslPath(share), { distro: 'Ubuntu', path: '/home/me/proj' })
})

// ------------------------------------------------- dropping a tab onto a pane
console.log('Dropping a tab into a pane')

/** A tab with several panes, laid out along one axis. */
const splitTab = (id, count, direction = 'row') => ({
  id,
  customTitle: null,
  panes: Array.from({ length: count }, (_, i) => ({
    id: `${id}-p${i}`,
    cwd: 'C:\\Projects',
    autoTitle: '',
    shell: 'powershell',
  })),
  layout: {
    kind: 'split',
    direction,
    sizes: Array.from({ length: count }, () => 1 / count),
    children: Array.from({ length: count }, (_, i) => ({ kind: 'leaf', paneId: `${id}-p${i}` })),
  },
  activePaneId: `${id}-p0`,
})

const twoTabs = () => ({
  version: 2,
  workspaces: [{ ...ws('w1', 'one'), tabs: [tab('a'), tab('b')], activeTabId: 'a' }],
  activeWorkspaceId: 'w1',
})

await check('a tab dropped on a pane splits it and stops being a tab', async () => {
  await load(twoTabs())
  assert.equal(store.dropTabIntoPane('a', 'b-p', 'right'), true)

  const w = store.workspaces[0]
  assert.deepEqual(
    w.tabs.map((t) => t.id),
    ['b']
  )
  const target = w.tabs[0]
  assert.deepEqual(
    target.panes.map((p) => p.id),
    ['b-p', 'a-p']
  )
  assert.equal(target.layout.kind, 'split')
  assert.equal(target.layout.direction, 'row')
  assert.deepEqual(
    target.layout.children.map((c) => c.paneId),
    ['b-p', 'a-p']
  )
})

await check('which edge you drop on decides the side and the axis', async () => {
  for (const [side, direction, order] of [
    ['left', 'row', ['a-p', 'b-p']],
    ['right', 'row', ['b-p', 'a-p']],
    ['top', 'column', ['a-p', 'b-p']],
    ['bottom', 'column', ['b-p', 'a-p']],
  ]) {
    await load(twoTabs())
    store.dropTabIntoPane('a', 'b-p', side)
    const layout = store.workspaces[0].tabs[0].layout
    assert.equal(layout.direction, direction, side)
    assert.deepEqual(
      layout.children.map((c) => c.paneId),
      order,
      side
    )
  }
})

await check('a split tab brings its whole arrangement with it', async () => {
  await load({
    version: 2,
    workspaces: [
      { ...ws('w1', 'one'), tabs: [splitTab('a', 3, 'column'), tab('b')], activeTabId: 'a' },
    ],
    activeWorkspaceId: 'w1',
  })
  assert.equal(store.dropTabIntoPane('a', 'b-p', 'right'), true)

  const target = store.workspaces[0].tabs[0]
  assert.equal(target.panes.length, 4)
  // The graft is the source's own layout, untouched — not three panes appended.
  const grafted = target.layout.children[1]
  assert.equal(grafted.kind, 'split')
  assert.equal(grafted.direction, 'column')
  assert.deepEqual(
    grafted.children.map((c) => c.paneId),
    ['a-p0', 'a-p1', 'a-p2']
  )
})

await check('the dragged tab is what ends up focused', async () => {
  await load(twoTabs())
  store.dropTabIntoPane('a', 'b-p', 'right')
  assert.equal(store.workspaces[0].tabs[0].activePaneId, 'a-p')
  assert.equal(store.workspaces[0].activeTabId, 'b')
})

await check('a tab cannot be dropped into itself', async () => {
  await load(twoTabs())
  assert.equal(store.dropTabIntoPane('a', 'a-p', 'right'), false)
  assert.equal(store.workspaces[0].tabs.length, 2)
})

await check('the source workspace picks a new active tab when it loses one', async () => {
  await load({
    version: 2,
    workspaces: [
      { ...ws('w1', 'one'), tabs: [tab('a')], activeTabId: 'a' },
      { ...ws('w2', 'two'), tabs: [tab('b')], activeTabId: 'b' },
    ],
    activeWorkspaceId: 'w1',
  })
  // Across workspaces too: the panes move, the source is left with none.
  assert.equal(store.dropTabIntoPane('a', 'b-p', 'bottom'), true)
  assert.equal(store.workspaces[0].tabs.length, 0)
  assert.equal(store.workspaces[0].activeTabId, null)
  assert.equal(store.workspaces[1].tabs[0].panes.length, 2)
  assert.equal(store.state.activeWorkspaceId, 'w2')
})

await check('a pane dragged to the tab bar becomes a tab of its own', async () => {
  await load({
    version: 2,
    workspaces: [{ ...ws('w1', 'one'), tabs: [splitTab('a', 3)], activeTabId: 'a' }],
    activeWorkspaceId: 'w1',
  })
  assert.equal(store.extractPaneToTab('a-p1', 0), true)

  const w = store.workspaces[0]
  assert.equal(w.tabs.length, 2)
  // Dropped before the tab it came from, so it lands first.
  assert.equal(w.tabs[0].panes.length, 1)
  assert.equal(w.tabs[0].panes[0].id, 'a-p1')
  assert.equal(w.tabs[0].layout.kind, 'leaf')
  assert.equal(w.activeTabId, w.tabs[0].id)

  // What it left keeps the rest, with the split collapsed to what remains.
  assert.deepEqual(
    w.tabs[1].panes.map((p) => p.id),
    ['a-p0', 'a-p2']
  )
  assert.deepEqual(
    w.tabs[1].layout.children.map((c) => c.paneId),
    ['a-p0', 'a-p2']
  )
})

await check('lifting the second-to-last pane leaves a lone pane, not a split', async () => {
  await load({
    version: 2,
    workspaces: [{ ...ws('w1', 'one'), tabs: [splitTab('a', 2)], activeTabId: 'a' }],
    activeWorkspaceId: 'w1',
  })
  store.extractPaneToTab('a-p1')
  const source = store.workspaces[0].tabs.find((t) => t.id === 'a')
  assert.equal(source.layout.kind, 'leaf')
  assert.equal(source.layout.paneId, 'a-p0')
  assert.equal(source.activePaneId, 'a-p0')
})

await check('a pane already alone in its tab is refused', async () => {
  await load(twoTabs())
  // There is nothing to lift it out of; doing it would rebuild the same tab.
  assert.equal(store.extractPaneToTab('a-p'), false)
  assert.equal(store.workspaces[0].tabs.length, 2)
})

await check('the round trip gets you back where you started', async () => {
  await load(twoTabs())
  store.dropTabIntoPane('a', 'b-p', 'right')
  assert.equal(store.workspaces[0].tabs.length, 1)
  // The same pane, dragged back out: two tabs again, and the pane is the one
  // that went in — same id, so the same shell is still behind it.
  assert.equal(store.extractPaneToTab('a-p'), true)
  const w = store.workspaces[0]
  assert.equal(w.tabs.length, 2)
  assert.deepEqual(
    w.tabs.map((t) => t.panes.map((p) => p.id)),
    [['b-p'], ['a-p']]
  )
})

await check('a browser pane keeps its kind and page across a load', async () => {
  await load({
    version: 2,
    workspaces: [
      {
        ...ws('w1', 'one'),
        tabs: [
          {
            id: 't',
            customTitle: null,
            panes: [
              {
                id: 't-p',
                kind: 'browser',
                url: 'http://localhost:5173/x',
                cwd: 'C:\\Projects',
                autoTitle: '',
                shell: 'powershell',
              },
            ],
            layout: { kind: 'leaf', paneId: 't-p' },
            activePaneId: 't-p',
          },
        ],
        activeTabId: 't',
      },
    ],
    activeWorkspaceId: 'w1',
  })
  const pane = store.workspaces[0].tabs[0].panes[0]
  assert.equal(pane.kind, 'browser')
  assert.equal(pane.url, 'http://localhost:5173/x')
})

// --------------------------------------------------------- which shell a pane is
console.log('Which shell a pane runs')

const shellDoc = () => ({
  version: 4,
  workspaces: [
    { ...ws('w1', 'windows'), tabs: [], activeTabId: null },
    { ...ws('w2', 'linux'), shell: 'wsl', wslDistro: 'Ubuntu', tabs: [], activeTabId: null },
  ],
  activeWorkspaceId: 'w1',
  settings: { shell: 'powershell' },
})

/** What the spawn would actually launch for a pane. */
const resolve = (pane, workspaceId) =>
  shellFor(pane, store.workspaces.find((w) => w.id === workspaceId), store.settings)

await check('a tab in a WSL workspace runs WSL, not the global default', async () => {
  await load(shellDoc())
  const tab = store.addTab('w2')
  // The bug: every pane was stamped with settings.shell when it was made, so
  // the workspace's own choice was never consulted and a WSL workspace opened
  // PowerShell — which is why .sh scripts opened in an editor instead of running.
  assert.deepEqual(resolve(tab.panes[0], 'w2'), { shell: 'wsl', wslDistro: 'Ubuntu' })
  // And it records nothing of its own, so it keeps following the workspace.
  assert.equal(tab.panes[0].shell, undefined)
})

await check('a tab in an ordinary workspace follows the global default', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1')
  assert.deepEqual(resolve(tab.panes[0], 'w1'), { shell: 'powershell' })
})

await check('a tab can be given a shell of its own', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'wsl', { wslDistro: 'Debian' })
  assert.equal(tab.panes[0].shell, 'wsl', 'recorded, because it was chosen')
  assert.deepEqual(resolve(tab.panes[0], 'w1'), { shell: 'wsl', wslDistro: 'Debian' })
})

await check('a chosen shell survives its workspace changing', async () => {
  await load(shellDoc())
  const inherits = store.addTab('w1')
  const chosen = store.addTab('w1', undefined, 'terminal', 'cmd')

  store.setWorkspaceShell('w1', 'wsl', { wslDistro: 'Ubuntu' })

  // The ordinary tab follows its workspace…
  assert.deepEqual(resolve(store.tab(inherits.id).panes[0], 'w1'), {
    shell: 'wsl',
    wslDistro: 'Ubuntu',
  })
  // …and the one you made a cmd tab is still a cmd tab. This is the whole
  // point of the two being independent.
  assert.deepEqual(resolve(store.tab(chosen.id).panes[0], 'w1'), { shell: 'cmd' })
})

await check('reopening a pane as another shell records the choice', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1')
  assert.equal(tab.panes[0].shell, undefined, 'inherits to begin with')

  store.setPaneShell(tab.panes[0].id, 'cmd')

  const pane = store.tab(tab.id).panes[0]
  assert.equal(pane.shell, 'cmd', 'recorded, so the workspace cannot take it back')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'cmd' })
})

await check('reopening as WSL moves the pane into the distribution', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1')
  assert.equal(tab.panes[0].cwd, 'C:\\Projects')

  store.setPaneShell(tab.panes[0].id, 'wsl', { wslDistro: 'Ubuntu' })

  const pane = store.tab(tab.id).panes[0]
  // A Windows path means nothing to a distribution, so the pane lands at its
  // root rather than in a folder it cannot reach.
  assert.equal(pane.cwd, '\\\\wsl.localhost\\Ubuntu\\')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'wsl', wslDistro: 'Ubuntu' })
})

await check('reopening out of WSL brings the pane back to its workspace folder', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1')
  store.setPaneShell(tab.panes[0].id, 'wsl', { wslDistro: 'Ubuntu' })

  store.setPaneShell(tab.panes[0].id, 'powershell')

  const pane = store.tab(tab.id).panes[0]
  assert.equal(pane.cwd, 'C:\\Projects', 'not stranded in \\\\wsl.localhost')
  assert.equal(pane.wslDistro, undefined, 'a distribution it no longer runs in')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'powershell' })
})

await check('reopening within the same distribution keeps the folder', async () => {
  await load(shellDoc())
  const tab = store.addTab('w2')
  store.setPaneShell(tab.panes[0].id, 'wsl', { wslDistro: 'Ubuntu' })
  store.updatePaneMeta(tab.panes[0].id, { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj' })

  store.setPaneShell(tab.panes[0].id, 'wsl', { wslDistro: 'Ubuntu' })

  // Nothing changed about the world this pane is in, so sending it back to the
  // root would throw away the folder for no reason.
  assert.equal(store.tab(tab.id).panes[0].cwd, '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj')
})

await check('a WSL workspace can hold a WSL tab, a PowerShell tab and a cmd tab', async () => {
  await load(shellDoc())
  const inherited = store.addTab('w2')
  const powershell = store.addTab('w2', undefined, 'terminal', 'powershell')
  const cmd = store.addTab('w2', undefined, 'terminal', 'cmd')

  assert.deepEqual(resolve(inherited.panes[0], 'w2'), { shell: 'wsl', wslDistro: 'Ubuntu' })
  assert.deepEqual(resolve(powershell.panes[0], 'w2'), { shell: 'powershell' })
  assert.deepEqual(resolve(cmd.panes[0], 'w2'), { shell: 'cmd' })
})

await check('splitting copies the choice, not the resolved shell', async () => {
  await load(shellDoc())
  // An inheriting pane produces another that inherits, so both keep following.
  const plain = store.addTab('w2')
  assert.equal(store.splitPane(plain.id, 'row').shell, undefined)

  // A pane with its own shell produces another with the same one.
  const chosen = store.addTab('w2', undefined, 'terminal', 'cmd')
  assert.equal(store.splitPane(chosen.id, 'row').shell, 'cmd')
})

await check('an inheriting pane is moved out of a folder it no longer understands', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1')
  store.setWorkspaceShell('w1', 'wsl', { wslDistro: 'Ubuntu' })
  // A Windows path means nothing inside a distribution.
  assert.ok(store.tab(tab.id).panes[0].cwd.startsWith('\\\\wsl.localhost\\Ubuntu'))
})

await check('a pane with its own shell keeps its own folder', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'powershell')
  const before = store.tab(tab.id).panes[0].cwd
  store.setWorkspaceShell('w1', 'wsl', { wslDistro: 'Ubuntu' })
  // It is still a PowerShell tab, so C:\… is still a folder it understands.
  assert.equal(store.tab(tab.id).panes[0].cwd, before)
})

await check('panes written before v4 forget the shell that was stamped on them', async () => {
  // Every pane in an older document carries the global default, because that is
  // what the buggy code wrote. None of them is a decision, so all are dropped.
  await load({
    version: 3,
    workspaces: [
      {
        ...ws('w1', 'linux'),
        shell: 'wsl',
        wslDistro: 'Ubuntu',
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            customTitle: null,
            activePaneId: 't-p',
            panes: [{ id: 't-p', cwd: 'C:\\p', autoTitle: '', shell: 'powershell' }],
            layout: { kind: 'leaf', paneId: 't-p' },
          },
        ],
      },
    ],
    activeWorkspaceId: 'w1',
    settings: { shell: 'powershell' },
  })
  const pane = store.workspaces[0].tabs[0].panes[0]
  assert.equal(pane.shell, undefined, 'the stamped value is dropped')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'wsl', wslDistro: 'Ubuntu' })
})

await check('a chosen shell survives a save and load', async () => {
  await load(shellDoc())
  store.addTab('w2', undefined, 'terminal', 'powershell')
  store.addTab('w2')
  const doc = store.exportWorkspace('w2', new Date(0))
  store.importWorkspaceFile(doc)

  const loaded = store.workspaces.at(-1)
  assert.equal(loaded.tabs[0].panes[0].shell, 'powershell', 'the choice is kept')
  assert.equal(loaded.tabs[1].panes[0].shell, undefined, 'and so is the absence of one')
})

// ------------------------------------------------------- saving and loading
console.log('Saving and loading workspaces')

/** A document with a nested pair and a split tab, exercised repeatedly below. */
const nestedDoc = () => ({
  version: 2,
  workspaces: [
    {
      ...ws('w1', 'parent'),
      cwd: 'C:\\proj',
      color: '#7fb069',
      shell: 'pwsh',
      tabs: [{ ...splitTab('a', 2, 'column'), customTitle: 'build' }],
      activeTabId: 'a',
    },
    { ...ws('w2', 'child'), parentId: 'w1', cwd: 'C:\\proj\\sub', tabs: [tab('b')], activeTabId: 'b' },
    { ...ws('w3', 'unrelated'), tabs: [tab('c')], activeTabId: 'c' },
  ],
  activeWorkspaceId: 'w1',
})

await check('saving a workspace takes everything nested under it', async () => {
  await load(nestedDoc())
  const doc = store.exportWorkspace('w1', new Date(0))
  assert.equal(doc.kind, 'ia_workspaces/workspaces')
  assert.deepEqual(doc.workspaces.map((w) => w.name), ['parent', 'child'])
  // The child points at its parent by position in the file, not by id.
  assert.equal(doc.workspaces[1].parent, 0)
  assert.equal(doc.workspaces[0].parent, undefined)
})

await check('saving all takes all of them', async () => {
  await load(nestedDoc())
  assert.deepEqual(
    store.exportAll(new Date(0)).workspaces.map((w) => w.name),
    ['parent', 'child', 'unrelated']
  )
})

await check('layout, tabs, panes and settings survive the round trip', async () => {
  await load(nestedDoc())
  const doc = store.exportWorkspace('w1', new Date(0))
  const before = store.workspaces.length

  const result = store.importWorkspaceFile(doc)
  assert.equal(result.added, 2)
  const loaded = store.workspaces.slice(before)

  assert.equal(loaded[0].cwd, 'C:\\proj')
  assert.equal(loaded[0].color, '#7fb069')
  assert.equal(loaded[0].shell, 'pwsh')
  assert.equal(loaded[0].tabs[0].customTitle, 'build')
  assert.equal(loaded[0].tabs[0].panes.length, 2)
  assert.equal(loaded[0].tabs[0].layout.kind, 'split')
  assert.equal(loaded[0].tabs[0].layout.direction, 'column')
  // The nesting is rebuilt against the new ids.
  assert.equal(loaded[1].parentId, loaded[0].id)
})

await check('nothing already open is disturbed, and ids are all fresh', async () => {
  await load(nestedDoc())
  const doc = store.exportAll(new Date(0))
  const originals = store.workspaces.map((w) => w.id)

  store.importWorkspaceFile(doc)
  const ids = store.workspaces.map((w) => w.id)
  assert.equal(ids.length, 6)
  // The originals are still there, and nothing loaded reused an id.
  for (const id of originals) assert.ok(ids.includes(id))
  assert.equal(new Set(ids).size, 6)
})

await check('a name already in use gains a suffix and says so', async () => {
  await load(nestedDoc())
  const doc = store.exportWorkspace('w3', new Date(0))
  const result = store.importWorkspaceFile(doc)
  assert.equal(store.workspaces.at(-1).name, 'unrelated (2)')
  assert.match(result.notes.join(' '), /already open/)

  // And again, so the suffix keeps counting rather than colliding.
  store.importWorkspaceFile(doc)
  assert.equal(store.workspaces.at(-1).name, 'unrelated (3)')
})

await check('the same file loads twice without the two interfering', async () => {
  await load(nestedDoc())
  const doc = store.exportWorkspace('w1', new Date(0))
  store.importWorkspaceFile(doc)
  store.importWorkspaceFile(doc)
  const loaded = store.workspaces.slice(3)
  assert.equal(loaded.length, 4)
  // Each copy's child points at its own parent, not at the other copy's.
  assert.equal(loaded[1].parentId, loaded[0].id)
  assert.equal(loaded[3].parentId, loaded[2].id)
})

await check('a browser pane keeps its page through a save and load', async () => {
  await load({
    version: 2,
    workspaces: [
      {
        ...ws('w1', 'one'),
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            customTitle: null,
            activePaneId: 't-p',
            panes: [
              { id: 't-p', kind: 'browser', url: 'http://localhost:5173/x', cwd: 'C:\\p', autoTitle: '', shell: 'powershell' },
            ],
            layout: { kind: 'leaf', paneId: 't-p' },
          },
        ],
      },
    ],
    activeWorkspaceId: 'w1',
  })
  const doc = store.exportWorkspace('w1', new Date(0))
  store.importWorkspaceFile(doc)
  const pane = store.workspaces.at(-1).tabs[0].panes[0]
  assert.equal(pane.kind, 'browser')
  assert.equal(pane.url, 'http://localhost:5173/x')
})

// Every pane kind survives a reload.
//
// Not a hypothetical: the images pane was added to the `PaneKind` union but not
// to the runtime list the loader checks against, and a kind missing from that
// list is not rejected — it is read back as a terminal and then written back as
// one, so the tab is gone for good on the next save. The compiler cannot catch
// it, because a `Set<PaneKind>` is perfectly happy to be short. This is the
// check that does.
await check('every pane kind survives being written and read again', async () => {
  for (const kind of PANE_KINDS) {
    await load({
      version: 2,
      workspaces: [
        {
          ...ws('w1', 'one'),
          activeTabId: 't',
          tabs: [
            {
              id: 't',
              customTitle: null,
              activePaneId: 't-p',
              panes: [
                { id: 't-p', kind, cwd: 'C:\\p', autoTitle: '', shell: 'powershell' },
              ],
              layout: { kind: 'leaf', paneId: 't-p' },
            },
          ],
        },
      ],
      activeWorkspaceId: 'w1',
    })
    assert.equal(store.workspaces[0].tabs[0].panes[0].kind, kind, `${kind} did not survive a load`)
  }
})

await check('an images pane keeps its own arrangement through a save and load', async () => {
  await load({
    version: 2,
    workspaces: [
      {
        ...ws('w1', 'one'),
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            customTitle: null,
            activePaneId: 't-p',
            panes: [
              {
                id: 't-p',
                kind: 'images',
                cwd: 'C:\\p',
                autoTitle: '',
                shell: 'powershell',
                imageLayout: 'board',
                imageSort: 'random',
                imageSeed: 4242,
                imageRecursive: true,
                imageBoard: { 'C:\\p\\a.png': { x: 0.25, y: 0.5, w: 0.3 } },
              },
            ],
            layout: { kind: 'leaf', paneId: 't-p' },
          },
        ],
      },
    ],
    activeWorkspaceId: 'w1',
  })
  // The live document keeps everything, hand-placed positions included.
  assert.deepEqual(store.workspaces[0].tabs[0].panes[0].imageBoard['C:\\p\\a.png'], {
    x: 0.25,
    y: 0.5,
    w: 0.3,
  })

  const doc = store.exportWorkspace('w1', new Date(0))
  store.importWorkspaceFile(doc)
  const pane = store.workspaces.at(-1).tabs[0].panes[0]
  assert.equal(pane.kind, 'images')
  assert.equal(pane.imageLayout, 'board')
  assert.equal(pane.imageSort, 'random')
  // The seed especially: without it a shuffle you liked is a different shuffle
  // every time the file is opened.
  assert.equal(pane.imageSeed, 4242)
  assert.equal(pane.imageRecursive, true)
  // Board placements deliberately do not travel in a workspace file: they are
  // keyed by absolute path, and the file is meant to be committed and read on
  // another machine where those paths mean nothing.
  assert.equal(pane.imageBoard, undefined)
})

await check('a hand-edited board placement is dropped rather than trusted', async () => {
  await load({
    version: 2,
    workspaces: [
      {
        ...ws('w1', 'one'),
        activeTabId: 't',
        tabs: [
          {
            id: 't',
            customTitle: null,
            activePaneId: 't-p',
            panes: [
              {
                id: 't-p',
                kind: 'images',
                cwd: 'C:\\p',
                autoTitle: '',
                shell: 'powershell',
                imageSort: 'sideways',
                imageBoard: {
                  'C:\\p\\ok.png': { x: 0.1, y: 0.1, w: 0.2 },
                  'C:\\p\\nan.png': { x: 'yes', y: 0, w: 1 },
                  'C:\\p\\zero.png': { x: 0, y: 0, w: 0 },
                },
              },
            ],
            layout: { kind: 'leaf', paneId: 't-p' },
          },
        ],
      },
    ],
    activeWorkspaceId: 'w1',
  })
  const pane = store.workspaces[0].tabs[0].panes[0]
  // A NaN coordinate places one image nowhere and takes the layout with it; a
  // zero width is an image you can never grab again to fix.
  assert.deepEqual(Object.keys(pane.imageBoard), ['C:\\p\\ok.png'])
  assert.equal(pane.imageSort, undefined, 'an unknown sort falls back to the setting')
})

await check('a file that is not ours is refused, not half-loaded', async () => {
  await load(nestedDoc())
  const before = store.workspaces.length
  for (const bad of [null, 42, 'text', {}, { kind: 'something/else' }, { kind: 'ia_workspaces/workspaces', version: 1 }]) {
    assert.ok('error' in store.importWorkspaceFile(bad), JSON.stringify(bad))
  }
  assert.equal(store.workspaces.length, before)
})

await check('a file from a newer build is refused by version', async () => {
  await load(nestedDoc())
  const result = store.importWorkspaceFile({
    kind: 'ia_workspaces/workspaces',
    version: 99,
    workspaces: [{ name: 'x', cwd: 'C:\\', color: '#fff', tabs: [] }],
  })
  assert.match(result.error, /newer build/)
})

await check('saved weather places survive a load, and only the ones that are places', async () => {
  await load({
    version: 3,
    workspaces: [],
    settings: {
      weatherPlaces: [
        { place: 'Athens', lat: '37.9957', lon: '23.7378' },
        // Half a coordinate is a chip that would switch the blocks to nowhere.
        { place: 'Nowhere', lat: '', lon: '23' },
        { place: '  ', lat: '1', lon: '2' },
        { lat: '1', lon: '2' },
        'not a place',
        // The name is the identity, so the second Athens is not a second place.
        { place: 'athens', lat: '1', lon: '2' },
        { place: 'Berlin', lat: '52.52', lon: '13.405' },
      ],
    },
  })
  assert.deepEqual(
    store.settings.weatherPlaces.map((p) => p.place),
    ['Athens', 'Berlin']
  )
  assert.equal(store.settings.weatherPlaces[0].lat, '37.9957')
})

await check('a document written before saved places has none, and still loads', async () => {
  await load({ version: 3, workspaces: [], settings: { weatherPlace: 'Athens' } })
  assert.deepEqual(store.settings.weatherPlaces, [])
  assert.equal(store.settings.weatherPlace, 'Athens')
})

await check('a hand-edited file is repaired rather than trusted', async () => {
  await load(nestedDoc())
  const before = store.workspaces.length
  const result = store.importWorkspaceFile({
    kind: 'ia_workspaces/workspaces',
    version: 1,
    workspaces: [
      {
        name: 'broken',
        cwd: '',
        color: '',
        // Points forwards at itself, which is not a tree.
        parent: 0,
        tabs: [
          {
            customTitle: null,
            activePane: 99,
            panes: [
              { kind: 'nonsense', cwd: '', shell: 'not-a-shell' },
              { kind: 'terminal', cwd: 'C:\\ok', shell: 'cmd' },
            ],
            // Names a pane that is not in the list.
            layout: { kind: 'leaf', paneId: 'p7' },
          },
        ],
      },
    ],
  })
  assert.equal(result.added, 1)
  const w = store.workspaces.at(-1)
  assert.equal(w.parentId, null, 'a self-parent is cut')
  assert.ok(w.cwd, 'an empty cwd falls back')
  assert.equal(w.color, '#8f8f8f')
  assert.equal(w.tabs[0].panes[0].kind, 'terminal', 'an unknown kind becomes a terminal')
  // A shell we do not recognise is not a choice we can honour, so the pane goes
  // back to following its workspace rather than being pinned to a guess.
  assert.equal(w.tabs[0].panes[0].shell, undefined, 'an unknown shell is dropped')
  // The layout named a pane that does not exist, so it was rebuilt from the
  // panes — otherwise one of them would be invisible and unreachable.
  assert.equal(w.tabs[0].layout.kind, 'split')
  assert.equal(w.tabs[0].layout.children.length, 2)
  assert.ok(w.tabs[0].panes.some((p) => p.id === w.tabs[0].activePaneId))
  assert.equal(store.workspaces.length, before + 1)
})

// --------------------------------------------------------------------- ssh

await check('a tab can be opened on an ssh host', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'ssh', { sshHost: 'build01' })
  assert.equal(tab.panes[0].shell, 'ssh', 'recorded, because it was chosen')
  assert.deepEqual(resolve(tab.panes[0], 'w1'), { shell: 'ssh', sshHost: 'build01' })
})

await check('a workspace on a host passes it to panes that inherit', async () => {
  await load(shellDoc())
  store.setWorkspaceShell('w1', 'ssh', { sshHost: 'build01' })
  const tab = store.addTab('w1')
  assert.equal(tab.panes[0].shell, undefined, 'inherits, so records nothing of its own')
  assert.deepEqual(resolve(store.tab(tab.id).panes[0], 'w1'), {
    shell: 'ssh',
    sshHost: 'build01',
  })
})

await check('switching a pane from WSL to SSH forgets the distribution', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'wsl', { wslDistro: 'Ubuntu' })
  store.setPaneShell(tab.panes[0].id, 'ssh', { sshHost: 'build01' })
  const pane = store.tab(tab.id).panes[0]
  assert.equal(pane.wslDistro, undefined, 'a distro means nothing on a remote host')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'ssh', sshHost: 'build01' })
})

await check('leaving SSH forgets the host', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'ssh', { sshHost: 'build01' })
  store.setPaneShell(tab.panes[0].id, 'cmd')
  const pane = store.tab(tab.id).panes[0]
  assert.equal(pane.sshHost, undefined, 'or switching back would silently reuse it')
  assert.deepEqual(resolve(pane, 'w1'), { shell: 'cmd' })
})

await check('splitting an SSH pane gives another on the same host', async () => {
  await load(shellDoc())
  const tab = store.addTab('w1', undefined, 'terminal', 'ssh', { sshHost: 'build01' })
  const second = store.splitPane(tab.id, 'row')
  assert.deepEqual(resolve(second, 'w1'), { shell: 'ssh', sshHost: 'build01' })
})

await check('an ssh host survives a save and load', async () => {
  await load(shellDoc())
  store.setWorkspaceShell('w1', 'ssh', { sshHost: 'build01' })
  store.addTab('w1', undefined, 'terminal', 'ssh', { sshHost: 'other-box' })

  const file = JSON.parse(JSON.stringify(store.exportAll(new Date(0))))
  await load(shellDoc())
  store.importWorkspaceFile(file)

  const restored = store.workspaces.find((w) => w.shell === 'ssh')
  assert.equal(restored?.sshHost, 'build01', 'the workspace keeps its host')
  const pane = restored.tabs.flatMap((t) => t.panes).find((p) => p.sshHost === 'other-box')
  assert.equal(pane?.shell, 'ssh', 'and so does a pane that chose its own')
})

console.log(`\n${passed} checks passed`)
void saved
