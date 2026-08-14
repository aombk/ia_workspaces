/**
 * What the machine is doing, from counters the OS keeps for everybody.
 *
 * The rule this file is built on is in `SystemStats`: nothing here installs
 * anything, loads a driver, or asks for an administrator. That rules out most
 * temperatures — on Windows a CPU temperature costs a signed kernel driver,
 * which is what HWiNFO and LibreHardwareMonitor are, and this app is not going
 * to ship one — and it rules *in* everything people actually watch minute to
 * minute: load, memory, free space, throughput.
 *
 * That line has since been walked rather than moved. Each reading below was
 * measured on a real machine before it was included, and one was measured and
 * left out: `MSFT_StorageReliabilityCounter` is where a drive's temperature,
 * wear and power-on hours live, it is one association away from data already
 * being read, and every field of it comes back empty without an administrator.
 * What *is* free turned out to be more than expected — Windows gives its
 * storage stack's health verdict per drive for nothing, and Linux publishes
 * every CPU and NVMe temperature it has to any process that can read a file.
 *
 * Four kinds of reading, gathered four different ways:
 *
 * - **Node's own** — CPU times, memory, uptime. Free, exact, identical on all
 *   three platforms, and the reason the pane has something to show one frame
 *   after it opens rather than after the first probe returns.
 * - **One platform probe** — volumes, per-interface byte counters, battery.
 *   None of this is in Node. It is one process per sample, not one per reading,
 *   for the same reason `processes.ts` uses one PowerShell call for two
 *   questions: on Windows the spawn costs more than everything it is asked.
 * - **`nvidia-smi`** — the single exception to the no-driver rule, because it
 *   arrives with a driver the owner of the card already installed, needs no
 *   privileges, and answers in about 70ms with load, temperature, memory and
 *   watts. AMD and Intel have no equivalent, so those cards report nothing
 *   rather than something invented.
 * - **One slow probe** — disk throughput, drive health and whatever
 *   temperatures the machine will give up. Off the critical path entirely and
 *   on a five-second clock of its own, because on Windows it costs 246ms
 *   against the main probe's 129ms and refreshes two things that barely move.
 *   See `slowProbe`.
 *
 * The Windows probe is worth a note. The obvious spelling — `Get-Volume`,
 * `Get-NetAdapterStatistics`, `Get-CimInstance Win32_Battery` — measures 2.4
 * seconds, essentially all of it PowerShell autoloading the Storage and
 * NetAdapter modules and initialising CIM. The same three answers taken from
 * plain .NET types, which are already in the runtime, measure 315ms. That is
 * the difference between a monitor you can poll and one you cannot.
 */
