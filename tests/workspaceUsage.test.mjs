// Sorting the workspace list: by name, by size, and by use, where use is the
// time log's hours, older ones counting for less. All of it is pure functions
// over a few numbers.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'iaw-usage-'))
await build({
  entryPoints: { usage: 'src/shared/workspaceUsage.ts' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
})
const U = await import(`file://${out}/usage.js`)

let failed = 0
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}\n       ${err.message}`)
  }
}

const DAY = 86_400_000
const MIN = 60_000
const NOW = 100 * DAY
/** A span of `min` minutes in `cwd`, ending `ago` days before NOW. */
const span = (cwd, min, ago = 0) => ({ cwd, start: NOW - ago * DAY - min * MIN, end: NOW - ago * DAY })
const ws = (id, extra = {}) => ({ id, cwd: `C:\\p\\${id}`, ...extra })
/** The drawn order, nesting included, from the places. */
function drawn(list, places) {
  const withPlace = list.map((w) => ({ ...w, usage: { ...w.usage, place: places.get(w.id) } }))
  const out = []
  const walk = (parent, depth) => {
    for (const w of U.byPlace(withPlace.filter((x) => (x.parentId ?? null) === parent))) {
      out.push('  '.repeat(depth) + w.id)
      walk(w.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
const order = (list, spans, halfLife) => drawn(list, U.usagePlaces(list, U.fadedMinutes(spans, NOW, halfLife)))

check('time halves every half-life, and is matched by folder whatever the slashes or case', () => {
  const m = U.fadedMinutes([span('C:\\P\\a\\', 100, 14), span('c:/p/a', 50)], NOW, 14)
  assert.ok(Math.abs(m.get(U.pathKey('C:\\p\\a')) - 100) < 1e-9)
})

check('the most used go to the top', () => {
  const list = [ws('a'), ws('b'), ws('c'), ws('d')]
  assert.deepEqual(order(list, [span('C:\\p\\b', 500), span('C:\\p\\c', 50), span('C:\\p\\d', 2000)]), ['d', 'b', 'c', 'a'])
})

check('a little more use does not swap two workspaces', () => {
  const list = [ws('a', { usage: { place: 0 } }), ws('b', { usage: { place: 1 } })]
  assert.deepEqual(order(list, [span('C:\\p\\a', 100), span('C:\\p\\b', 120)]), ['a', 'b'])
  // Clearly more does.
  assert.deepEqual(order(list, [span('C:\\p\\a', 100), span('C:\\p\\b', 300)]), ['b', 'a'])
})

check('a few minutes in a new workspace does not lift it over unused ones', () => {
  const list = [ws('a'), ws('b'), ws('new')]
  assert.deepEqual(order(list, [span('C:\\p\\new', 10)]), ['a', 'b', 'new'])
})

check('nesting is kept, and a parent climbs with its children', () => {
  const list = [ws('tools'), ws('music'), ws('synth', { parentId: 'music' }), ws('effect', { parentId: 'music' }), ws('docs')]
  const spans = [span('C:\\p\\tools', 30), span('C:\\p\\synth', 5), span('C:\\p\\effect', 900), span('C:\\p\\docs', 100)]
  assert.deepEqual(order(list, spans), ['music', '  effect', '  synth', 'docs', 'tools'])
})

check('a child never leaves its parent, however used', () => {
  const list = [ws('p'), ws('q'), ws('child', { parentId: 'q' })]
  const result = order(list, [span('C:\\p\\p', 10), span('C:\\p\\child', 5000)])
  assert.equal(result.indexOf('  child'), result.indexOf('q') + 1)
})

check('equal use keeps the order you had', () => {
  assert.deepEqual(order([ws('c'), ws('a'), ws('b')], []), ['c', 'a', 'b'])
})

check('use from long ago lets a workspace sink', () => {
  const list = [ws('old', { usage: { place: 0 } }), ws('now', { usage: { place: 1 } })]
  assert.deepEqual(order(list, [span('C:\\p\\old', 2000, 70), span('C:\\p\\now', 300)]), ['now', 'old'])
})

check('the half-life is the one asked for', () => {
  const list = [ws('old', { usage: { place: 0 } }), ws('now', { usage: { place: 1 } })]
  const spans = [span('C:\\p\\old', 1000, 21), span('C:\\p\\now', 300)]
  assert.deepEqual(order(list, spans, 7), ['now', 'old'])
  assert.deepEqual(order(list, spans, 60), ['old', 'now'])
})

check('by name: natural order, ignoring case', () => {
  const group = [{ id: '1', name: 'beta' }, { id: '2', name: 'Alpha' }, { id: '3', name: 'item10' }, { id: '4', name: 'item9' }]
  assert.deepEqual(U.sortSiblings(group, 'name').map((w) => w.name), ['Alpha', 'beta', 'item9', 'item10'])
})

check('by size: biggest first, unmeasured last in the order they had', () => {
  const group = [{ id: 'a', usage: {} }, { id: 'b', usage: { bytes: 10 } }, { id: 'c' }, { id: 'd', usage: { bytes: 5000 } }]
  assert.deepEqual(U.sortSiblings(group, 'size').map((w) => w.id), ['d', 'b', 'a', 'c'])
})

check('manual is the order given', () => {
  const group = [{ id: 'z', name: 'z' }, { id: 'a', name: 'a' }]
  assert.deepEqual(U.sortSiblings(group, 'manual').map((w) => w.id), ['z', 'a'])
})

check('sent to the top or bottom, it stays there however used', () => {
  const list = [ws('a'), ws('b', { usage: { pin: 'bottom' } }), ws('c', { usage: { pin: 'top' } }), ws('d')]
  const spans = [span('C:\\p\\b', 5000), span('C:\\p\\d', 500)]
  assert.deepEqual(order(list, spans), ['c', 'd', 'a', 'b'])
})

check('pins hold in the name and size orders too, and not in manual', () => {
  const group = [{ id: 'a', name: 'a' }, { id: 'z', name: 'z', usage: { pin: 'top' } }, { id: 'b', name: 'b', usage: { pin: 'bottom' } }]
  assert.deepEqual(U.sortSiblings(group, 'name').map((w) => w.id), ['z', 'a', 'b'])
  assert.deepEqual(U.sortSiblings(group, 'manual').map((w) => w.id), ['a', 'z', 'b'])
})

// Presets: a workspace's tabs, folders relative to its own.
const P = await (async () => {
  await build({ entryPoints: { preset: 'src/shared/workspacePreset.ts' }, bundle: true, platform: 'node', format: 'esm', outdir: out })
  return import(`file://${out}/preset.js`)
})()

