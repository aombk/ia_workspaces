/**
 * Sensors from LibreHardwareMonitor, when somebody is running it.
 *
 * This is the one route to a processor or drive temperature on Windows that
 * does not involve this app shipping a kernel driver. The reasoning is in
 * `systemStats.ts` and has not changed — reading a thermal sensor is a ring-0
 * operation, the driver that does it has to be signed, and a terminal that
 * installs one is a terminal that gets flagged by antivirus. What *has* changed
 * is the other end: LibreHardwareMonitor swapped WinRing0 for PawnIO in
 * September 2025, so the driver a user installs for it is now a signed one that
 * runs sandboxed modules rather than handing ring-0 to anything that asks.
 *
 * So: if it is running and publishing, we read it. If it is not, nothing here
 * happens and the panel says so. We never start it, never install anything, and
 * never ask for elevation.
 *
 * **Why HTTP and not WMI.** LibreHardwareMonitor is documented as publishing to
 * the `root\LibreHardwareMonitor` WMI namespace, and `systemStats.ts` asks for
 * that first. On the machine this was written against, with the app running and
 * elevated, that namespace did not exist — registering it happens at startup
 * and quietly does nothing if the conditions are not met, which leaves no way
 * to tell "not installed" from "installed and silent". The web server has no
 * such failure: it is one checkbox, it either answers on the port or it does
 * not, and reading it needs no privileges at our end at all.
 */
import type { TemperatureStats } from '../shared/types'

/**
 * Where LibreHardwareMonitor's web server listens, when it is switched on.
 *
 * `127.0.0.1` rather than `localhost`: on Windows that name resolves to the
 * IPv6 loopback first, and a server bound only to IPv4 costs a failed connection
 * and its timeout before anything succeeds.
 */
const LHM_URL = 'http://127.0.0.1:8085/data.json'

/**
 * Long enough for a local server that is there, short enough not to be felt
 * when it is not. Nothing waits on this — see `slowProbe`.
 */
const LHM_TIMEOUT_MS = 1200

/**
 * One node of the tree the server returns.
 *
 * The shape is a computer at the root, hardware under it, a group per kind of
 * reading under that, and the sensors themselves as leaves. Only leaves carry
 * `SensorId` and `Type`, which is what makes them findable without caring how
 * deep the tree happens to be on a given machine.
 */
interface LhmNode {
  Text?: string
  Value?: string
  Type?: string
  SensorId?: string
  Children?: LhmNode[]
}

/**
 * One drive, as LibreHardwareMonitor sees it.
 *
 * Collected separately from the temperature list because these are what
 * Windows will not report without an administrator — wear and hours powered —
 * and because `totalBytes` turns out to be the only reliable way to match a
 * drive here to the same drive in the storage stack. Names do not always agree:
 * an external SSD is reported by Windows under its *enclosure's* identity and
 * by LibreHardwareMonitor under the *drive's*, and they share no words at all.
 */
export interface LhmDisk {
  name: string
  /** The live reading, not one of the thresholds beside it. */
  temperature: number | null
  /** Percent of rated write life remaining. */
  lifePercent: number | null
  powerOnHours: number | null
  /** Capacity in bytes, which is what the matching is done on. */
  totalBytes: number | null
}

/**
 * The battery, in the detail Windows will not give up on its own.
 *
 * `GetSystemPowerStatus` — what the platform probe uses — answers with a
 * percentage, a charging flag and an estimate of minutes left, and that is all
 * it has. Everything that says whether the *battery itself* is still any good
 * is here instead: how far it has degraded from its designed capacity, and how
 * many watts are going in or out right now.
 */
export interface LhmBattery {
  chargePercent: number | null
  /** How much capacity has been lost to age, as a percentage of the design. */
  wearPercent: number | null
  /** Watts. Positive charging, negative discharging — see `readLhm`. */
  rateWatts: number | null
  remainingWh: number | null
  fullWh: number | null
  designWh: number | null
  /**
   * Charge cycles, where the source counts them.
   *
   * LibreHardwareMonitor does not publish one, so this is null on Windows and
   * carries a figure only where the platform reads the pack directly — see
   * `parseSmartBattery` in `systemStats.ts`.
   */
  cycleCount: number | null
}