import { execFile } from 'node:child_process'
import { readFile, readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import { readLhm, type LhmBattery, type LhmDisk } from './lhm'
import type {
  BatteryStats,
  CpuStats,
  DiskHealth,
  DiskIoStats,
  DiskStats,
  GpuStats,
  NetworkStats,
  SystemStats,
  TemperatureStats,
} from '../shared/types'

/**
 * How long a platform probe's answer is reused.
 *
 * Slightly under the pane's poll, so a 2s pane gets a fresh probe each time and
 * the strip in the sidebar — which polls slower — rides along on the pane's
 * without spawning a second process. Free space and battery do not move fast
 * enough for this to be visible; the byte counters are cumulative, so a reused
 * sample changes the interval the rate is divided by and not the rate.
 */
const PROBE_TTL_MS = 1500
const GPU_TTL_MS = 1500
/** Long enough that a hung `df` or a sleeping USB disk cannot wedge the poll. */
const PROBE_TIMEOUT_MS = 4000

// ---------------------------------------------------------------- CPU times

interface CpuSample {
  at: number
  perCore: Array<{ idle: number; total: number }>
}

let previousCpu: CpuSample | null = null

function sampleCpu(): CpuStats {
  const cpus = os.cpus()
  const now = Date.now()
  const perCore = cpus.map((core) => {
    const times = core.times
    const total = times.user + times.nice + times.sys + times.idle + times.irq
    return { idle: times.idle, total }
  })

  let load: number | null = null
  let percentages: number[] = []

  // Only against a previous sample. `os.cpus()` reports totals since boot, so a
  // single reading is "how busy has this machine been since Tuesday" — which is
  // a number, just not the one anybody wants, and it looks exactly like the one
  // they do want.
  if (previousCpu && previousCpu.perCore.length === perCore.length) {
    let idleDelta = 0
    let totalDelta = 0
    percentages = perCore.map((core, i) => {
      const before = previousCpu!.perCore[i]
      const idle = core.idle - before.idle
      const total = core.total - before.total
      idleDelta += idle
      totalDelta += total
      return total > 0 ? clampPercent(100 * (1 - idle / total)) : 0
    })
    load = totalDelta > 0 ? clampPercent(100 * (1 - idleDelta / totalDelta)) : 0
  }

  previousCpu = { at: now, perCore }

  // Windows has no load average; Node returns [0,0,0] there, which reads as an
  // idle machine rather than as an unanswered question.
  const average = os.loadavg()
  const loadAverage =
    process.platform === 'win32' ? null : ([average[0], average[1], average[2]] as [number, number, number])

  return {
    model: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    load,
    perCore: percentages,
    loadAverage,
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

// ------------------------------------------------------------ platform probe

interface PlatformProbe {
  disks: DiskStats[]
  /** Interface name -> cumulative bytes. */
  networks: Array<{ name: string; rx: number; tx: number }>
  battery: BatteryStats | null
}

let probeCache: { at: number; value: PlatformProbe } | null = null
let probeInFlight: Promise<PlatformProbe> | null = null

async function platformProbe(): Promise<PlatformProbe> {
  const now = Date.now()
  if (probeCache && now - probeCache.at < PROBE_TTL_MS) return probeCache.value
  // Shared rather than queued: the pane and the sidebar strip can land in the
  // same tick, and two probes would be two processes answering one question.
  if (probeInFlight) return probeInFlight

  probeInFlight = runProbe()
    .then((value) => {
      probeCache = { at: Date.now(), value }
      return value
    })
    .catch(() => probeCache?.value ?? { disks: [], networks: [], battery: null })
    .finally(() => {
      probeInFlight = null
    })
  return probeInFlight
}

function runProbe(): Promise<PlatformProbe> {
  if (process.platform === 'win32') return windowsProbe()
  if (process.platform === 'darwin') return macProbe()
  return linuxProbe()
}

// ----------------------------------------------------------------- Windows

/**
 * .NET types only — no cmdlets, no CIM, no module autoload.
 *
 * `DriveInfo`, `NetworkInterface` and `SystemInformation.PowerStatus` are all
 * in the runtime PowerShell has already loaded by the time it reads this, which
 * is why this costs 315ms where the cmdlet spelling costs 2.4 seconds.
 *
 * Fixed drives only. A monitor that lists every mapped network share and every
 * mounted ISO is a monitor with the one disk you care about somewhere on page
 * two, and a disconnected share makes `IsReady` block.
 */
const WINDOWS_PROBE = `$ErrorActionPreference='SilentlyContinue'
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
  if ($d.IsReady -and $d.DriveType -eq 'Fixed') { "V $($d.Name.Substring(0,1)) $($d.TotalSize) $($d.AvailableFreeSpace) $($d.VolumeLabel)" }
}
foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  $s = $n.GetIPStatistics()
  if ($s.BytesReceived -gt 0 -or $s.BytesSent -gt 0) { "N $($s.BytesReceived) $($s.BytesSent) $($n.Name)" }
}
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.SystemInformation]::PowerStatus
"B $($p.BatteryLifePercent) $($p.PowerLineStatus) $($p.BatteryLifeRemaining)"`

async function windowsProbe(): Promise<PlatformProbe> {
  const stdout = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PROBE,
  ])

  const disks: DiskStats[] = []
  const networks: Array<{ name: string; rx: number; tx: number }> = []
  let battery: BatteryStats | null = null

  for (const line of stdout.split('\n')) {
    const text = line.replace(/\r$/, '')
    if (text.startsWith('V ')) {
      const [letter, total, free, ...label] = text.slice(2).split(' ')
      disks.push({
        mount: `${letter}:`,
        label: label.join(' ').trim(),
        total: Number(total) || 0,
        free: Number(free) || 0,
      })
    } else if (text.startsWith('N ')) {
      const [rx, tx, ...name] = text.slice(2).split(' ')
      networks.push({ name: name.join(' ').trim(), rx: Number(rx) || 0, tx: Number(tx) || 0 })
    } else if (text.startsWith('B ')) {
      const [percent, line2, seconds] = text.slice(2).split(' ')
      // 1 is the sentinel PowerStatus uses for "no battery in this machine",
      // and 255 is "unknown" — both would otherwise read as a full charge.
      const fraction = Number(percent)
      if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
        const left = Number(seconds)
        battery = {
          percent: Math.round(fraction * 100),
          charging: line2 === 'Online' ? true : line2 === 'Offline' ? false : null,
          secondsLeft: Number.isFinite(left) && left > 0 ? left : null,
          wearPercent: null,
          rateWatts: null,
          remainingWh: null,
          fullWh: null,
          designWh: null,
        }
      }
    }
  }

  return { disks, networks, battery }
}

// ------------------------------------------------------------------- Linux

async function linuxProbe(): Promise<PlatformProbe> {
  const [disks, networks, battery] = await Promise.all([
    linuxDisks(),
    linuxNetworks(),
    linuxBattery(),
  ])
  return { disks, networks, battery }
}

/**
 * Real filesystems only, from `/proc/mounts`.
 *
 * Linux mounts dozens of kernel filesystems — proc, sysfs, cgroup, a tmpfs per
 * user — and every one of them would arrive with a size and a free figure that
 * mean nothing. The allowlist is the handful anybody stores a file on.
 */
const LINUX_FILESYSTEMS = new Set([
  'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'zfs', 'f2fs', 'jfs', 'reiserfs',
  'vfat', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'overlay',
])

async function linuxDisks(): Promise<DiskStats[]> {
  let mounts: string
  try {
    mounts = await readFile('/proc/mounts', 'utf8')
  } catch {
    return []
  }

  const seen = new Set<string>()
  const out: DiskStats[] = []
  for (const line of mounts.split('\n')) {
    const [device, mount, kind] = line.split(/\s+/)
    if (!mount || !LINUX_FILESYSTEMS.has(kind)) continue
    if (seen.has(mount)) continue
    seen.add(mount)
    try {
      const info = await statfs(mount)
      if (!info.blocks) continue
      out.push({
        mount,
        label: device?.split('/').pop() ?? '',
        total: info.bsize * info.blocks,
        // `bavail`, not `bfree`: the difference is the reserve only root can
        // use, and reporting it as free is how a "5% free" disk refuses a write.
        free: info.bsize * info.bavail,
      })
    } catch {
      // A mount that vanished between reading the table and asking about it.
    }
  }
  return out
}

async function linuxNetworks(): Promise<Array<{ name: string; rx: number; tx: number }>> {
  let raw: string
  try {
    raw = await readFile('/proc/net/dev', 'utf8')
  } catch {
    return []
  }
  const out: Array<{ name: string; rx: number; tx: number }> = []
  // Two header lines, then `name: rx_bytes ... tx_bytes ...` per interface.
  for (const line of raw.split('\n').slice(2)) {
    const [namePart, rest] = line.split(':')
    if (!rest) continue
    const name = namePart.trim()
    if (!name || name === 'lo') continue
    const fields = rest.trim().split(/\s+/)
    const rx = Number(fields[0]) || 0
    const tx = Number(fields[8]) || 0
    if (rx === 0 && tx === 0) continue
    out.push({ name, rx, tx })
  }
  return out
}

