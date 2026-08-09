/**
 * What this app's panes have running, and what is listening.
 *
 * One
 * PowerShell call for both halves, emitted as lines rather than JSON so the
 * three runtimes parse it with a split instead of three JSON shapes to keep in
 * step: `L <pid> <port>` for a listener, `P <pid> <ppid> <name> <cmdline>`.
 */
import { execFile } from 'node:child_process'
import type { ProcessInfo } from '../shared/types'

const PROBE = `$ErrorActionPreference='SilentlyContinue'
Get-NetTCPConnection -State Listen | ForEach-Object { "L $($_.OwningProcess) $($_.LocalPort)" }
Get-CimInstance Win32_Process | ForEach-Object { "P $($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine -replace '[\\r\\n]',' ')" }`

/** Longest command line kept. A java invocation runs to thousands of chars. */
const MAX_CMDLINE = 300

interface Row {
  parent: number
  name: string
  commandLine: string
}

/**
 * Every process descending from one of `roots`, with its listening ports.
 *
 * `roots` is pane id -> the shell's pid. Everything under a shell is what that
 * pane is responsible for, which is the question the panel answers: not "what
 * is running on this machine" but "what did *I* start here, and is it still
 * holding port 5173".
 */
export async function listProcesses(roots: Map<string, number>): Promise<ProcessInfo[]> {
  const probe = await runProbe()
  if (!probe) return []
  const { table, ports } = probe

  // Children by parent, so walking down is not quadratic in process count.
  const children = new Map<number, number[]>()
  for (const [pid, row] of table) {
    const bucket = children.get(row.parent)
    if (bucket) bucket.push(pid)
    else children.set(row.parent, [pid])
  }

  const out: ProcessInfo[] = []
  for (const paneId of [...roots.keys()].sort()) {
    const queue: Array<[number, number]> = [[roots.get(paneId)!, 0]]
    const seen = new Set<number>()
    while (queue.length) {
      const [pid, depth] = queue.shift()!
      if (seen.has(pid)) continue
      seen.add(pid)

      const row = table.get(pid)
      // The shell itself is skipped: the pane already stands for it.
      if (row && depth > 0) {
        out.push({
          pid,
          parentPid: row.parent,
          name: row.name,
          commandLine: row.commandLine,
          ports: ports.get(pid) ?? [],
          paneId,
          depth: depth - 1,
        })
      }
      for (const child of children.get(pid) ?? []) queue.push([child, depth + 1])
    }
  }

  return out.sort(
    (a, b) => a.paneId.localeCompare(b.paneId) || a.depth - b.depth || a.pid - b.pid
  )
}

async function runProbe(): Promise<{
  table: Map<number, Row>
  ports: Map<number, number[]>
} | null> {
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PROBE],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (_err, out) => resolve(out ?? '')
    )
  })

  const table = new Map<number, Row>()
  const ports = new Map<number, number[]>()

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('L ')) {
      const [pidText, portText] = line.slice(2).trim().split(/\s+/)
      const pid = Number.parseInt(pidText, 10)
      const port = Number.parseInt(portText, 10)
      if (!Number.isFinite(pid) || !Number.isFinite(port)) continue
      const list = ports.get(pid)
      if (list) {
        if (!list.includes(port)) list.push(port)
      } else {
        ports.set(pid, [port])
      }
    } else if (line.startsWith('P ')) {
      const rest = line.slice(2)
      const first = rest.indexOf(' ')
      const second = rest.indexOf(' ', first + 1)
      const third = rest.indexOf(' ', second + 1)
      if (first < 0 || second < 0) continue
      const pid = Number.parseInt(rest.slice(0, first), 10)
      const parent = Number.parseInt(rest.slice(first + 1, second), 10)
      if (!Number.isFinite(pid) || !Number.isFinite(parent)) continue
      const name = third < 0 ? rest.slice(second + 1) : rest.slice(second + 1, third)
      let commandLine = third < 0 ? '' : rest.slice(third + 1).trim()
      if (commandLine.length > MAX_CMDLINE) commandLine = `${commandLine.slice(0, MAX_CMDLINE)}…`
      table.set(pid, { parent, name, commandLine })
    }
  }

  if (!table.size) return null
  for (const list of ports.values()) list.sort((a, b) => a - b)
  return { table, ports }
}
