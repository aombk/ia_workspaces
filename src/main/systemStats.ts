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
import { existsSync } from 'node:fs'
import { readFile, readdir, statfs } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  ThermalPressure,
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

  return {
    model: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    load,
    perCore: percentages,
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
          cycleCount: null,
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
        cycleCount: null,
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
    cycleCount: null,
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
  sources: {
    diskIo: null,
    health: null,
    temperature: null,
    // Not null, and that is the difference between two things a blank card
    // cannot tell apart: a machine that will not report a temperature, and a
    // probe that has not come back yet. The drives card already says this for
    // the counters it shares a clock with; the sensors card had nothing to say
    // for the first few seconds and looked broken instead.
    temperatureNote:
      'Temperatures are read on a slower clock than the rest of this panel, so the first sample after opening it is empty.',
  },
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
 * Throughput, the memory breakdown, the pack, and the storage stack's verdict.
 *
 * macOS keeps per-drive byte counters in the IOKit registry, where any process
 * can read them — `iostat` is the obvious alternative and reports one combined
 * transfer figure rather than reads and writes apart, which is the distinction
 * worth having.
 *
 * The rest of this was assumed unobtainable and turned out not to be. The same
 * registry holds the battery's own controller, which publishes what the pack was
 * built to hold, what it holds now, what is flowing through it and how many
 * cycles it has been through — every field `pmset` leaves null, without a helper
 * and without an administrator. `vm_stat` holds the page counts behind Activity
 * Monitor's memory figures, which matter here because `os.freemem()` on macOS
 * counts only *free* pages and reports a machine using its memory well as a
 * machine that has run out. `diskutil` will state the storage stack's verdict on
 * a drive for nothing.
 *
 * What is still missing is degrees. The processor and NAND sensors are real and
 * readable without an administrator — `AppleEmbeddedNVMeTemperatureSensor`,
 * product `NAND CH0 temp`, is right there in the registry — but their values are
 * not registry properties: they come through `IOHIDEventSystemClient`, a C API
 * with no command-line spelling, so reading one costs a native module. The
 * battery is the exception and reports its temperature as a plain number, so
 * that is the one degree figure here. `powerMonitor` supplies the rest of the
 * answer in words rather than degrees — see `thermalPressure`.
 */
async function macSlow(): Promise<SlowProbe> {
  const [ioRaw, memory, battery, sensors] = await Promise.all([
    // `-d 2` is what makes a drive's name available, and stopping there is the
    // point. The driver node carries the counters and its whole-disk `IOMedia`
    // child carries the `BSD Name`, so one level down is exactly enough — while
    // the full subtree also contains every APFS container, each publishing a
    // `Statistics` dictionary of its own that would be listed as a drive which
    // does not exist. Two levels measured 1.8 KB here; all of them, 114 KB.
    runCommand('ioreg', ['-c', 'IOBlockStorageDriver', '-r', '-l', '-w0', '-d', '2']).catch(() => ''),
    macMemory(),
    macBatterySensor(),
    macSensors(),
  ])

  const io = parseIoreg(ioRaw)
  const health = await macHealth(io, sensors)

  // Every reading is labelled with what it measures rather than one of them
  // being allowed to stand in for the rest. A pane that says "38 °C" without
  // saying of what will be read as the processor, whatever it actually is.
  const temperatures: TemperatureStats[] = [...sensors]
  if (battery?.celsius != null && !temperatures.some((t) => t.device === 'Battery')) {
    temperatures.push({ name: 'Battery', celsius: battery.celsius, kind: 'other', device: 'Battery' })
  }

  return {
    io,
    health,
    temperatures,
    memory,
    battery,
    sources: {
      diskIo: io.length ? 'ioreg' : null,
      health: health.length ? 'diskutil' : null,
      temperature: temperatures.length ? (sensors.length ? 'the bundled sensor helper' : 'ioreg') : null,
      temperatureNote: temperatures.length ? null : MAC_TEMPERATURE_NOTE,
    },
  }
}

/**
 * Why a Mac shows no degrees, in a sentence, when it shows none.
 *
 * Worth being exact about, because the usual phrasing — "macOS needs root" — is
 * wrong and sends anybody who reads it looking for a `sudo` that would not help
 * either: `powermetrics` is the root-only route and on Apple Silicon does not
 * report a processor die temperature at all.
 */
const MAC_TEMPERATURE_NOTE =
  'macOS keeps its processor and drive sensors behind IOHIDEventSystem, which has no command-line spelling, so ' +
  'this app ships a small helper to read them — no administrator, nothing to install. Nothing answered here, ' +
  'which means either the helper is missing from this build or the machine has no such sensors. The thermal ' +
  'reading below is the OS’s own verdict and needs neither.'

/**
 * The sensors the bundled helper will name, classified and reduced.
 *
 * Everything the machine will say arrives here — 47 sensors on the Mac this was
 * written on — and almost none of it belongs on a panel. Three judgements, all
 * of them here rather than compiled into the helper, so that they are covered by
 * the suite and can be changed without a compiler:
 *
 * - **`tcal` is not a reading.** Every power-management unit publishes one
 *   beside its real sensors and it is a calibration constant: 51.82 °C on this
 *   machine, unmoved under load, and the *hottest* thing in the list. Reported,
 *   it would be the number the panel showed. The same trap the Windows path has
 *   in `NOT_A_READING`, in different words.
 * - **`tdie` is the die, `tdev` is not.** The die sensors are the processor;
 *   the device ones sit near it and several read −22 °C, which is a sensor that
 *   is not powered rather than a cold machine.
 * - **One row, not twenty-four.** An Apple SoC publishes a die sensor per
 *   cluster and they sit within two degrees of each other. The hottest is the
 *   number that matters and the other twenty-three are noise, so they collapse
 *   into one reading — named for what it is, since on this hardware the
 *   processor and the graphics are the same piece of silicon and reporting the
 *   figure twice under two headings would be inventing a second measurement.
 *
 * Exported for the tests.
 */
export function parseMacSensors(raw: string): TemperatureStats[] {
  const die: number[] = []
  const nand: number[] = []
  let battery: number | null = null

  for (const line of raw.split('\n')) {
    const [degrees, ...rest] = line.split('\t')
    const name = rest.join('\t').trim()
    const celsius = Number(degrees)
    if (!name || !Number.isFinite(celsius)) continue
    // A sensor that is not powered reads far below freezing, and one that reads
    // above 150 is a parse that went wrong rather than a machine on fire.
    if (celsius <= 0 || celsius > 150) continue
    if (/tcal/i.test(name)) continue

    if (/tdie|^SOC |^CPU /i.test(name)) die.push(celsius)
    else if (/NAND|SSD/i.test(name)) nand.push(celsius)
    else if (/battery/i.test(name)) battery = Math.max(battery ?? 0, celsius)
  }

  const out: TemperatureStats[] = []
  if (die.length) out.push({ name: 'SoC die', celsius: Math.max(...die), kind: 'cpu', device: 'SoC' })
  if (nand.length) out.push({ name: 'NAND', celsius: Math.max(...nand), kind: 'disk', device: 'NAND' })
  // The pack reports itself through `AppleSmartBattery` too and the two agree to
  // a tenth of a degree. Whichever answers first wins and the other is skipped,
  // because two rows called "Battery" reading 30.4 and 30.9 is a panel arguing
  // with itself.
  if (battery !== null) out.push({ name: 'Battery', celsius: battery, kind: 'other', device: 'Battery' })
  return out
}

/**
 * Where the sensor helper is, in a packaged app and in the dev tree.
 *
 * Checked once and remembered, including the answer "there isn't one": this runs
 * every five seconds and a missing file should cost a `spawn` that fails once,
 * not for the life of the process.
 */
let sensorBinary: string | null | undefined

function macSensorsBinary(): string | null {
  if (sensorBinary !== undefined) return sensorBinary

  const packaged = process.resourcesPath
    ? path.join(process.resourcesPath, 'resources', 'bin', 'macsensors')
    : ''
  const source = path.join(process.cwd(), 'resources', 'bin', 'macsensors')

  sensorBinary = packaged && existsSync(packaged) ? packaged : existsSync(source) ? source : null
  return sensorBinary
}

/** The helper's two columns, or nothing at all where it did not run. */
async function macSensors(): Promise<TemperatureStats[]> {
  const binary = macSensorsBinary()
  if (!binary) return []
  const stdout = await runCommand(binary, []).catch(() => '')
  return parseMacSensors(stdout)
}

/**
 * The memory figures behind Activity Monitor, from `vm_stat` and `sysctl`.
 *
 * Two processes rather than one because they answer unrelated questions and
 * neither is expensive; both are on the five-second clock in any case.
 */
async function macMemory(): Promise<MemoryDetail> {
  const [vm, swap] = await Promise.all([
    runCommand('vm_stat', []).catch(() => ''),
    runCommand('sysctl', ['-n', 'vm.swapusage']).catch(() => ''),
  ])

  const pages = parseVmStat(vm)
  const swapping = parseSwapusage(swap)
  const total = os.totalmem()

  return {
    available: pages.available,
    // Wired is what the kernel and its drivers have pinned and no process can
    // give back, which is the same thing this field carries on Windows under
    // another name.
    kernel: pages.wired,
    // macOS has no commit charge, but it has the thing commit charge is *for*:
    // how much has been promised against how much can be backed. Anonymous
    // memory that no longer fits goes to swap, so the ceiling is physical
    // memory plus whatever swap has been allocated, and the charge against it
    // is what is in use plus what has already been pushed out. Swap on macOS
    // grows on demand, so a machine that has never needed any reports a ceiling
    // equal to its RAM — which is true, not missing.
    committed: pages.available === null || swapping.used === null ? null : total - pages.available + swapping.used,
    commitLimit: swapping.total === null ? null : total + swapping.total,
  }
}

/**
 * Page counts out of `vm_stat`, in bytes.
 *
 * The page size is read from the header rather than assumed, and that is not
 * pedantry: Apple Silicon pages are 16 KB and the 4 KB every example on the
 * internet hardcodes would report a quarter of the memory the machine has.
 *
 * "Available" is free plus what can be taken back without asking a process to
 * give it up — inactive, speculative and purgeable pages. That is the same rule
 * Linux's `MemAvailable` follows and it lands within a few hundred megabytes of
 * what Activity Monitor computes from the other direction. Exported for the
 * tests.
 */
export function parseVmStat(raw: string): { available: number | null; wired: number | null } {
  const pageSize = Number(/page size of (\d+) bytes/.exec(raw)?.[1]) || 4096
  const pages = (label: string): number | null => {
    const found = new RegExp(`^${label}:\\s+(\\d+)\\.?\\s*$`, 'm').exec(raw)
    return found ? Number(found[1]) : null
  }

  const reclaimable = [pages('Pages free'), pages('Pages inactive'), pages('Pages speculative'), pages('Pages purgeable')]
  const wired = pages('Pages wired down')

  // All four or none: a partial sum is a memory figure that is wrong by
  // gigabytes and looks exactly like a machine under pressure.
  const counted = reclaimable.filter((count): count is number => count !== null)

  return {
    available: counted.length === reclaimable.length ? counted.reduce((sum, count) => sum + count, 0) * pageSize : null,
    wired: wired === null ? null : wired * pageSize,
  }
}

/**
 * `total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)`, in bytes.
 *
 * Written to parse the whole line whether or not `sysctl` was asked for the
 * name alongside the value, and to read the unit rather than assume megabytes —
 * a machine swapping hard reports gigabytes and nothing else changes. Exported
 * for the tests.
 */
export function parseSwapusage(raw: string): { total: number | null; used: number | null } {
  const field = (name: string): number | null => {
    const found = new RegExp(`${name}\\s*=\\s*([\\d.]+)([KMGT])?`, 'i').exec(raw)
    if (!found) return null
    const scale = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[found[2]?.toUpperCase() ?? 'M'] ?? 1024 ** 2
    return Number(found[1]) * scale
  }
  return { total: field('total'), used: field('used') }
}

/**
 * The pack itself, from its own controller.
 *
 * Everything `pmset -g batt` leaves null. `AppleSmartBattery` publishes the
 * capacities in milliamp-hours and the voltage in millivolts, so watt-hours and
 * watts are one multiplication away, and it publishes them to any process.
 */
async function macBatterySensor(): Promise<MacBattery | null> {
  const stdout = await runCommand('ioreg', ['-rn', 'AppleSmartBattery', '-w0']).catch(() => '')
  return parseSmartBattery(stdout)
}

/** `LhmBattery` plus the one degree figure a Mac gives up for free. */
type MacBattery = LhmBattery & { celsius: number | null }

/**
 * `AppleSmartBattery`'s registry properties, in the units people use.
 *
 * Three conversions worth stating, because each has a trap in it:
 *
 * - **Watt-hours** are milliamp-hours times millivolts over a million. The pack
 *   reports charge, not energy, and a percentage of a capacity in mAh is not
 *   comparable between machines while watt-hours are.
 * - **Amperage is signed, and printed unsigned.** `ioreg` renders the property
 *   as a 64-bit unsigned integer, so a battery discharging at 277 mA reads
 *   `18446744073709551339`. Read through `BigInt` and folded back below zero —
 *   `Number` cannot hold the value long enough to subtract from it.
 * - **Wear cannot go below zero.** A pack out of the factory holds *more* than
 *   its design capacity, so the obvious subtraction gives a negative wear
 *   figure and a panel that reports a new battery as −3% worn.
 *
 * Exported for the tests.
 */
export function parseSmartBattery(raw: string): MacBattery | null {
  // Both spellings occur in one dump: `"Key" = 1` at the top level of a node
  // and `"Key"=1` inside a nested dictionary printed on a single line.
  const value = (key: string): bigint | null => {
    const found = new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`).exec(raw)
    return found ? BigInt(found[1]) : null
  }
  const num = (key: string): number | null => {
    const found = value(key)
    return found === null ? null : Number(found)
  }

  const design = num('DesignCapacity')
  const full = num('AppleRawMaxCapacity')
  const remaining = num('AppleRawCurrentCapacity')
  const millivolts = num('Voltage')
  if (design === null && full === null && remaining === null) return null

  const wh = (milliampHours: number | null): number | null =>
    milliampHours === null || millivolts === null ? null : (milliampHours * millivolts) / 1_000_000

  let rateWatts: number | null = null
  const amperage = value('InstantAmperage')
  if (amperage !== null && millivolts !== null) {
    const signed = amperage >= 1n << 63n ? amperage - (1n << 64n) : amperage
    rateWatts = (Number(signed) * millivolts) / 1_000_000
  }

  const centidegrees = num('Temperature')

  return {
    chargePercent: design === null || remaining === null ? null : clampPercent((100 * remaining) / design),
    wearPercent: design === null || full === null || design === 0 ? null : Math.max(0, 100 * (1 - full / design)),
    rateWatts,
    remainingWh: wh(remaining),
    fullWh: wh(full),
    designWh: wh(design),
    cycleCount: num('CycleCount'),
    // Hundredths of a degree Celsius. A pack reading 90 °C is a parse that went
    // wrong rather than a fire, so anything implausible is dropped.
    celsius: centidegrees === null || centidegrees <= 0 || centidegrees > 8000 ? null : centidegrees / 100,
  }
}

/**
 * The storage stack's verdict per drive, from `diskutil`.
 *
 * A verdict and nothing more: Apple's internal NVMe does not expose its SMART
 * log through `diskutil`, so there is a pass/fail and no attributes behind it —
 * no wear indicator, no power-on hours, no temperature. Those need
 * `smartmontools`, which is a program somebody has to install and this file does
 * not ask for. What is here is still worth having, for the same reason the
 * Windows health verdict is: it is the difference between a drive nobody has
 * checked and a drive that has started failing.
 *
 * One call per drive, and the drives are the ones the counters already found, so
 * the verdict lands on a row that exists rather than beside it. `diskutil` is
 * asked by BSD name and the answer is filed under whatever the panel calls that
 * row, which is the media's name where `ioreg` gave one — the two lists are
 * joined on that string and on Windows they already are.
 */
async function macHealth(
  drives: SlowProbe['io'],
  sensors: readonly TemperatureStats[]
): Promise<DiskHealth[]> {
  // The NAND sensors are on the SoC's own storage controller, so the reading
  // belongs to the built-in drive and to no other. An external disk in an
  // enclosure has no such sensor and must not inherit this one — which is why
  // `Internal` is read at all.
  const nand = sensors.find((reading) => reading.device === 'NAND')?.celsius ?? null

  const answers = await Promise.all(
    drives.map(async (drive) => {
      const plist = await runCommand('diskutil', ['info', '-plist', drive.name]).catch(() => '')
      const info = parseDiskutilInfo(plist)
      if (!info) return null
      const { internal, ...health } = info
      return { name: drive.label ?? drive.name, ...health, temperature: internal ? nand : null }
    })
  )
  return answers.filter((entry): entry is DiskHealth => entry !== null)
}

/**
 * `diskutil info -plist`, read by key rather than parsed as a plist.
 *
 * The four values wanted each sit on the line after their `<key>`, and the file
 * has no repeated keys at the depth they are at, so matching the pair is exact
 * and costs nothing. A plist parser would be a dependency to read four scalars.
 * Exported for the tests.
 */
export function parseDiskutilInfo(raw: string): (Omit<DiskHealth, 'name'> & { internal: boolean }) | null {
  const str = (key: string): string | null =>
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(raw)?.[1] ?? null
  const int = (key: string): number | null => {
    const found = new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`).exec(raw)
    return found ? Number(found[1]) : null
  }
  const bool = (key: string): boolean | null => {
    const found = new RegExp(`<key>${key}</key>\\s*<(true|false)\\s*/>`).exec(raw)
    return found ? found[1] === 'true' : null
  }

  const verdict = str('SMARTStatus')
  const solid = bool('SolidState')
  const size = int('TotalSize') ?? int('Size')
  if (verdict === null && solid === null && size === null) return null

  return {
    // `Verified` is the pass. Everything else is either a failure or one of the
    // several ways of saying the drive would not answer, and those are `unknown`
    // rather than a problem — an internal Apple SSD reports `Not Supported` and
    // is perfectly healthy.
    status: verdict === 'Verified' ? 'ok' : /fail/i.test(verdict ?? '') ? 'bad' : 'unknown',
    kind: solid === null ? 'unknown' : solid ? 'ssd' : 'hdd',
    size,
    // Filled in by `macHealth` for the built-in drive, from the NAND sensors.
    // `diskutil` itself has no temperature and no SMART attributes behind its
    // verdict — those need smartmontools, which is a program somebody has to
    // install and this file does not ask for.
    temperature: null,
    wearPercent: null,
    powerOnHours: null,
    model: str('MediaName') ?? undefined,
    // Whether the NAND reading is this drive's to inherit.
    internal: bool('Internal') ?? false,
  }
}