export interface LhmReading {
  temperatures: TemperatureStats[]
  disks: LhmDisk[]
  battery: LhmBattery | null
}

/**
 * Readings that are not readings.
 *
 * Every NVMe drive publishes its warning and critical thresholds as
 * temperature sensors sitting right beside the live one, and every DIMM
 * publishes four more. They are constants — 83 °C, 84 °C — and putting them on
 * screen would show a drive at 52 °C as being at 84. Excluded by what they call
 * themselves, which is the only thing distinguishing them.
 *
 * `Distance to TjMax` is the one that is not a constant and is still not a
 * temperature: Intel parts publish the *headroom* left before throttling, in
 * degrees, as a Temperature sensor. At idle it is the largest number in the
 * processor's list — a core at 45 with 55 to spare — so anything reaching for
 * the worst reading picks up the headroom and reports it as the temperature.
 */
const NOT_A_READING = /limit|warning|critical|resolution|threshold|distance to/i

/**
 * What a sensor is attached to, from the path it names itself by.
 *
 * The paths are stable and self-describing — `/amdcpu/0/temperature/2`,
 * `/nvme/0/temperature/0`, `/gpu-nvidia/0/temperature/0` — which makes them a
 * better classifier than the display name, since the display name is whatever
 * the vendor wrote in the firmware.
 */