check('preset paths: inside the folder relative, outside left alone, any case on Windows', () => {
  assert.equal(P.toRelative('C:\\Proj\\', 'c:\\proj'), '.')
  assert.equal(P.toRelative('c:\\proj\\a\\src\\x', 'C:\\Proj\\A'), 'src/x')
  assert.equal(P.toRelative('D:\\other', 'C:\\Proj'), 'D:\\other')
  assert.equal(P.toRelative('/home/k/projX', '/home/k/proj'), '/home/k/projX')
  assert.equal(P.fromRelative('src/x', 'D:\\new\\'), 'D:\\new\\src\\x')
  assert.equal(P.fromRelative('.', '/home/k/p'), '/home/k/p')
  assert.equal(P.fromRelative('D:\\other', 'C:\\Proj'), 'D:\\other')
})

check('a preset lays the same tabs out in another folder', () => {
  const workspace = {
    id: 'w', name: 'w', cwd: 'C:\\old', color: '#fff', treeVisible: true, activeTabId: 't',
    tabs: [{
      id: 't', customTitle: 'dev', activePaneId: 'p2',
      panes: [
        { id: 'p1', kind: 'terminal', cwd: 'C:\\old', autoTitle: '', customTitle: 'build' },
        { id: 'p2', kind: 'terminal', cwd: 'C:\\old\\sub', autoTitle: '', customTitle: 'claude' },
      ],
      layout: { kind: 'split', direction: 'column', sizes: [0.5, 0.5], children: [{ kind: 'leaf', paneId: 'p1' }, { kind: 'leaf', paneId: 'p2' }] },
    }],
  }
  const preset = P.makePreset('dev', workspace)
  assert.equal(preset.treeVisible, true)
  assert.deepEqual(preset.tabs[0].panes.map((p) => p.cwd), ['.', 'sub'])
  let n = 0
  const [tab] = P.presetTabs(JSON.parse(JSON.stringify(preset)), 'E:\\new', () => `id${n++}`)
  assert.equal(tab.customTitle, 'dev')
  assert.deepEqual(tab.panes.map((p) => [p.customTitle, p.cwd]), [['build', 'E:\\new'], ['claude', 'E:\\new\\sub']])
  assert.equal(tab.layout.direction, 'column')
  assert.equal(tab.activePaneId, tab.panes[1].id)
})

check('presets off disk: nameless, tabless and duplicate ones dropped', () => {
  const read = P.readPresets([{ name: 'a', tabs: [] }, { name: 'a', tabs: [] }, { tabs: [] }, { name: 'b' }, null])
  assert.deepEqual(read.map((p) => p.name), ['a'])
  assert.deepEqual(P.readPresets('x'), [])
})

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
