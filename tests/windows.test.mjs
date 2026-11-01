// Several windows, one workspace document.
//
// Every window saves the whole document, so the rules that keep two of them
// from undoing each other live here: how a save is merged into what main holds
// (`merge3`, `StateHub`), and what main does to the document when windows open,
// close and trade tabs (`windowLayout`). All pure, so all tested without a
// window anywhere.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-windows-'))
await build({
  entryPoints: {
    merge: 'src/shared/merge3.ts',
    hub: 'src/main/stateHub.ts',
    layout: 'src/shared/windowLayout.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})
const { merge3 } = await import(`file://${out}/merge.js`)
const { StateHub } = await import(`file://${out}/hub.js`)
const L = await import(`file://${out}/layout.js`)

let passed = 0
const check = (name, fn) => {
  fn()
  passed++
  console.log('  ok', name)
}

const tab = (id, extra = {}) => ({ id, customTitle: null, panes: [{ id: `${id}-p` }], activePaneId: `${id}-p`, ...extra })
const ws = (id, tabs, extra = {}) => ({ id, name: id, tabs, activeTabId: tabs[0]?.id ?? null, ...extra })
const clone = (x) => structuredClone(x)

console.log('Merging two edits of one document')

check('a field changed on one side only takes that side', () => {
  const base = { a: 1, b: 1 }
  assert.deepEqual(merge3(base, { a: 2, b: 1 }, { a: 1, b: 3 }), { a: 2, b: 3 })
})

check('edits to different fields of the same record both survive', () => {
  const base = { workspaces: [ws('w', [tab('t')])] }
  const ours = clone(base)
  ours.workspaces[0].name = 'renamed'
  const theirs = clone(base)
  theirs.workspaces[0].tabs[0].customTitle = 'logs'
  const merged = merge3(base, ours, theirs)
  assert.equal(merged.workspaces[0].name, 'renamed')
  assert.equal(merged.workspaces[0].tabs[0].customTitle, 'logs')
})

check('a tab added on each side keeps both', () => {
  const base = { workspaces: [ws('w', [tab('a')])] }
  const ours = clone(base)
  ours.workspaces[0].tabs.push(tab('b'))
  const theirs = clone(base)
  theirs.workspaces[0].tabs.push(tab('c'))
  const ids = merge3(base, ours, theirs).workspaces[0].tabs.map((t) => t.id)
  assert.deepEqual(ids.sort(), ['a', 'b', 'c'])
})

check('a tab removed on one side stays removed, even if the other edited it', () => {
  const base = { workspaces: [ws('w', [tab('a'), tab('b')])] }
  const ours = clone(base)
  ours.workspaces[0].tabs = [ours.workspaces[0].tabs[0]]
  const theirs = clone(base)
  theirs.workspaces[0].tabs[1].customTitle = 'still here?'
  assert.deepEqual(merge3(base, ours, theirs).workspaces[0].tabs.map((t) => t.id), ['a'])
})

check('a reorder on one side and an addition on the other both land', () => {
  const base = { list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const ours = { list: [{ id: 'c' }, { id: 'a' }, { id: 'b' }] }
  const theirs = { list: [{ id: 'a' }, { id: 'x' }, { id: 'b' }, { id: 'c' }] }
  assert.deepEqual(merge3(base, ours, theirs).list.map((x) => x.id), ['c', 'a', 'x', 'b'])
})

check('the same field changed on both sides goes to the preferred side', () => {
  const base = { name: 'a' }
  assert.equal(merge3(base, { name: 'ours' }, { name: 'theirs' }).name, 'theirs')
  assert.equal(merge3(base, { name: 'ours' }, { name: 'theirs' }, 'ours').name, 'ours')
})

check('a field deleted on one side is deleted', () => {
  assert.deepEqual(merge3({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 }), { a: 1 })
})

check('the last tab closed on one side and one opened on the other leaves the new one', () => {
  const base = { tabs: [{ id: 'a' }] }
  assert.deepEqual(merge3(base, { tabs: [] }, { tabs: [{ id: 'a' }, { id: 'b' }] }).tabs, [{ id: 'b' }])
})

console.log('Main’s copy, and saves from several windows')

const doc0 = () => ({
  activeWorkspaceId: 'w1',
  workspaces: [ws('w1', [tab('a'), tab('b')]), ws('w2', [tab('c')])],
  window: { width: 100, height: 100, maximized: false },
  windows: [],
})

check('two windows saving from the same revision both keep their edit', () => {
  const hub = new StateHub(doc0(), ['window', 'windows'])
  const base = hub.rev
  const one = doc0()
  one.workspaces[0].name = 'first'
  const two = doc0()
  two.workspaces[1].tabs[0].customTitle = 'second'
  hub.save(one, base, true)
  const result = hub.save(two, base, false)
  assert.equal(result.doc.workspaces[0].name, 'first')
  assert.equal(result.doc.workspaces[1].tabs[0].customTitle, 'second')
})

check('a save cannot overwrite what only main writes', () => {
  const hub = new StateHub(doc0(), ['window', 'windows'])
  const sent = doc0()
  sent.window = { width: 1, height: 1, maximized: true }
  sent.windows = [{ id: 'x', kind: 'workspace', bounds: {} }]
  const result = hub.save(sent, hub.rev, true)
  assert.deepEqual(result.doc.window, doc0().window)
  assert.deepEqual(result.doc.windows, [])
})

check('another window cannot move the main window’s selection', () => {
  const hub = new StateHub(doc0(), ['window', 'windows'])
  const sent = doc0()
  sent.activeWorkspaceId = 'w2'
  sent.workspaces[0].activeTabId = 'b'
  const result = hub.save(sent, hub.rev, false)
  assert.equal(result.doc.activeWorkspaceId, 'w1')
  assert.equal(result.doc.workspaces[0].activeTabId, 'a')
})

check('the main window can move its own selection', () => {
  const hub = new StateHub(doc0(), ['window'])
  const sent = doc0()
  sent.activeWorkspaceId = 'w2'
  assert.equal(hub.save(sent, hub.rev, true).doc.activeWorkspaceId, 'w2')
})

check('a save from too far behind is taken whole, as saves always were', () => {
  const hub = new StateHub(doc0(), [])
  const sent = doc0()
  sent.workspaces[0].name = 'late'
  for (let i = 0; i < 100; i++) hub.replace({ ...hub.doc, n: i })
  assert.equal(hub.save(sent, 1, true).doc.workspaces[0].name, 'late')
})

check('every save is a new revision', () => {
  const hub = new StateHub(doc0(), [])
  const before = hub.rev
  hub.save(doc0(), before, true)
  assert.equal(hub.rev, before + 1)
  assert.equal(hub.save('not a document', before, true), null)
})

console.log('Tabs and windows')

check('tabs sent to a window belong to it, and it shows the first', () => {
  const next = L.assignTabs(doc0(), ['b'], 'win2')
  assert.equal(next.workspaces[0].tabs[1].windowId, 'win2')
  assert.equal(next.workspaces[0].tabs[0].windowId, undefined)
  assert.deepEqual(next.views.win2, { activeWorkspaceId: 'w1', activeTabs: { w1: 'b' } })
})

check('tabs sent back to the main window lose their mark and become its selection', () => {
  const away = L.assignTabs(doc0(), ['c'], 'win2')
  const home = L.assignTabs(away, ['c'], L.MAIN_WINDOW)
  assert.equal('windowId' in home.workspaces[1].tabs[0], false)
  assert.equal(home.activeWorkspaceId, 'w2')
  assert.equal(home.workspaces[1].activeTabId, 'c')
})

check('closing a window brings its tabs home and forgets it', () => {
  let doc = L.recordWindow(doc0(), { id: 'win2', kind: 'workspace', bounds: { width: 1, height: 1, maximized: false } })
  doc = L.assignTabs(doc, ['a', 'c'], 'win2')
  const closed = L.releaseWindow(doc, 'win2')
  assert.equal(closed.workspaces.flatMap((w) => w.tabs).some((t) => t.windowId), false)
  assert.equal(closed.views.win2, undefined)
  assert.deepEqual(closed.windows, [])
  // Nothing was closed on the way.
  assert.equal(closed.workspaces.flatMap((w) => w.tabs).length, 3)
})

check('a tab pointing at a window that did not come back goes to the main window', () => {
  let doc = L.assignTabs(doc0(), ['a'], 'gone')
  doc = L.assignTabs(doc, ['c'], 'kept')
  const next = L.keepOnlyWindows(doc, new Set(['kept']))
  assert.equal(next.workspaces[0].tabs[0].windowId, undefined)
  assert.equal(next.workspaces[1].tabs[0].windowId, 'kept')
  assert.deepEqual(Object.keys(next.views), ['kept'])
})

check('moving tabs, even all of them, leaves the workspace listed where it was', () => {
  const all = L.assignTabs(doc0(), ['a', 'b'], 'win2')
  assert.equal(all.workspaces[0].windowId, undefined)
})

check('a whole workspace moves even with no tabs open', () => {
  const doc = doc0()
  doc.workspaces.push(ws('w3', []))
  const next = L.assignWorkspace(doc, 'w3', 'win2')
  assert.equal(next.workspaces[2].windowId, 'win2')
  assert.equal(next.views.win2.activeWorkspaceId, 'w3')
})

check('closing a window brings home the workspaces that lived there', () => {
  const doc = L.assignWorkspace(doc0(), 'w2', 'win2')
  const closed = L.releaseWindow(doc, 'win2')
  assert.equal(closed.workspaces[1].windowId, undefined)
  assert.equal(closed.workspaces[1].tabs[0].windowId, undefined)
})

console.log('Windows linked to one list')

const linked = () => ({ ...doc0(), windowMode: 'linked' })

check('linked, a tab sent to a pane window switches the list to its workspace', () => {
  const next = L.assignTabs(linked(), ['c'], 'win2')
  assert.equal(next.activeWorkspaceId, 'w2')
  assert.equal(next.views.win2.activeWorkspaceId, 'w2')
})

check('separate, it leaves the main window’s selection alone', () => {
  assert.equal(L.assignTabs(doc0(), ['c'], 'win2').activeWorkspaceId, 'w1')
})

check('a pinned window takes a tab without switching the list', () => {
  const doc = linked()
  doc.views = { win2: { activeWorkspaceId: 'w1', activeTabs: {}, pinned: true, listShown: true } }
  const next = L.assignTabs(doc, ['c'], 'win2')
  assert.equal(next.activeWorkspaceId, 'w1')
  // A window's own switches survive main writing its view.
  assert.equal(next.views.win2.pinned, true)
  assert.equal(next.views.win2.listShown, true)
})

check('linked is read from the document, and absent is separate', () => {
  assert.equal(L.isLinked(linked()), true)
  assert.equal(L.isLinked(doc0()), false)
})

check('the owner of a tab with no mark is the main window', () => {
  assert.equal(L.ownerOfTab({}), 'main')
  assert.equal(L.ownerOfTab({ windowId: 'w9' }), 'w9')
})

console.log(`\n${passed} checks passed`)