async function linuxBattery(): Promise<BatteryStats | null> {
  try {
    const supplies = await readdir('/sys/class/power_supply')
    for (const name of supplies) {
      if (!name.startsWith('BAT')) continue
      const base = `/sys/class/power_supply/${name}`
      const percent = Number((await readFile(`${base}/capacity`, 'utf8')).trim())
      if (!Number.isFinite(percent)) continue
      let charging: boolean | null = null
      try {
        const status = (await readFile(`${base}/status`, 'utf8')).trim()
        charging = status === 'Charging' || status === 'Full'
      } catch {
        // Some kernels expose capacity without status.
      }
      return {
        percent,
        charging,
        secondsLeft: null,
        wearPercent: null,
        rateWatts: null,
        remainingWh: null,
        fullWh: null,
        designWh: null,
      }
    }
  } catch {
    // No power supply class at all: a desktop, or a container.
  }
  return null
}

// ------------------------------------------------------------------- macOS

async function macProbe(): Promise<PlatformProbe> {
  const [disks, networks, battery] = await Promise.all([macDisks(), macNetworks(), macBattery()])
  return { disks, networks, battery }
}

/**
 * `/` and whatever is under `/Volumes`, sized with `statfs`.
 *
 * Rather than parsing `df`: the sizes come from the same syscall either way,
 * and `df`'s columns move with the locale while `statfs` does not.
 */
async function macDisks(): Promise<DiskStats[]> {
  const candidates = ['/']
  try {
    for (const name of await readdir('/Volumes')) candidates.push(`/Volumes/${name}`)
  } catch {
    // No removable volumes mounted.
  }

  const out: DiskStats[] = []
  for (const mount of candidates) {
    try {
      const info = await statfs(mount)
      if (!info.blocks) continue
      out.push({
        mount,
        label: mount === '/' ? 'Macintosh HD' : (mount.split('/').pop() ?? ''),
        total: info.bsize * info.blocks,
        free: info.bsize * info.bavail,
      })
    } catch {
      // A volume ejected mid-scan.
    }
  }
  return out
}

async function macNetworks(): Promise<Array<{ name: string; rx: number; tx: number }>> {
  // `-ib` prints cumulative byte counters per interface, one line per address
  // family — so the same interface appears several times and the first line,
  // which is the link-level one, is the one carrying the totals.
  const stdout = await runCommand('netstat', ['-ib']).catch(() => '')
  const out: Array<{ name: string; rx: number; tx: number }> = []
  const seen = new Set<string>()
  for (const line of stdout.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/)
    if (fields.length < 10) continue
    const name = fields[0]
    if (!name || name === 'lo0' || seen.has(name)) continue
    const rx = Number(fields[6])
    const tx = Number(fields[9])
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue
    if (rx === 0 && tx === 0) continue
    seen.add(name)
    out.push({ name, rx, tx })
  }
  return out
}

async function macBattery(): Promise<BatteryStats | null> {
  const stdout = await runCommand('pmset', ['-g', 'batt']).catch(() => '')
  const percent = /(\d+)%/.exec(stdout)
  if (!percent) return null
  const remaining = /(\d+):(\d{2}) remaining/.exec(stdout)
  return {
    percent: Number(percent[1]),
    charging: /AC Power/.test(stdout),
    secondsLeft: remaining ? Number(remaining[1]) * 3600 + Number(remaining[2]) * 60 : null,
    wearPercent: null,
    rateWatts: null,
    remainingWh: null,
    fullWh: null,
    designWh: null,
  }
}

// -------------------------------------------------- the slow probe: disks

/**
 * Throughput, drive health and temperatures — on their own, slower clock.
 *
 * Separate from the platform probe above for one measured reason. That probe is
 * .NET types only and costs 129ms cold; the counters wanted here are not in
 * .NET, and reading them costs 246ms on top. Folding them in would nearly
 * triple the cost of every sample of the readings people actually watch, to
 * refresh two that barely move: a drive's health verdict changes about once a
 * year, and a throughput rate averaged over five seconds is a *better* answer
 * than one averaged over two — it is long enough for a burst to show up as a
 * burst rather than as noise.
 *
 * So this runs off the critical path entirely. `readSystemStats` returns
 * whatever the last sample said and kicks off a new one when it has gone stale,
 * and never waits for it. The first sample after the pane opens is therefore
 * empty, which is the same rule the CPU delta already follows.
 */
const SLOW_TTL_MS = 5000

interface SlowProbe {
  /** Cumulative counters, turned into rates against the previous sample. */
  io: Array<{ name: string; label: string | null; read: number; write: number; idle: number | null; stamp: number | null }>
  health: DiskHealth[]
  temperatures: TemperatureStats[]
  /** The memory figures no process list contains. Null where unobtainable. */
  memory: MemoryDetail
  /** Battery detail from a sensor source, which the platform probe has no way to get. */
  battery: LhmBattery | null
  sources: { diskIo: string | null; health: string | null; temperature: string | null; temperatureNote: string | null }
}

interface MemoryDetail {
  available: number | null
  committed: number | null
  commitLimit: number | null
  kernel: number | null
}

const NO_MEMORY_DETAIL: MemoryDetail = { available: null, committed: null, commitLimit: null, kernel: null }

const EMPTY_SLOW: SlowProbe = {
  io: [],
  health: [],
  temperatures: [],
  memory: NO_MEMORY_DETAIL,
  battery: null,
  sources: { diskIo: null, health: null, temperature: null, temperatureNote: null },
}

let slowCache: { at: number; value: SlowProbe } | null = null
let slowInFlight: Promise<SlowProbe> | null = null

