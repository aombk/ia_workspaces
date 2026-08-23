// What a host costs, measured the same way for each of them.
//
// Three runtimes cannot be compared by opening them and looking at Task
// Manager: the numbers move, the process trees differ in shape, and "Electron
// felt heavy" is not a thing anybody can act on. So this starts a host, waits
// for it to settle, and samples the whole process tree it owns — every helper,
// every renderer, every shell — on one clock, into one table.
//
//   node tools/benchHost.mjs electron
//   node tools/benchHost.mjs electron --settle 20 --samples 10
//   node tools/benchHost.mjs --compare out/bench/*.json
//
// What is measured, and why each one:
//
//  - **startup** — launch to the window's first paint, which is the number a
//    person feels every morning.
//  - **working set / private bytes**, summed over the tree. Private is the
//    honest one for comparing runtimes: working set counts shared pages of
//    Chromium twice when two processes map them.
//  - **CPU seconds** over the sample window, idle. A terminal that costs
//    processor time while nothing is happening is a laptop that runs hot.
//  - **process count**, because five processes at 200 MB and one at 1 GB are
//    the same total and not the same problem.
//
// Nothing here starts shells or drives the UI: an empty window is the only
// state all three hosts can be in without the other two being finished. Once
// the ports can run panes, `--panes N` should open that many and re-sample.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Declared before `run`, which is called at the top level and cannot wait for
// the rest of the file to initialise.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
const OUT = path.join(root, 'out', 'bench')

/** Where each host's runnable build is, and how to start it. */
const HOSTS = {
  electron: {
    // The packaged tree rather than `electron .`: a dev run carries a watcher
    // and an unminified bundle, neither of which ships.
    exe: path.join(root, 'out', 'electron-pack', 'win-unpacked', 'ia_workspaces.exe'),
    fallback: 'npx electron .',
  },
  tauri: {
    exe: path.join(root, 'src-tauri', 'target', 'release', 'ia_workspaces.exe'),
    fallback: 'npx @tauri-apps/cli@2 build',
  },
  wails: {
    exe: path.join(root, 'src-wails', 'build', 'bin', 'ia_workspaces.exe'),
    fallback: 'cd src-wails && wails build -s',
  },
}

const args = process.argv.slice(2)
const settleSeconds = Number(flag('--settle') ?? 15)
const samples = Number(flag('--samples') ?? 6)