/**
 * The byte counters out of `ioreg`'s dump.
 *
 * The output is a nested plist-ish tree, and the two numbers wanted are in a
 * `Statistics` dictionary printed on one line. Matched rather than parsed: the
 * format has no closing structure to anchor on, and the keys are unambiguous.
 *
 * The name arrives on either side of the counters and both orders are real. A
 * node that publishes its own `BSD Name` states it before its properties; the
 * block storage *driver* has no name of its own and its counters are followed by
 * the whole-disk `IOMedia` child that does — which is the order `macSlow`'s
 * `-d 2` dump comes in, and the reason a drive is no longer called `disk0`
 * because it happened to be first. So a name waits for counters, counters wait
 * for a name, and whichever completes the pair emits it. Exported for the tests.
 */
export function parseIoreg(raw: string): SlowProbe['io'] {
  const out: SlowProbe['io'] = []
  let name = ''
  let label: string | null = null
  let counters: { read: number; write: number } | null = null

  const emit = (device: string, stats: { read: number; write: number }): void => {
    out.push({ name: device, label, read: stats.read, write: stats.write, idle: null, stamp: null })
    name = ''
    label = null
    counters = null
  }

  for (const line of raw.split('\n')) {
    // What the media calls itself — `APPLE SSD AP0256Z Media`. The registry's
    // own suffix, since every one of them is a `Media`, is not part of a name
    // anybody would recognise.
    const media = /\+-o (.+?) +<class IOMedia[,>]/.exec(line)
    if (media) {
      label = media[1].replace(/ Media$/, '')
      continue
    }

    const device = /"BSD Name" = "([^"]+)"/.exec(line)
    if (device) {
      if (counters) emit(device[1], counters)
      else name = device[1]
      continue
    }

    const read = /"Bytes \(Read\)"=(\d+)/.exec(line)
    const write = /"Bytes \(Write\)"=(\d+)/.exec(line)
    if (read && write) {
      const stats = { read: Number(read[1]), write: Number(write[1]) }
      if (name) emit(name, stats)
      else counters = stats
    }
  }

  // Counters that never met a name. Numbered by position, which is what this
  // did for every drive before the name was available and is still the only
  // thing left to call one.
  if (counters) emit(`disk${out.length}`, counters)
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
 * NVIDIA cards, via the tool that ships with their driver — or IOKit on a Mac.
 *
 * On Windows and Linux `nvidia-smi` is the whole of the GPU story on a machine
 * with no sensor daemon. It is not a dependency and never becomes one: absent,
 * this returns nothing and the panes say there is no GPU source, which is the
 * truth on an AMD or Intel machine whatever we do.
 *
 * macOS is the one platform where the graphics card answers for nothing, which
 * is why it gets its own path rather than reporting the empty answer that was
 * here before. See `macGpus`.
 */