/**
 * The last slow sample, refreshing it in the background when it is stale.
 *
 * Returns immediately, always. This is the whole point of the split — nothing
 * about a 250ms probe should ever be in the way of a 2-second poll.
 */
function slowProbe(): SlowProbe {
  const now = Date.now()
  const fresh = slowCache && now - slowCache.at < SLOW_TTL_MS
  if (!fresh && !slowInFlight) {
    slowInFlight = runSlowProbe()
      .then((value) => {
        slowCache = { at: Date.now(), value }
        return value
      })
      .catch(() => slowCache?.value ?? EMPTY_SLOW)
      .finally(() => {
        slowInFlight = null
      })
  }
  return slowCache?.value ?? EMPTY_SLOW
}

function runSlowProbe(): Promise<SlowProbe> {
  if (process.platform === 'win32') return windowsSlow()
  if (process.platform === 'darwin') return macSlow()
  return linuxSlow()
}

// ------------------------------------------------------- Windows: the slow bits

/**
 * The three things Windows will say for free, in one process.
 *
 * Each line was measured before it was included, and one was measured and left
 * out. `Win32_PerfRawData_PerfDisk_PhysicalDisk` is the *raw* counter class, so
 * the values are cumulative and the rate is ours to compute — the same
 * arrangement the network counters already use, and the reason this needs only
 * one sample per interval rather than the two a formatted counter would.
 *
 * CIM rather than `System.Diagnostics.PerformanceCounter`, which is faster,
 * because performance counter *names* are localised and CIM property names are
 * not: `Disk Read Bytes/sec` does not exist on a German Windows and
 * `DiskReadBytesPersec` does. A monitor that silently reports nothing outside
 * the English-speaking world is worse than one that costs 200ms.
 *
 * `MSFT_StorageReliabilityCounter` is the one left out. It is where temperature,
 * wear and power-on hours live, it is one association away from the disks
 * already being read here — and every field of it comes back empty without an
 * administrator, which was measured on the machine this was written on. Asking
 * for elevation to draw a number is not a trade this app makes.
 */
const WINDOWS_SLOW = `$ErrorActionPreference='SilentlyContinue'
foreach ($d in Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk) {
  if ($d.Name -ne '_Total') { "I $($d.DiskReadBytesPersec) $($d.DiskWriteBytesPersec) $($d.PercentIdleTime) $($d.Timestamp_PerfTime) $($d.Name)" }
}
foreach ($p in Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk) {
  "H $($p.HealthStatus) $($p.MediaType) $($p.Size) $($p.DeviceId) $($p.FriendlyName)"
}
foreach ($m in Get-CimInstance Win32_PerfRawData_PerfOS_Memory) {
  "M $($m.AvailableBytes) $($m.CommittedBytes) $($m.CommitLimit) $($m.PoolNonpagedBytes) $($m.PoolPagedBytes)"
}
foreach ($ns in 'root/LibreHardwareMonitor','root/OpenHardwareMonitor') {
  foreach ($s in Get-CimInstance -Namespace $ns -ClassName Sensor -Filter "SensorType='Temperature'") {
    "T $($s.Value) $($s.Identifier) $($s.Name)"
  }
}`

async function windowsSlow(): Promise<SlowProbe> {
  // Side by side: the counters cost a process and the sensors cost a socket,
  // and neither waits on the other.
  const [stdout, lhm] = await Promise.all([
    runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SLOW]),
    readLhm(),
  ])
  const probe = parseWindowsSlow(stdout)

  // The WMI route is asked for first and usually answers with nothing — see
  // `lhm.ts` for why. Where the web server did answer, its readings win: it
  // publishes the drive sensors that WMI omits, and having both would list
  // every processor twice.
  probe.battery = lhm.battery

  if (lhm.temperatures.length) {
    probe.temperatures = lhm.temperatures
    probe.sources.temperature = 'LibreHardwareMonitor'
    probe.sources.temperatureNote = null
  }

  // A drive's temperature is the one figure Windows will not give up without
  // an administrator, and this is where it comes from instead. Matched on the
  // product name, which is what both sides call it — except where Windows sees
  // a USB enclosure and LibreHardwareMonitor sees the disk inside it, and then
  // there is no match to make and the row stays honest about not knowing.
  for (const drive of probe.health) {
    const seen = matchDrive(drive, lhm.disks)
    if (!seen) continue
    if (seen.temperature !== null) drive.temperature = seen.temperature
    // "Life" is what is left; wear is what is gone, which is the direction
    // people read a wear figure in.
    if (seen.lifePercent !== null) drive.wearPercent = Math.max(0, 100 - seen.lifePercent)
    drive.powerOnHours = seen.powerOnHours
    // Kept only when it says something the storage stack's name does not.
    if (seen.name && seen.name.trim() !== drive.name.trim()) drive.model = seen.name.trim()
  }

  return probe
}

/**
 * The same drive, seen by the storage stack and by a sensor source.
 *
 * **Capacity first, name second**, which is the opposite of the obvious order
 * and is what makes this work at all: the two do not always agree on the name.
 * An external SSD is reported by Windows under its *enclosure's* identity —
 * `ADATA ED600` — and by LibreHardwareMonitor under the *drive inside it*,
 * `Samsung SSD 870 QVO 8TB`. Those share no words. Their capacities agree to
 * five significant figures.
 *
 * The tolerance is a tenth of a percent, which is far tighter than the gap
 * between any two drive sizes anyone sells and far looser than the rounding the
 * sensor source does when it prints `8001.6 GB`.
 */
function matchDrive(drive: DiskHealth, disks: readonly LhmDisk[]): LhmDisk | undefined {
  if (drive.size) {
    const bySize = disks.find(
      (d) => d.totalBytes !== null && Math.abs(d.totalBytes - drive.size!) / drive.size! < 0.001
    )
    if (bySize) return bySize
  }
  return disks.find((d) => sameDevice(d.name, drive.name))
}