function kindOf(sensorId: string): TemperatureStats['kind'] {
  if (/^\/(amdcpu|intelcpu|cpu)\//.test(sensorId)) return 'cpu'
  if (/^\/gpu/.test(sensorId)) return 'gpu'
  if (/^\/(nvme|ssd|hdd)\//.test(sensorId)) return 'disk'
  if (/^\/memory\//.test(sensorId)) return 'memory'
  return 'other'
}

/**
 * `"89.9 °C"` into `89.9`.
 *
 * A comma is accepted as the decimal separator because the server formats with
 * the machine's locale, and on a German or Greek Windows every reading comes
 * back as `"89,9 °C"` — which `parseFloat` would read as 89 exactly, silently,
 * and only for some users.
 */
export function parseValue(value: string | undefined): number | null {
  if (!value) return null
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(value)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/**
 * `"8001.6 GB"` into bytes.
 *
 * Decimal units, not binary: the server reports the 8 TB drive in this machine
 * as 8001.6 GB and the storage stack reports it as 8001563222016 bytes, which
 * agree only if a gigabyte is 10^9. Reading them as gibibytes would put the
 * figure out by 7% and quietly break every match made against it.
 */
export function parseBytes(value: string | undefined): number | null {
  const n = parseValue(value)
  if (n === null) return null
  const unit = /([kmgt])b\s*$/i.exec(value ?? '')?.[1]?.toLowerCase()
  const scale = unit === 't' ? 1e12 : unit === 'g' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1
  return n * scale
}

/**
 * Walks the tree and takes every live temperature.
 *
 * The device a sensor belongs to is its **grandparent** — the tree runs
 * computer → hardware → group of readings → sensor, so the parent is a heading
 * like "Temperatures" and the one above it is the drive or the processor. Taken
 * by position from the end rather than by absolute depth, which was the first
 * attempt and was wrong: the root turned out to be a wrapper above the computer,
 * so every device came back named after the machine.
 *
 * Carried rather than re-derived, because a sensor's own name is `Composite
 * Temperature` on every NVMe drive in the machine and says nothing about which.
 *
 * Exported, and tested against a capture from a real machine: this format is
 * somebody else's and can change under us, and every failure mode of a silent
 * tree-walk is an empty list rather than an error.
 */
export function parseLhm(root: unknown): LhmReading {
  const temperatures: TemperatureStats[] = []
  /** Per drive, keyed by the sensor path prefix — `/nvme/0`, `/ssd/2`. */
  const drives = new Map<string, LhmDisk>()
  let battery: LhmBattery | null = null
  if (!root || typeof root !== 'object') return { temperatures, disks: [], battery: null }

  const visit = (node: LhmNode, ancestors: string[]): void => {
    const children = node.Children ?? []
    const sensorId = node.SensorId

    if (sensorId && !children.length) {
      const device = ancestors[ancestors.length - 2]?.trim() || undefined
      const name = (node.Text ?? '').trim()

      if (node.Type === 'Temperature') {
        const celsius = parseValue(node.Value)
        // A sensor reading zero is one that is not wired up rather than a
        // component at freezing point, and the thresholds sit at plausible
        // temperatures so they cannot be filtered by value.
        if (celsius !== null && celsius > 0 && celsius < 150 && !NOT_A_READING.test(name)) {
          temperatures.push({
            name: name || sensorId,
            celsius: Math.round(celsius * 10) / 10,
            kind: kindOf(sensorId),
            device,
          })
        }
      }

      // Everything a drive says about its own age and health. Grouped by the
      // device part of the path rather than by name, because two identical
      // drives in one machine share a name and nothing else.
      // The battery names its own path after the pack — `/battery/L22B4PC0_1/`
      // — so there is nothing stable to match but the prefix.
      if (sensorId.startsWith('/battery/')) {
        battery ??= {
          chargePercent: null,
          wearPercent: null,
          rateWatts: null,
          remainingWh: null,
          fullWh: null,
          designWh: null,
          cycleCount: null,
        }
        const value = parseValue(node.Value)
        if (name === 'Charge Level') battery.chargePercent = value
        else if (name === 'Degradation Level') battery.wearPercent = value
        else if (name === 'Charge/Discharge Rate') battery.rateWatts = value
        // Reported in milliwatt-hours, which is a unit nobody reads. Watt-hours
        // is what a battery is sold in and what its label says.
        else if (name === 'Remaining Capacity') battery.remainingWh = value === null ? null : value / 1000
        else if (name === 'Fully-Charged Capacity') battery.fullWh = value === null ? null : value / 1000
        else if (name === 'Designed Capacity') battery.designWh = value === null ? null : value / 1000
      }

      const disk = /^\/(nvme|ssd|hdd)\/\d+/.exec(sensorId)?.[0]
      if (disk) {
        const entry = drives.get(disk) ?? {
          name: device ?? disk,
          temperature: null,
          lifePercent: null,
          powerOnHours: null,
          totalBytes: null,
        }
        if (device) entry.name = device
        if (node.Type === 'Temperature' && !NOT_A_READING.test(name) && entry.temperature === null) {
          entry.temperature = parseValue(node.Value)
        }
        if (name === 'Life') entry.lifePercent = parseValue(node.Value)
        if (name === 'Power On Hours') entry.powerOnHours = parseValue(node.Value)
        if (name === 'Total Space') entry.totalBytes = parseBytes(node.Value)
        drives.set(disk, entry)
      }
    }

    const chain = [...ancestors, (node.Text ?? '').trim()]
    for (const child of children) visit(child, chain)
  }

  visit(root as LhmNode, [])
  return { temperatures, disks: [...drives.values()], battery }
}

/**
 * Asks the server, and shrugs if it is not there.
 *
 * Never throws and never waits long. Not running, not publishing, a firewall in
 * the way and a port already taken by something else all come back the same
 * way — as no readings — because the panel's answer to all four is identical
 * and it already says what would change it.
 */
export async function readLhm(): Promise<LhmReading> {
  try {
    const response = await fetch(LHM_URL, { signal: AbortSignal.timeout(LHM_TIMEOUT_MS) })
    if (!response.ok) return { temperatures: [], disks: [], battery: null }
    return parseLhm(await response.json())
  } catch {
    return { temperatures: [], disks: [], battery: null }
  }
}