async function readGpus(): Promise<{ gpus: GpuStats[]; source: string | null }> {
  const now = Date.now()
  if (gpuCache && now - gpuCache.at < GPU_TTL_MS) {
    return { gpus: gpuCache.value, source: gpuCache.source }
  }
  if (process.platform === 'darwin') {
    const answer = await macGpus()
    gpuCache = { at: now, value: answer.gpus, source: answer.source }
    return answer
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

/**
 * The graphics card on a Mac, out of the IOKit registry.
 *
 * Every accelerator publishes a `PerformanceStatistics` dictionary — how busy
 * the device is and how much memory it is holding — and its own `model` string
 * beside it, to any process, in one command that measures a few milliseconds.
 * `system_profiler SPDisplaysDataType` is the obvious alternative and is
 * skipped: it costs a third of a second, it is the same name, and it has no
 * utilisation figure at all.
 *
 * `-d 1` for the same reason `macSlow` uses `-d 2` — the accelerator's children
 * publish statistics of their own, per command queue, and they are not the card.
 */
async function macGpus(): Promise<{ gpus: GpuStats[]; source: string | null }> {
  const stdout = await runCommand('ioreg', ['-r', '-d', '1', '-w0', '-c', 'IOAccelerator']).catch(() => '')
  const gpus = parseIoAccelerator(stdout)
  return { gpus, source: gpus.length ? 'ioreg' : null }
}

/**
 * `PerformanceStatistics` per accelerator, and what the accelerator is called.
 *
 * Two readings are deliberately null rather than guessed. **Total memory**,
 * because Apple Silicon has none to report — the GPU shares the machine's
 * memory, so the honest answer is how much it is using and no denominator, and
 * filling in the system total would draw a card at 5% of the RAM as a card at 5%
 * of its VRAM. **Temperature and watts**, because those live in `powermetrics`
 * behind an administrator. Exported for the tests.
 */
export function parseIoAccelerator(raw: string): GpuStats[] {
  const out: GpuStats[] = []

  // Split on node boundaries rather than read line by line, because `ioreg`
  // prints a node's properties in no useful order: on the machine this was
  // written on `"model"` — the card's actual name, `Apple M4` — comes *after*
  // the statistics it belongs to, and a streaming parser labels every card with
  // its class instead, `AGXAcceleratorG16G`.
  for (const node of raw.split(/^\s*\+-o /m).slice(1)) {
    const stats = /"PerformanceStatistics" = \{(.*)\}/.exec(node)
    if (!stats) continue

    const field = (key: string): number | null => {
      const found = new RegExp(`"${key}"\\s*=\\s*(\\d+)`).exec(stats[1])
      return found ? Number(found[1]) : null
    }

    const model = /"model" = "?([^"\n<]+)"?/.exec(node)
    const cls = /^(\S+) +<class /.exec(node)

    out.push({
      name: (model?.[1] ?? cls?.[1] ?? 'Graphics').trim(),
      load: field('Device Utilization %'),
      temperature: null,
      // Already bytes, unlike nvidia-smi's mebibytes.
      memoryUsed: field('In use system memory') ?? field('Alloc system memory'),
      memoryTotal: null,
      power: null,
    })
  }
  return out
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

/**
 * Interface name -> the addresses it holds.
 *
 * From `os.networkInterfaces()` rather than the platform probe, because every
 * platform already keys its byte counters by the same name the OS uses here —
 * `en0`, `eth0`, `Wi-Fi` — so the two join without a second command to run.
 *
 * Dropped: anything internal, which is loopback, and IPv6 link-local, which
 * every interface has and none of it means anything to a person reading the
 * block. IPv4 link-local (169.254.x) stays — an adapter that failed to get a
 * lease is worth seeing, and seeing it is how you find that out.
 */
function interfaceAddresses(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    const usable = (entries ?? []).filter(
      (entry) => !entry.internal && !entry.address.toLowerCase().startsWith('fe80:')
    )
    if (!usable.length) continue
    const four = usable.filter((e) => e.family === 'IPv4').map((e) => e.address)
    const six = usable.filter((e) => e.family !== 'IPv4').map((e) => e.address)
    out.set(name, [...four, ...six])
  }
  return out
}