/** Product names from two sources, compared without punctuation or case. */
function sameDevice(a: string, b: string): boolean {
  const tidy = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '')
  return tidy(a) === tidy(b)
}

/** Exported for the tests, which run it against output from a real machine. */
export function parseWindowsSlow(stdout: string): SlowProbe {
  const io: SlowProbe['io'] = []
  const health: DiskHealth[] = []
  const temperatures: TemperatureStats[] = []
  let memory: MemoryDetail = NO_MEMORY_DETAIL
  /** Device number to product name, which is the only thing joining the two lists. */
  const deviceIds = new Map<string, string>()

  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('I ')) {
      // The name is last because it contains spaces — "0 C:" is one instance.
      const [read, write, idle, stamp, ...name] = line.slice(2).split(' ')
      io.push({
        name: name.join(' ').trim(),
        label: null,
        read: Number(read) || 0,
        write: Number(write) || 0,
        idle: Number(idle) || null,
        stamp: Number(stamp) || null,
      })
    } else if (line.startsWith('H ')) {
      const [status, media, size, id, ...name] = line.slice(2).split(' ')
      health.push({
        name: name.join(' ').trim(),
        status: WINDOWS_HEALTH[status] ?? 'unknown',
        kind: media === '4' ? 'ssd' : media === '3' ? 'hdd' : 'unknown',
        size: Number(size) || null,
        temperature: null,
        wearPercent: null,
        powerOnHours: null,
      })
      deviceIds.set(id, name.join(' ').trim())
    } else if (line.startsWith('M ')) {
      const [available, committed, limit, nonpaged, paged] = line.slice(2).split(' ').map(Number)
      memory = {
        available: Number.isFinite(available) ? available : null,
        committed: Number.isFinite(committed) ? committed : null,
        commitLimit: Number.isFinite(limit) ? limit : null,
        // The two pools together: both belong to drivers rather than to any
        // process, which is exactly why they are worth naming.
        kernel: Number.isFinite(nonpaged) && Number.isFinite(paged) ? nonpaged + paged : null,
      }
    } else if (line.startsWith('T ')) {
      const [value, identifier, ...name] = line.slice(2).split(' ')
      const celsius = Number(value)
      if (!Number.isFinite(celsius)) continue
      temperatures.push({
        name: name.join(' ').trim() || identifier,
        celsius: Math.round(celsius * 10) / 10,
        // The identifier is a path — `/intelcpu/0/temperature/0`, `/nvme/0/…`.
        kind: /\/(intelcpu|amdcpu|cpu)\//.test(identifier ?? '')
          ? 'cpu'
          : /\/(nvme|hdd|ssd)\//.test(identifier ?? '')
            ? 'disk'
            : 'other',
      })
    }
  }

  // The two lists name the same hardware differently and nothing connects them
  // but the device number: the counter calls a drive `0 C:` and the storage
  // stack calls it `SAMSUNG MZVLB512HBJQ-000L2`. The number leads the counter's
  // instance name, so that is the join — and where it fails, the label stays
  // null and the counter's own name is shown, which is ugly and true.
  for (const entry of io) {
    const id = /^(\d+)\b/.exec(entry.name)?.[1]
    if (id) entry.label = deviceIds.get(id) ?? null
  }

  return {
    io,
    health,
    temperatures,
    memory,
    battery: null,
    sources: {
      diskIo: io.length ? 'Windows performance counters' : null,
      health: health.length ? 'Windows storage stack' : null,
      temperature: temperatures.length ? 'LibreHardwareMonitor' : null,
      temperatureNote: temperatures.length
        ? null
        : 'Windows will not give a program a CPU or drive temperature without a signed kernel driver. Run LibreHardwareMonitor beside this, turn on Options → Remote Web Server → Run, and its readings appear here.',
    },
  }
}

/** What `MSFT_PhysicalDisk.HealthStatus` means. 5 is the storage stack's "no idea". */
const WINDOWS_HEALTH: Record<string, DiskHealth['status']> = {
  '0': 'ok',
  '1': 'warning',
  '2': 'bad',
  '5': 'unknown',
}

// --------------------------------------------------------- Linux: the slow bits

async function linuxSlow(): Promise<SlowProbe> {
  const [stats, temps] = await Promise.all([readFile('/proc/diskstats', 'utf8').catch(() => ''), linuxTemperatures()])
  const io = parseDiskstats(stats)

  // A drive's kind is free here and its health is not: the kernel publishes
  // whether a device spins, and everything else is behind SMART and root.
  const health: DiskHealth[] = []
  for (const entry of io) {
    let kind: DiskHealth['kind'] = 'unknown'
    try {
      const rotational = (await readFile(`/sys/block/${entry.name}/queue/rotational`, 'utf8')).trim()
      kind = rotational === '1' ? 'hdd' : 'ssd'
    } catch {
      // A device that vanished, or one with no queue directory.
    }
    const temperature = temps.find((t) => t.kind === 'disk' && entry.name.startsWith(t.name))?.celsius ?? null
    health.push({
      name: entry.name,
      status: 'unknown',
      kind,
      size: null,
      temperature,
      wearPercent: null,
      powerOnHours: null,
    })
  }

  return {
    io,
    health,
    temperatures: temps,
    memory: await linuxMemory(),
    battery: null,
    sources: {
      diskIo: io.length ? '/proc/diskstats' : null,
      health: health.length ? '/sys/block' : null,
      temperature: temps.length ? '/sys/class/hwmon' : null,
      temperatureNote: temps.length
        ? null
        : 'No sensors published under /sys/class/hwmon on this machine — common in a container, or on hardware with no driver loaded for its sensors.',
    },
  }
}

