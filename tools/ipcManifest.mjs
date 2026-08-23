// The list of things a host has to answer, as data.
//
// Electron is no longer the only runtime this renderer talks to. A Rust host
// and a Go host have to answer the same 119 channels, and the only way to know
// how far either has got is to compare what it registers against what the
// renderer can ask for. That comparison needs the question in a form neither
// Rust nor Go has to parse TypeScript to read, which is this.
//
// Generated rather than hand-kept: `src/shared/ipc.ts` is the source of truth
// and a hand-copied list would be wrong within a week.
//
//   node tools/ipcManifest.mjs           # writes out/ipc-manifest.json
//   node tools/ipcManifest.mjs --check   # exits 1 if a host is behind
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(root, 'out', 'ipc-manifest.json')

/** Every `name: 'channel'` pair in the IPC table, in source order. */
export function readChannels() {
  const source = fs.readFileSync(path.join(root, 'src', 'shared', 'ipc.ts'), 'utf8')
  const body = source.slice(source.indexOf('export const IPC = {'))
  const channels = []
  // Direction is worth recording: everything before the `main -> renderer`
  // comment is a call the host must answer, everything after is an event the
  // host must be able to raise. A host can be complete on one and empty on the
  // other, and "80 of 119" would hide that.
  let direction = 'invoke'
  for (const line of body.split('\n')) {
    if (/main -> renderer/.test(line)) direction = 'event'
    const match = /^\s{2}([A-Za-z0-9_]+):\s*'([^']+)'/.exec(line)
    if (match) channels.push({ name: match[1], channel: match[2], direction })
    if (/^\} as const/.test(line)) break
  }
  return channels
}

/**
 * What a host claims to implement.
 *
 * Read out of the host's own source rather than asked of it at runtime: a port
 * that does not compile yet still has to be measurable, and starting the thing
 * to count its handlers is a worse dependency than a regular expression.
 */
function implemented(hostDir, patterns) {
  const found = new Set()
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'target' || entry.name === 'node_modules') continue
        walk(full)
        continue
      }
      if (!/\.(rs|go)$/.test(entry.name)) continue
      const text = fs.readFileSync(full, 'utf8')
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) found.add(match[1])
      }
    }
  }
  walk(path.join(root, hostDir))
  return found
}

const HOSTS = [
  // Both hosts register by the channel string, so the check is the same shape
  // for each: find the strings, compare against the manifest.
  { id: 'tauri', dir: 'src-tauri', patterns: [/channel!?\(\s*"([^"]+)"/g, /"([a-z]+:[a-zA-Z]+)"/g] },
  { id: 'wails', dir: 'src-wails', patterns: [/"([a-z]+:[a-zA-Z]+)"/g] },
]

function report(channels) {
  const rows = []
  for (const host of HOSTS) {
    const have = implemented(host.dir, host.patterns)
    const missing = channels.filter((c) => !have.has(c.channel))
    rows.push({ host: host.id, done: channels.length - missing.length, missing })
  }
  return rows
}

const channels = readChannels()
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ channels }, null, 2))

const rows = report(channels)
for (const row of rows) {
  const percent = Math.round((row.done / channels.length) * 100)
  console.log(`${row.host.padEnd(6)} ${String(row.done).padStart(3)}/${channels.length} (${percent}%)`)
  if (process.argv.includes('--verbose')) {
    for (const c of row.missing) console.log(`  todo ${c.direction.padEnd(6)} ${c.channel}`)
  }
}

if (process.argv.includes('--check') && rows.some((r) => r.missing.length)) {
  console.error('\na host is behind the renderer — run with --verbose for the list')
  process.exit(1)
}