function rates(
  counters: Array<{ name: string; rx: number; tx: number }>,
  at: number
): NetworkStats[] {
  const previous = previousNet
  const byName = new Map(counters.map((c) => [c.name, { rx: c.rx, tx: c.tx }]))
  const seconds = previous ? (at - previous.at) / 1000 : 0
  const addresses = interfaceAddresses()

  const out = counters.map((counter) => {
    const before = previous?.byName.get(counter.name)
    // A counter that went backwards is an interface that was reset or renamed
    // onto the same name; there is no rate to report for that interval.
    const usable = before && seconds > 0 && counter.rx >= before.rx && counter.tx >= before.tx
    return {
      name: counter.name,
      addresses: addresses.get(counter.name) ?? [],
      rxPerSec: usable ? Math.max(0, (counter.rx - before!.rx) / seconds) : null,
      txPerSec: usable ? Math.max(0, (counter.tx - before!.tx) / seconds) : null,
      rxTotal: counter.rx,
      txTotal: counter.tx,
    }
  })

  previousNet = { at, byName }
  return interesting(out)
}

/**
 * Lifetime traffic that makes an interface worth a row of its own.
 *
 * A megabyte is small enough that anything genuinely carrying traffic clears it
 * within seconds of being used, and large enough to sit far above what an idle
 * virtual interface accumulates — the ones this exists to hide had moved between
 * 1 and 24 *bytes* since boot.
 */