/**
 * `/proc/diskstats`, whole devices only.
 *
 * The columns are fixed and documented: after the major, minor and name come
 * reads completed, reads merged, **sectors read**, milliseconds reading, writes
 * completed, writes merged, **sectors written**, milliseconds writing, requests
 * in flight, **milliseconds doing I/O**. A sector here is always 512 bytes
 * regardless of what the hardware uses — that is a property of this file, not
 * of the disk, and it is the mistake that makes every figure wrong by a factor
 * of eight.
 *
 * Partitions are dropped so that `nvme0n1` is not counted again as `nvme0n1p1`,
 * along with the loop, ram and device-mapper entries that are not disks anybody
 * is asking about. Exported for the tests.
 */
export function parseDiskstats(raw: string): SlowProbe['io'] {
  const out: SlowProbe['io'] = []
  for (const line of raw.split('\n')) {
    const f = line.trim().split(/\s+/)
    if (f.length < 14) continue
    const name = f[2]
    if (!name || !isWholeDisk(name)) continue
    const sectorsRead = Number(f[5])
    const sectorsWritten = Number(f[9])
    const msDoingIo = Number(f[12])
    if (!Number.isFinite(sectorsRead) || !Number.isFinite(sectorsWritten)) continue
    out.push({
      name,
      // The kernel's own name for the device is already the friendly one.
      label: null,
      read: sectorsRead * 512,
      write: sectorsWritten * 512,
      // Milliseconds busy, carried in the same slot the Windows counter uses
      // for idle time — the two are turned into a percentage by different
      // arithmetic, so which one it is has to be known by the caller.
      idle: Number.isFinite(msDoingIo) ? msDoingIo : null,
      stamp: null,
    })
  }
  return out
}

function isWholeDisk(name: string): boolean {
  if (/^(loop|ram|zram|dm-|sr|fd)/.test(name)) return false
  // `nvme0n1` is a disk, `nvme0n1p1` is a partition of it.
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false
  if (/^mmcblk\d+p\d+$/.test(name)) return false
  // `sda` is a disk, `sda1` is a partition. Same for vd*, hd*, xvd*.
  if (/^(s|v|h|xv)d[a-z]+\d+$/.test(name)) return false
  return true
}

/**
 * The same four figures from `/proc/meminfo`, which names them outright.
 *
 * Linux is the easy one here: `MemAvailable` is the kernel's own estimate of
 * what a program could get without swapping — the number this whole exercise is
 * about — and `Committed_AS` is what has been promised. `Slab` is the closest
 * equivalent to Windows' driver pools. All in kibibytes.
 */
export function parseMeminfo(raw: string): MemoryDetail {
  const field = (name: string): number | null => {
    const m = new RegExp(`^${name}:\s+(\d+) kB$`, 'm').exec(raw)
    return m ? Number(m[1]) * 1024 : null
  }
  return {
    available: field('MemAvailable'),
    committed: field('Committed_AS'),
    commitLimit: field('CommitLimit'),
    kernel: field('Slab'),
  }
}

async function linuxMemory(): Promise<MemoryDetail> {
  try {
    return parseMeminfo(await readFile('/proc/meminfo', 'utf8'))
  } catch {
    return NO_MEMORY_DETAIL
  }
}

/**
 * Every temperature the kernel publishes, which needs no privileges at all.
 *
 * This is the reading Windows and macOS cannot give and Linux hands over in a
 * handful of file reads: `hwmon` exposes one directory per sensor chip, each
 * with a `name` and any number of `tempN_input` files in thousandths of a
 * degree. `coretemp` and `k10temp` are the CPU packages, `nvme` is a drive, and
 * everything else is a fan controller or a chipset sensor worth showing but not
 * worth naming as either.
 */
async function linuxTemperatures(): Promise<TemperatureStats[]> {
  const out: TemperatureStats[] = []
  let chips: string[]
  try {
    chips = await readdir('/sys/class/hwmon')
  } catch {
    return out
  }

  for (const chip of chips) {
    const base = `/sys/class/hwmon/${chip}`
    let chipName = ''
    try {
      chipName = (await readFile(`${base}/name`, 'utf8')).trim()
    } catch {
      continue
    }
    const kind: TemperatureStats['kind'] = /coretemp|k10temp|zenpower|cpu_thermal|soc_thermal/.test(chipName)
      ? 'cpu'
      : /nvme|drivetemp/.test(chipName)
        ? 'disk'
        : 'other'

    let entries: string[]
    try {
      entries = await readdir(base)
    } catch {
      continue
    }
    for (const entry of entries) {
      const m = /^temp(\d+)_input$/.exec(entry)
      if (!m) continue
      try {
        const milli = Number((await readFile(`${base}/${entry}`, 'utf8')).trim())
        if (!Number.isFinite(milli)) continue
        // Thousandths of a degree, and a sensor reading zero is one that is not
        // wired up rather than a component at freezing point.
        const celsius = milli / 1000
        if (celsius <= 0 || celsius > 150) continue
        let label = ''
        try {
          label = (await readFile(`${base}/temp${m[1]}_label`, 'utf8')).trim()
        } catch {
          // Most chips do not label their sensors.
        }
        out.push({
          name: label || (chipName ? `${chipName}${entries.length > 2 ? ` ${m[1]}` : ''}` : entry),
          celsius: Math.round(celsius * 10) / 10,
          kind,
        })
      } catch {
        // A sensor that went away mid-scan.
      }
    }
  }
  return out
}

// ----------------------------------------------------------- macOS: the slow bits

/**
 * Throughput from `ioreg`, and nothing else.
 *
 * macOS keeps per-drive byte counters in the IOKit registry, where any process
 * can read them — `iostat` is the obvious alternative and reports one combined
 * transfer figure rather than reads and writes apart, which is the distinction
 * worth having.
 *
 * There is no temperature here, on purpose. The SMC needs a helper of our own,
 * `powermetrics` needs sudo, and the Apple Silicon sensors are behind a private
 * framework that has broken between releases. All three are the driver this
 * file exists not to ship.
 */
