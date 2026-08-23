/**
 * Which of a machine's temperature sensors is *the* processor temperature.
 *
 * A processor does not have one temperature, and the difference between its
 * sensors is not noise. On the AMD part this was written against,
 * LibreHardwareMonitor publishes two, and sampled a second apart they read:
 *
 * ```
 * Tctl=91.1  CCD1=93.4
 * Tctl=90.6  CCD1=77.8
 * Tctl=88.1  CCD1=66.6
 * ```
 *
 * `Tctl` is the control temperature the firmware smooths and throttles against
 * — three degrees of movement across that window. `CCD1` is the die sensor
 * reacting to individual boost spikes — twenty-seven. Both are true.
 *
 * What this exists to stop is taking the hottest of them, which is what the
 * panel used to do. That is not a reading of anything: at the first sample it
 * reports CCD1, at the second Tctl, and the series it draws is a splice of two
 * unrelated ones — a number that matches neither the sensor beside it nor
 * whatever HWiNFO is showing, and that changes which question it is answering
 * between one second and the next.
 *
 * So one sensor is chosen, by name, and the name is shown beside the number.
 * The order below is the order the rest of the world leads with, so the figure
 * agrees with the tool the user already trusts.
 */
import type { TemperatureStats } from './types'

/**
 * Preferred processor sensors, most authoritative first.
 *
 * - `Tctl` — AMD's control temperature, the one the firmware throttles
 *   against. What HWiNFO calls *CPU (Tctl/Tdie)* and what every AMD tool leads
 *   with.
 * - `Package` — Intel's whole-die figure, the same role.
 * - `CPU` on its own — some superIO chips label the socket sensor this way.
 * - An average across cores, where the source computes one.
 * - `Tdie` last, and separately from `Tctl` on purpose: a Ryzen publishes
 *   `Core (Tctl/Tdie)` *and* `CCD1 (Tdie)`, so one pattern spanning both is
 *   two sensors deep and hands the choice back to whichever is hotter — which
 *   is the bug this file exists to fix. It is only reached on a part that
 *   publishes a die sensor and no control temperature.
 */
const CPU_PREFERRED = [/tctl/i, /package/i, /^cpu$/i, /average/i, /tdie/i]

/**
 * The one processor temperature to show, or null when nothing reported one.
 *
 * Falls back to the hottest CPU sensor only when no preferred name matched —
 * an unknown chip publishing `Core #0…#7` and nothing else is better served by
 * its worst core than by nothing at all. The fallback is a last resort rather
 * than the rule, which is the whole change.
 */
export function cpuTemperature(temps: readonly TemperatureStats[]): TemperatureStats | null {
  const cpu = temps.filter((t) => t.kind === 'cpu')
  if (!cpu.length) return null
  for (const pattern of CPU_PREFERRED) {
    // Hottest among equals: a machine with two packages reports two, and the
    // busy one is the one worth watching.
    const matches = cpu.filter((t) => pattern.test(t.name))
    if (matches.length) return hottest(matches)
  }
  return hottest(cpu)
}

function hottest(temps: readonly TemperatureStats[]): TemperatureStats {
  return temps.reduce((worst, t) => (t.celsius > worst.celsius ? t : worst))
}