function flag(name) {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

if (args[0] === '--compare') {
  compare(args.slice(1))
  process.exit(0)
}

// Measuring what is already running, rather than starting a copy.
//
// Needed more often than it sounds: this app takes a single-instance lock, so
// launching a second one hands off to the first and exits, and there is then no
// tree to sample. It also covers the honest case of measuring a host that has
// been open all day, which is a different number from one that just started.
if (args[0] === '--attach') {
  const pid = Number(args[1])
  const name = args[2] ?? 'electron'
  if (!Number.isInteger(pid)) {
    console.error('usage: node tools/benchHost.mjs --attach <pid> [host-name]')
    process.exit(1)
  }
  await measure(name, pid, null)
  process.exit(0)
}

const host = args[0]
if (!HOSTS[host]) {
  console.error(`usage: node tools/benchHost.mjs <${Object.keys(HOSTS).join('|')}> [--settle 15] [--samples 6]`)
  process.exit(1)
}

await run(host)

async function run(name) {
  const spec = HOSTS[name]
  if (!fs.existsSync(spec.exe)) {
    console.error(`[x] ${name}: ${path.relative(root, spec.exe)} is not there.\n    Build it first: ${spec.fallback}`)
    process.exit(1)
  }

  console.log(`[*] starting ${name}`)
  const started = Date.now()
  const child = spawn(spec.exe, [], { detached: true, stdio: 'ignore' })
  child.unref()

  // First sample as soon as the tree exists, which is as close to "the window
  // appeared" as this can get without asking the app to tell us.
  const appearedAt = await waitForTree(child.pid, 30_000)
  const startupMs = appearedAt ? appearedAt - started : null
  if (!appearedAt) {
    console.error(
      '[x] no process tree appeared within 30s.' +
        '\n    This app takes a single-instance lock, so a second copy hands off to the' +
        '\n    first and exits. Close the running one, or measure it where it is:' +
        '\n      node tools/benchHost.mjs --attach <pid> ' + name
    )
    process.exit(1)
  }
  console.log(`[*] up in ${startupMs} ms — settling for ${settleSeconds}s`)
  await sleep(settleSeconds * 1000)
  await measure(name, child.pid, startupMs)
  console.log('[*] the app is still running — close it when you have looked at it')
}

/** Samples a tree that is already up, and writes the row. */
async function measure(name, pid, startupMs) {
  const rootName = await imageName(pid)
  const taken = []
  for (let i = 0; i < samples; i++) {
    taken.push(await sampleTree(pid, rootName))
    if (i < samples - 1) await sleep(2000)
  }

  const first = taken[0]
  const last = taken[taken.length - 1]
  const spanSeconds = (last.at - first.at) / 1000
  const result = {
    host: name,
    at: new Date().toISOString(),
    startupMs,
    // The runtime itself. This is the number the three hosts are compared on.
    processes: median(taken.map((s) => s.ownProcesses)),
    workingSetMB: median(taken.map((s) => s.ownWorkingSet)) / 1024 / 1024,
    privateMB: median(taken.map((s) => s.ownPrivate)) / 1024 / 1024,
    // And everything under it, shells included, which is what the machine
    // actually gives up to have this open.
    treeProcesses: median(taken.map((s) => s.processes)),
    treeWorkingSetMB: median(taken.map((s) => s.workingSet)) / 1024 / 1024,
    // CPU across the window rather than at an instant: an idle app that wakes
    // twice a second shows nothing in a snapshot and adds up over an hour.
    idleCpuPercent:
      spanSeconds > 0 ? ((last.ownCpuSeconds - first.ownCpuSeconds) / spanSeconds) * 100 : 0,
    samples: taken.length,
  }

  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  report([result])
  console.log(`\n[*] written to ${path.relative(root, file)}`)
  console.log('[*] the app is still running — close it when you have looked at it')
}

/** Every process descended from `pid`, plus `pid` itself. */
function treeQuery(pid, rootName) {
  return `
    $ErrorActionPreference = 'SilentlyContinue'
    $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount
    $byParent = @{}
    foreach ($p in $all) {
      $k = [int]$p.ParentProcessId
      if (-not $byParent.ContainsKey($k)) { $byParent[$k] = @() }
      $byParent[$k] += $p
    }
    $seen = @{}
    $stack = New-Object System.Collections.Stack
    $stack.Push([int]${pid})
    $ws = 0; $pv = 0; $n = 0; $cpu = 0.0
    # The host's own processes, told from the shells it is hosting by their
    # image name. A terminal full of agents is not the runtime's memory, and a
    # comparison that counted it would say more about what was open than about
    # which runtime is lighter. The webview counts as the host's: it is how a
    # Tauri or Wails build draws, exactly as Electron's renderer is.
    $ownWs = 0; $ownPv = 0; $ownN = 0; $ownCpu = 0.0
    $own = @('${rootName}', 'msedgewebview2.exe')
    while ($stack.Count) {
      $id = [int]$stack.Pop()
      if ($seen.ContainsKey($id)) { continue }
      $seen[$id] = $true
      $p = $all | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1
      if ($p) {
        $n++
        $ws += [double]$p.WorkingSetSize
        $pv += [double]$p.PrivatePageCount
        $seconds = 0.0
        try { $seconds = (Get-Process -Id $id).TotalProcessorTime.TotalSeconds } catch {}
        $cpu += $seconds
        if ($own -contains $p.Name) {
          $ownN++
          $ownWs += [double]$p.WorkingSetSize
          $ownPv += [double]$p.PrivatePageCount
          $ownCpu += $seconds
        }
      }
      foreach ($c in $byParent[$id]) { $stack.Push([int]$c.ProcessId) }
    }
    ConvertTo-Json @{
      processes = $n; workingSet = $ws; private = $pv; cpuSeconds = $cpu
      ownProcesses = $ownN; ownWorkingSet = $ownWs; ownPrivate = $ownPv; ownCpuSeconds = $ownCpu
    }
  `
}

async function sampleTree(pid, rootName) {
  const out = await powershell(treeQuery(pid, rootName))
  const parsed = JSON.parse(out)
  return { ...parsed, at: Date.now() }
}

/** The image name of a pid, which is what tells the host from its tenants. */
async function imageName(pid) {
  const out = await powershell(
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`
  )
  return out || 'ia_workspaces.exe'
}

async function waitForTree(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sample = await sampleTree(pid, 'ia_workspaces.exe').catch(() => null)
    // Two processes: a host that has only forked once has not drawn anything.
    if (sample && sample.processes >= 2) return Date.now()
    await sleep(250)
  }
  return null
}

function powershell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.on('error', reject)
    child.on('close', () => resolve(out.trim()))
  })
}

/** Median, not mean: one sample taken while Windows indexed something is not
 *  the app's memory, and a mean carries it into the answer. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function compare(files) {
  const rows = files
    .flatMap((pattern) => (fs.existsSync(pattern) ? [pattern] : []))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
  if (!rows.length) {
    console.error('nothing to compare — run a host first')
    return
  }
  report(rows)
}

function report(rows) {
  console.log('')
  console.log('host      startup  procs   host WS   host priv  idle cpu   with shells')
  console.log('---------------------------------------------------------------------------')
  for (const r of rows) {
    console.log(
      `${r.host.padEnd(9)} ${String(r.startupMs ?? '?').padStart(5)}ms ${String(r.processes).padStart(5)}` +
        ` ${r.workingSetMB.toFixed(0).padStart(7)} MB ${r.privateMB.toFixed(0).padStart(7)} MB` +
        ` ${r.idleCpuPercent.toFixed(1).padStart(7)}%` +
        ` ${(r.treeWorkingSetMB ?? r.workingSetMB).toFixed(0).padStart(8)} MB / ${r.treeProcesses ?? r.processes}`
    )
  }
}