const NETWORK_FLOOR_BYTES = 1024 * 1024

/**
 * The interfaces worth showing, out of everything the machine admits to having.
 *
 * A modern OS invents network interfaces for services it *might* use, and then
 * leaves them up. A Mac reports upwards of twenty: `utun0`–`utun5` for iCloud
 * Private Relay and the Continuity transports, `awdl0` for AirDrop, `llw0` for
 * Sidecar, `ap1` for Internet Sharing, `bridge0` and `en1`–`en4` for Thunderbolt
 * ports with nothing plugged into them, plus `gif0` and `stf0`, which have been
 * there since the 2000s and are used by nothing. Windows adds one per VPN client
 * and Hyper-V switch; Linux adds `docker0` and a `veth` per container. Almost
 * none of them ever carry a byte, and listing them all buries the one interface
 * the machine is actually on.
 *
 * Two ways to earn a row, because either one alone is wrong. *Has carried real
 * traffic* on its own would hide a VPN that just came up. *Is carrying traffic
 * now* on its own would make the Wi-Fi vanish from the panel whenever the
 * machine went quiet, which is a monitor that deletes rows while you watch.
 *
 * The busiest interface is kept whatever it scores, so a freshly booted machine
 * that has not yet moved a megabyte shows the connection it is on rather than an
 * empty card.
 *
 * Exported for the tests.
 */