async function macSlow(): Promise<SlowProbe> {
  const stdout = await runCommand('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-w0']).catch(() => '')
  const io = parseIoreg(stdout)
  return {
    io,
    health: [],
    temperatures: [],
    memory: NO_MEMORY_DETAIL,
    battery: null,
    sources: {
      diskIo: io.length ? 'ioreg' : null,
      health: null,
      temperature: null,
      temperatureNote:
        'macOS does not give a program a CPU temperature without a helper running as root, so none is shown.',
    },
  }
}

/**
 * The byte counters out of `ioreg`'s dump.
 *
 * The output is a nested plist-ish tree, and the two numbers wanted are in a
 * `Statistics` dictionary printed on one line. Matched rather than parsed: the
 * format has no closing structure to anchor on, and the keys are unambiguous.
 * Exported for the tests.
 */
export function parseIoreg(raw: string): SlowProbe['io'] {
  const out: SlowProbe['io'] = []
  let name = ''
  for (const line of raw.split('\n')) {
    const device = /"BSD Name" = "([^"]+)"/.exec(line)
    if (device) {
      name = device[1]
      continue
    }
    const read = /"Bytes \(Read\)"=(\d+)/.exec(line)
    const write = /"Bytes \(Write\)"=(\d+)/.exec(line)
    if (read && write) {
      out.push({
        name: name || `disk${out.length}`,
        label: null,
        read: Number(read[1]),
        write: Number(write[1]),
        idle: null,
        stamp: null,
      })
      name = ''
    }
  }
  return out
}

// -------------------------------------------------------------- disk rates

let previousIo: { at: number; byName: Map<string, { read: number; write: number; idle: number | null; stamp: number | null }> } | null = null

/**
 * Cumulative counters into rates, with the busy figure each platform can give.
 *
 * The two platforms count opposite things and the arithmetic differs, which is
 * why `idle` carries whichever one it is rather than a percentage: Windows
 * counts time *idle* in the same clock as its timestamp, so busy is what is
 * left over; Linux counts milliseconds *doing I/O* against the wall clock. Both
 * are clamped, because a disk with a deep queue can be credited with more busy
 * time than the interval contains.
 */
function diskRates(counters: SlowProbe['io'], at: number): DiskIoStats[] {
  const previous = previousIo
  const byName = new Map(counters.map((c) => [c.name, { read: c.read, write: c.write, idle: c.idle, stamp: c.stamp }]))
  const seconds = previous ? (at - previous.at) / 1000 : 0

  const out = counters.map((counter) => {
    const before = previous?.byName.get(counter.name)
    // A counter that went backwards is a device that was reset or renamed onto
    // the same name; there is no rate to report for that interval.
    const usable = before && seconds > 0 && counter.read >= before.read && counter.write >= before.write

    let busyPercent: number | null = null
    if (usable && counter.idle !== null && before!.idle !== null) {
      if (counter.stamp !== null && before!.stamp !== null && counter.stamp > before!.stamp) {
        // Windows: idle time and the timestamp share a clock, so the units
        // cancel and no conversion is needed or possible to get wrong.
        const idleFraction = (counter.idle - before!.idle) / (counter.stamp - before!.stamp)
        busyPercent = clampPercent(100 * (1 - idleFraction))
      } else {
        // Linux: milliseconds spent doing I/O over the interval in milliseconds.
        busyPercent = clampPercent((100 * (counter.idle - before!.idle)) / (seconds * 1000))
      }
    }

    return {
      name: counter.name,
      label: counter.label,
      readPerSec: usable ? Math.max(0, (counter.read - before!.read) / seconds) : null,
      writePerSec: usable ? Math.max(0, (counter.write - before!.write) / seconds) : null,
      busyPercent,
      readTotal: counter.read,
      writeTotal: counter.write,
    }
  })

  previousIo = { at, byName }
  return out
}

// --------------------------------------------------------------------- GPU

let gpuCache: { at: number; value: GpuStats[]; source: string | null } | null = null

/**
 * NVIDIA cards, via the tool that ships with their driver.
 *
 * The whole of the GPU story on a machine with no sensor daemon. It is not a
 * dependency and never becomes one: absent, this returns nothing and the panes
 * say there is no GPU source, which is the truth on an AMD or Intel machine
 * whatever we do.
 */
async function readGpus(): Promise<{ gpus: GpuStats[]; source: string | null }> {
  const now = Date.now()
  if (gpuCache && now - gpuCache.at < GPU_TTL_MS) {
    return { gpus: gpuCache.value, source: gpuCache.source }
  }

  let stdout = ''
  try {
    stdout = await runCommand('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw',
      '--format=csv,noheader,nounits',
    ])
  } catch {
    gpuCache = { at: now, value: [], source: null }
    return { gpus: [], source: null }
  }

  const gpus: GpuStats[] = []
  for (const line of stdout.split('\n')) {
    const fields = line.split(',').map((f) => f.trim())
    if (fields.length < 6 || !fields[0]) continue
    gpus.push({
      name: fields[0],
      load: number(fields[1]),
      temperature: number(fields[2]),
      // Reported in MiB; everything else in this file is bytes.
      memoryUsed: scale(number(fields[3]), 1024 * 1024),
      memoryTotal: scale(number(fields[4]), 1024 * 1024),
      power: number(fields[5]),
    })
  }

  const source = gpus.length ? 'nvidia-smi' : null
  gpuCache = { at: now, value: gpus, source }
  return { gpus, source }
}

/** `[N/A]` is what nvidia-smi prints for a reading the card does not take. */
function number(value: string | undefined): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function scale(value: number | null, factor: number): number | null {
  return value === null ? null : value * factor
}