export function interesting(all: NetworkStats[]): NetworkStats[] {
  const moving = (net: NetworkStats): boolean => (net.rxPerSec ?? 0) > 0 || (net.txPerSec ?? 0) > 0
  const kept = all.filter((net) => net.rxTotal + net.txTotal >= NETWORK_FLOOR_BYTES || moving(net))
  if (kept.length) return kept

  const busiest = all.reduce<NetworkStats | null>(
    (best, net) => (!best || net.rxTotal + net.txTotal > best.rxTotal + best.txTotal ? net : best),
    null
  )
  return busiest ? [busiest] : []
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

/**
 * How hot macOS thinks it is, in the only terms it will state without a helper.
 *
 * `NSProcessInfo.thermalState`, which Electron surfaces directly. Not a
 * temperature and not a substitute for one, but it is the OS saying whether it
 * has started slowing itself down — which is the thing a temperature is usually
 * being read to find out, and the only answer to that question available here
 * without a native module.
 *
 * Lazily required for the same reason the footprint is: this file has to stay
 * runnable outside Electron or the suite cannot exercise it. Null everywhere but
 * macOS, where the API exists on paper and answers `unknown`.
 */
function thermalPressure(): ThermalPressure | null {
  if (process.platform !== 'darwin') return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const state = (require('electron') as typeof import('electron')).powerMonitor.getCurrentThermalState()
    return state === 'unknown' ? null : state
  } catch {
    return null
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
    thermalPressure: thermalPressure(),
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
          cycleCount: slow.battery?.cycleCount ?? null,
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