// ------------------------------------------------------------ network rates

let previousNet: { at: number; byName: Map<string, { rx: number; tx: number }> } | null = null

function rates(
  counters: Array<{ name: string; rx: number; tx: number }>,
  at: number
): NetworkStats[] {
  const previous = previousNet
  const byName = new Map(counters.map((c) => [c.name, { rx: c.rx, tx: c.tx }]))
  const seconds = previous ? (at - previous.at) / 1000 : 0

  const out = counters.map((counter) => {
    const before = previous?.byName.get(counter.name)
    // A counter that went backwards is an interface that was reset or renamed
    // onto the same name; there is no rate to report for that interval.
    const usable = before && seconds > 0 && counter.rx >= before.rx && counter.tx >= before.tx
    return {
      name: counter.name,
      rxPerSec: usable ? Math.max(0, (counter.rx - before!.rx) / seconds) : null,
      txPerSec: usable ? Math.max(0, (counter.tx - before!.tx) / seconds) : null,
      rxTotal: counter.rx,
      txTotal: counter.tx,
    }
  })

  previousNet = { at, byName }
  return out
}

// ------------------------------------------------------------------- memory

/**
 * How much memory is gone, counting only what is genuinely gone.
 *
 * `total - free` is the subtraction everybody writes first and it overstates on
 * every modern OS, because the standby cache is "free" in the sense that
 * matters and "used" in the sense `os.freemem()` reports. Where the platform
 * gives a real *available* figure that one wins; where it does not, the old
 * arithmetic stands and is at least consistent.
 */
function sampleMemory(detail: MemoryDetail) {
  const total = os.totalmem()
  const free = os.freemem()
  const used = detail.available !== null ? Math.max(0, total - detail.available) : Math.max(0, total - free)
  return { total, used, free, ...detail }
}

// ------------------------------------------------------- this app's own cost

/**
 * Required lazily rather than imported at the top.
 *
 * Everything else in this file is plain Node, and keeping it that way is what
 * lets the suite bundle this module and run it — the readings are the whole
 * point of it, and a collector nothing can exercise outside a packaged Electron
 * app is a collector nobody checks. Outside Electron this throws and the
 * footprint reads as zero processes, which is the truth: there is no app.
 */
function appMetrics(): Array<{ cpu?: { percentCPUUsage?: number }; memory?: { workingSetSize?: number } }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as typeof import('electron')).app.getAppMetrics()
  } catch {
    return []
  }
}

function footprint() {
  const metrics = appMetrics()
  let cpu = 0
  let memory = 0
  for (const entry of metrics) {
    cpu += entry.cpu?.percentCPUUsage ?? 0
    // `workingSetSize` is in kilobytes, and is the number Task Manager shows.
    memory += (entry.memory?.workingSetSize ?? 0) * 1024
  }
  return { processes: metrics.length, cpu: Math.round(cpu * 10) / 10, memory }
}

// -------------------------------------------------------------------- entry

export async function readSystemStats(opts: { drives?: boolean } = {}): Promise<SystemStats> {
  const at = Date.now()
  // Node's own readings are taken first and synchronously, so the CPU delta is
  // measured across the poll interval rather than across however long the probe
  // and nvidia-smi happened to take this time round.
  const cpu = sampleCpu()


  // Never awaited: it runs on its own clock and hands back whatever it last
  // knew. See `slowProbe` for why the disk counters are not allowed to be in
  // the way of the readings people actually watch.
  // Skipped outright when the caller says it is not showing them: this is the
  // only expensive reading here, and a block nobody has on screen should not
  // cost a process every five seconds.
  const slow = opts.drives === false ? EMPTY_SLOW : slowProbe()
  const memory = sampleMemory(slow.memory)

  const [probe, gpu] = await Promise.all([platformProbe(), readGpus()])

  // A GPU that reports its own temperature is a temperature, and it is the one
  // most Windows machines have — so it joins the list rather than being a
  // reading that exists only in the GPU row.
  // `nvidia-smi` reports the card's temperature too, and where a sensor source
  // already covered the graphics card that would list it twice under two names.
  const haveGpuTemp = slow.temperatures.some((t) => t.kind === 'gpu')
  const temperatures = [
    ...slow.temperatures,
    ...(haveGpuTemp
      ? []
      : gpu.gpus
          .filter((card) => card.temperature !== null)
          .map((card) => ({
            name: card.name,
            celsius: card.temperature!,
            kind: 'gpu' as const,
            device: card.name,
          }))),
  ]

  return {
    at,
    cpu,
    memory,
    uptimeSeconds: os.uptime(),
    app: footprint(),
    disks: probe.disks,
    diskIo: diskRates(slow.io, at),
    health: slow.health,
    temperatures,
    networks: rates(probe.networks, at),
    gpus: gpu.gpus,
    // The platform knows the percentage and the estimate; the sensor source
    // knows what the pack has lost to age and what it is drawing. Merged rather
    // than one replacing the other, because neither has all of it.
    battery: probe.battery
      ? {
          ...probe.battery,
          wearPercent: slow.battery?.wearPercent ?? null,
          rateWatts: slow.battery?.rateWatts ?? null,
          remainingWh: slow.battery?.remainingWh ?? null,
          fullWh: slow.battery?.fullWh ?? null,
          designWh: slow.battery?.designWh ?? null,
        }
      : null,
    sources: {
      gpu: gpu.source,
      platform: probeCache !== null,
      diskIo: slow.sources.diskIo,
      health: slow.sources.health,
      temperature: temperatures.length ? (slow.sources.temperature ?? gpu.source) : null,
      temperatureNote: temperatures.length ? null : slow.sources.temperatureNote,
    },
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) reject(err)
        else resolve(stdout ?? '')
      }
    )
  })
}
