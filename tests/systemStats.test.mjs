// The machine monitor's collector, run for real against the machine running
// the suite.
//
// Worth having as a test rather than as a thing somebody eyeballs in the pane,
// because almost every failure mode here is *quiet*: a probe whose output
// format shifted parses to zero rather than throwing, and a zero looks exactly
// like an idle machine. So these assert shape and plausibility — that memory is
// non-zero and used is under total, that a percentage is a percentage, that the
// second sample produces the CPU delta the first cannot — rather than exact
// values, which depend on what the machine is doing while the suite runs.
//
// Everything here is platform-agnostic on purpose. The collector is meant to
// answer on all three, and the parts that differ (which probe, which file) are
// exercised by whichever platform the suite happens to be on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const out = path.join(os.tmpdir(), 'iaw-system-test')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

await build({
  entryPoints: {
    systemStats: 'src/main/systemStats.ts',
    sparkline: 'src/renderer/ui/sparkline.ts',
    lhm: 'src/main/lhm.ts',
    weather: 'src/main/weather.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir: out,
  // Not installed for a plain-Node run, and the collector is written to cope:
  // it requires electron lazily and reports an empty footprint without it.
  external: ['electron'],
})

const { readSystemStats, parseDiskstats, parseIoreg, parseWindowsSlow } = await import(
  `file://${out}/systemStats.js`
)
const { parseLhm, parseValue, parseBytes } = await import(`file://${out}/lhm.js`)
const { parseOpenMeteo, parseOpenMeteoAir, parseOwm, parseOwmAir, readWeather } = await import(
  `file://${out}/weather.js`
)

const tests = []
const test = (name, fn) => tests.push([name, fn])

// ------------------------------------------------------------------- shape

const first = await readSystemStats()

test('it answers with a timestamped sample', () => {
  assert.ok(first.at > 0)
  assert.ok(Math.abs(Date.now() - first.at) < 60_000)
})

test('the processor is described', () => {
  assert.ok(first.cpu.cores >= 1)
  assert.equal(first.cpu.cores, os.cpus().length)
  assert.ok(first.cpu.model.length > 0)
})

test('the first sample has no CPU load, because there is no delta yet', () => {
  // The trap this guards: os.cpus() counts since boot, so a single reading
  // divided out gives a number that is plausible, stable, and answers a
  // question nobody asked.
  assert.equal(first.cpu.load, null)
  assert.deepEqual(first.cpu.perCore, [])
})

test('load average is null on Windows and three numbers everywhere else', () => {
  if (process.platform === 'win32') {
    assert.equal(first.cpu.loadAverage, null)
  } else {
    assert.equal(first.cpu.loadAverage.length, 3)
    for (const value of first.cpu.loadAverage) assert.ok(Number.isFinite(value))
  }
})

test('memory is real and self-consistent', () => {
  assert.ok(first.memory.total > 0)
  assert.ok(first.memory.used > 0)
  assert.ok(first.memory.used <= first.memory.total)
  // `used` is measured against *available* where the platform reports one, and
  // falls back to `free` where it does not — so the identity that holds is with
  // whichever of the two was actually used. Asserting it against `free`
  // unconditionally passes only on the first sample, before the slower probe
  // that carries `available` has answered, which is a test that passes for a
  // reason that has nothing to do with what it claims to check.
  const counterpart = first.memory.available ?? first.memory.free
  assert.equal(first.memory.used + counterpart, first.memory.total)
})

test('the figures no process list contains are present, or honestly absent', () => {
  // The three that answer "where has my memory gone": what could still be
  // taken, what has been promised, and what the drivers hold. Each is null
  // rather than zero where the platform will not say.
  for (const key of ['available', 'committed', 'commitLimit', 'kernel']) {
    const value = second.memory[key]
    assert.ok(value === null || value > 0, `memory.${key} is ${value}`)
  }
  if (second.memory.commitLimit !== null && second.memory.committed !== null) {
    assert.ok(
      second.memory.committed <= second.memory.commitLimit,
      'more has been promised than the commit limit allows, which cannot happen'
    )
  }
})

test('the machine has been up for a positive number of seconds', () => {
  assert.ok(first.uptimeSeconds > 0)
})

test('at least one volume answered, with free no greater than total', () => {
  assert.ok(first.disks.length >= 1, 'no volumes were reported')
  for (const disk of first.disks) {
    assert.ok(disk.total > 0, `${disk.mount} reported no size`)
    assert.ok(disk.free >= 0)
    assert.ok(disk.free <= disk.total, `${disk.mount} has more free than it holds`)
    assert.ok(disk.mount.length > 0)
  }
})

test('network interfaces carry cumulative counters', () => {
  for (const net of first.networks) {
    assert.ok(net.name.length > 0)
    assert.ok(net.rxTotal >= 0)
    assert.ok(net.txTotal >= 0)
  }
})

test('the first sample has no rates, for the same reason as the CPU', () => {
  for (const net of first.networks) {
    assert.equal(net.rxPerSec, null)
    assert.equal(net.txPerSec, null)
  }
})

test('a GPU is either absent or fully described — never a zeroed placeholder', () => {
  if (!first.gpus.length) {
    assert.equal(first.sources.gpu, null)
    return
  }
  assert.equal(first.sources.gpu, 'nvidia-smi')
  for (const gpu of first.gpus) {
    assert.ok(gpu.name.length > 0)
    // Each reading is a number or an admitted null, never undefined.
    for (const key of ['load', 'temperature', 'memoryUsed', 'memoryTotal', 'power']) {
      assert.ok(gpu[key] === null || Number.isFinite(gpu[key]), `${key} was ${gpu[key]}`)
    }
    if (gpu.load !== null) assert.ok(gpu.load >= 0 && gpu.load <= 100)
    if (gpu.memoryUsed !== null && gpu.memoryTotal !== null) {
      assert.ok(gpu.memoryUsed <= gpu.memoryTotal)
    }
  }
})

test('battery is either absent or a real percentage', () => {
  if (first.battery === null) return
  assert.ok(first.battery.percent >= 0 && first.battery.percent <= 100)
  assert.ok([true, false, null].includes(first.battery.charging))
})

// ------------------------------------------------------- the second sample

// Busy work rather than a sleep: the point is to move the CPU counters, and an
// idle wait can leave every core's delta at zero on a quiet machine, which
// would make the load assertion below pass for the wrong reason.
const spin = Date.now()
let churn = 0
while (Date.now() - spin < 250) churn += Math.sqrt(churn + 1)
assert.ok(churn > 0)

const second = await readSystemStats()

test('the second sample carries a CPU load, one per core', () => {
  assert.ok(second.cpu.load !== null, 'no load on the second sample')
  assert.ok(second.cpu.load >= 0 && second.cpu.load <= 100)
  assert.equal(second.cpu.perCore.length, second.cpu.cores)
  for (const core of second.cpu.perCore) {
    assert.ok(core >= 0 && core <= 100, `per-core value out of range: ${core}`)
  }
})

test('network rates appear once there are two samples to subtract', () => {
  for (const net of second.networks) {
    // Still null is legitimate for an interface that appeared between the two
    // samples; what must never happen is a rate that is negative or absurd.
    if (net.rxPerSec === null) continue
    assert.ok(net.rxPerSec >= 0, `${net.name} reported a negative rate`)
    assert.ok(net.txPerSec >= 0)
  }
})

test('counters never go backwards between samples', () => {
  const before = new Map(first.networks.map((n) => [n.name, n]))
  for (const net of second.networks) {
    const was = before.get(net.name)
    if (!was) continue
    assert.ok(net.rxTotal >= was.rxTotal, `${net.name} rx went backwards`)
    assert.ok(net.txTotal >= was.txTotal, `${net.name} tx went backwards`)
  }
})

test('the volume list is stable between samples', () => {
  assert.deepEqual(
    second.disks.map((d) => d.mount).sort(),
    first.disks.map((d) => d.mount).sort()
  )
})

// ------------------------------------------------------------- the drawing

const { sparkline } = await import(`file://${out}/sparkline.js`)

// The sparkline builds DOM, so it needs a document. A stub rather than jsdom:
// all it uses is createElementNS, setAttribute and appendChild, and the thing
// being checked is the geometry, not the DOM.
globalThis.document = {
  createElementNS(_ns, tag) {
    return {
      tag,
      attrs: {},
      children: [],
      setAttribute(name, value) {
        this.attrs[name] = value
      },
      appendChild(child) {
        this.children.push(child)
        return child
      },
    }
  },
}

test('a graph of one point draws no line', () => {
  const svg = sparkline([null, 42])
  assert.equal(svg.children.length, 0)
})

test('a gap breaks the line in two rather than drawing across it', () => {
  const svg = sparkline([10, 20, null, 30, 40], { max: 100 })
  const lines = svg.children.filter((c) => c.tag === 'polyline')
  assert.equal(lines.length, 2, 'the gap did not split the line')
})

const pointsOf = (svg) =>
  svg.children
    .find((c) => c.tag === 'polyline')
    .attrs.points.split(' ')
    .map((p) => p.split(',').map(Number))

test('the newest sample is at the right edge and 100% is at the top', () => {
  const points = pointsOf(sparkline([0, 100], { max: 100 }))
  assert.equal(points[1][0], 100, 'the newest sample is hard against the right edge')
  assert.equal(points[1][1], 0, 'and the maximum reaches the ceiling')
  assert.equal(points[0][1], 30, 'zero sits on the floor')
})

test('samples keep a fixed width instead of stretching to fill', () => {
  // The point of the grid: two samples occupy two slots at the right, not the
  // whole width. Stretching means a spike is drawn narrower as history builds
  // up behind it, so nothing can be compared with anything a minute later.
  const two = pointsOf(sparkline([0, 100], { max: 100 }))
  const three = pointsOf(sparkline([0, 50, 100], { max: 100 }))

  const step = two[1][0] - two[0][0]
  assert.ok(step > 0 && step < 2, `one sample should be a sliver, got ${step}`)
  assert.ok(
    Math.abs((three[2][0] - three[1][0]) - step) < 0.001,
    'a third sample must not change how wide the others are'
  )
  assert.equal(three[2][0], 100, 'and the newest is still at the right edge')
})

test('a full window reaches the left edge, and older samples scroll off', () => {
  const full = Array.from({ length: 120 }, (_, i) => i)
  assert.equal(pointsOf(sparkline(full, { max: 200 }))[0][0], 0, 'a full window starts at the left')

  // More than fits: the oldest are dropped rather than squeezed in.
  const over = Array.from({ length: 400 }, (_, i) => i)
  const drawn = pointsOf(sparkline(over, { max: 400 }))
  assert.equal(drawn.length, 120, 'only one window of samples is drawn')
  assert.equal(drawn[drawn.length - 1][0], 100)
})

test('values above the ceiling are clamped rather than drawn off the top', () => {
  const svg = sparkline([0, 500], { max: 100 })
  const line = svg.children.find((c) => c.tag === 'polyline')
  const last = line.attrs.points.split(' ').pop().split(',').map(Number)
  assert.equal(last[1], 0)
})

// ---------------------------------------------------- the disk parsers

// Real lines from the three platforms. Every one of these formats fails
// *quietly* when it drifts — a changed column parses to zero, and a zero looks
// exactly like a disk nobody is touching — so the fixtures are the point.

test('/proc/diskstats gives bytes, and counts a sector as 512 of them', () => {
  // Whole devices and their partitions, plus the loop and dm entries every
  // Linux has. Fields: major minor name, then eleven counters.
  const raw = [
    '   8       0 sda 133 0 8192 40 55 0 2048 12 0 30 52 0 0 0 0',
    '   8       1 sda1 12 0 512 4 3 0 128 1 0 4 5 0 0 0 0',
    ' 259       0 nvme0n1 900 0 65536 120 400 0 16384 80 0 240 200 0 0 0 0',
    ' 259       1 nvme0n1p1 10 0 128 2 5 0 64 1 0 3 3 0 0 0 0',
    '   7       0 loop0 5 0 40 1 0 0 0 0 0 1 1 0 0 0 0',
    ' 253       0 dm-0 20 0 160 3 4 0 32 1 0 4 4 0 0 0 0',
    '',
  ].join('\n')

  const io = parseDiskstats(raw)
  assert.deepEqual(io.map((d) => d.name), ['sda', 'nvme0n1'], 'partitions and loop devices are not disks')

  const sda = io[0]
  // 8192 sectors read is 4 MiB, not 8192 bytes — the factor-of-512 mistake is
  // the one that makes every figure here wrong and still plausible.
  assert.equal(sda.read, 8192 * 512)
  assert.equal(sda.write, 2048 * 512)
  // Field 12, counting from the major number at zero: reads completed, merged,
  // sectors, ms; writes completed, merged, sectors, ms; in flight; *ms doing
  // I/O*. Miscount by one and the busy figure is the weighted queue time, which
  // is a much larger number that is also plausible.
  assert.equal(sda.idle, 30, 'milliseconds doing I/O, carried through for the busy figure')
})

test('a diskstats line that is too short is skipped rather than half-read', () => {
  assert.deepEqual(parseDiskstats('   8       0 sda 133 0 8192\n'), [])
  assert.deepEqual(parseDiskstats(''), [])
})

test("ioreg's byte counters are read per drive", () => {
  const raw = [
    '  +-o AppleAPFSMedia  <class IOMedia, id 0x100000abc, registered>',
    '      "BSD Name" = "disk0"',
    '      "Statistics" = {"Operations (Read)"=100,"Bytes (Read)"=4194304,"Bytes (Write)"=1048576,"Errors (Read)"=0}',
    '  +-o Another  <class IOMedia>',
    '      "BSD Name" = "disk1"',
    '      "Statistics" = {"Bytes (Read)"=512,"Bytes (Write)"=1024}',
  ].join('\n')

  const io = parseIoreg(raw)
  assert.deepEqual(io.map((d) => d.name), ['disk0', 'disk1'])
  assert.equal(io[0].read, 4194304)
  assert.equal(io[0].write, 1048576)
  assert.equal(io[1].write, 1024)
})

test('the Windows probe reads counters, health and any temperature it finds', () => {
  // Captured verbatim from the machine this was written on, plus two sensor
  // lines of the shape LibreHardwareMonitor publishes when it is running.
  const raw = [
    'I 134639815168 77932712960 139328535182 148320220398 0 C:',
    'I 23166328832 14269390848 147603978117 148320220398 1 X:',
    'H 0 4 512110190592 0 SAMSUNG MZVLB512HBJQ-000L2',
    'H 1 3 2000398934016 1 ST2000DM008-2FR102',
    'T 47.5 /intelcpu/0/temperature/0 CPU Package',
    'T 39 /nvme/0/temperature/0 Temperature',
    '',
  ].join('\r\n')

  const probe = parseWindowsSlow(raw)

  // The instance name has a space in it, so anything that split on whitespace
  // and took the last field would report a disk called "C:".
  assert.deepEqual(probe.io.map((d) => d.name), ['0 C:', '1 X:'])
  assert.equal(probe.io[0].read, 134639815168)
  assert.equal(probe.io[0].stamp, 148320220398, 'the timestamp is what makes the busy figure computable')

  // The device number leading the counter's instance name is the only thing
  // joining `0 C:` to a drive anybody would recognise.
  assert.deepEqual(probe.io.map((d) => d.label), ['SAMSUNG MZVLB512HBJQ-000L2', 'ST2000DM008-2FR102'])

  assert.deepEqual(
    probe.health.map((d) => `${d.name}|${d.status}|${d.kind}`),
    ['SAMSUNG MZVLB512HBJQ-000L2|ok|ssd', 'ST2000DM008-2FR102|warning|hdd']
  )
  assert.equal(probe.health[1].size, 2000398934016)

  assert.deepEqual(
    probe.temperatures.map((t) => `${t.name}|${t.celsius}|${t.kind}`),
    ['CPU Package|47.5|cpu', 'Temperature|39|disk'],
    'the sensor path is what says whether a reading is a processor or a drive'
  )
  assert.equal(probe.sources.temperatureNote, null, 'a machine that answered needs no excuse')
})

test('a Windows machine with no sensors says why, rather than showing nothing', () => {
  // The ordinary case, and the one this was verified against: no thermal zone,
  // no LibreHardwareMonitor. An empty row reads as a broken monitor.
  const probe = parseWindowsSlow('H 0 4 512110190592 0 SAMSUNG MZVLB512HBJQ-000L2\n')
  assert.deepEqual(probe.temperatures, [])
  assert.equal(probe.sources.temperature, null)
  assert.match(probe.sources.temperatureNote, /driver/)
  assert.equal(probe.sources.health, 'Windows storage stack')
})

// ------------------------------------------------- what this machine gives

test('disk throughput and health are reported, or explained', () => {
  // The slow probe runs on its own clock and its first sample is deliberately
  // empty, so this asserts the contract rather than the contents: whatever is
  // present is well-formed, and whatever is absent is accounted for.
  for (const io of second.diskIo) {
    assert.ok(io.name.length > 0)
    assert.ok(io.readTotal >= 0 && io.writeTotal >= 0)
    for (const rate of [io.readPerSec, io.writePerSec]) {
      assert.ok(rate === null || rate >= 0, `${io.name} reported a negative rate`)
    }
    assert.ok(
      io.busyPercent === null || (io.busyPercent >= 0 && io.busyPercent <= 100),
      `${io.name} is ${io.busyPercent}% busy, which is not a percentage`
    )
  }

  for (const drive of second.health) {
    assert.ok(['ok', 'warning', 'bad', 'unknown'].includes(drive.status), drive.status)
    assert.ok(['ssd', 'hdd', 'unknown'].includes(drive.kind), drive.kind)
    assert.ok(drive.size === null || drive.size > 0)
  }
})

test('every temperature is a temperature, and none means a reason', () => {
  for (const reading of second.temperatures) {
    assert.ok(reading.celsius > 0 && reading.celsius < 150, `${reading.name} reads ${reading.celsius}C`)
    assert.ok(['cpu', 'gpu', 'disk', 'memory', 'other'].includes(reading.kind), reading.kind)
  }
  if (second.temperatures.length) {
    assert.ok(second.sources.temperature, 'a reading came from somewhere, and it should say where')
    assert.equal(second.sources.temperatureNote, null)
  } else {
    // The whole point of the note: "this machine will not say" is an answer,
    // and an empty row is not.
    assert.ok(second.sources.temperatureNote, 'no temperatures and no explanation')
  }
})

// ------------------------------------------- LibreHardwareMonitor's sensors

// Trimmed from a real capture off the running app: the root wrapper, the
// computer under it, then hardware, then a group, then the sensors. Every
// awkward case this parser exists for is in here.
const LHM_TREE = {
  Text: '',
  Children: [
    {
      Text: 'LEG2',
      Children: [
        {
          Text: 'AMD Ryzen 7 7745HX with Radeon Graphics',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                { Text: 'Core (Tctl/Tdie)', Value: '89.9 \u00b0C', Type: 'Temperature', SensorId: '/amdcpu/0/temperature/2', Children: [] },
                { Text: 'Core #1 VID', Value: '0.238 V', Type: 'Voltage', SensorId: '/amdcpu/0/voltage/2', Children: [] },
              ],
            },
          ],
        },
        {
          Text: 'SAMSUNG MZVL21T0HCLR-00BL2',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                { Text: 'Composite Temperature', Value: '61,0 \u00b0C', Type: 'Temperature', SensorId: '/nvme/0/temperature/0', Children: [] },
                { Text: 'Warning Temperature', Value: '75.0 \u00b0C', Type: 'Temperature', SensorId: '/nvme/0/temperature/10', Children: [] },
                { Text: 'Critical Temperature', Value: '86.0 \u00b0C', Type: 'Temperature', SensorId: '/nvme/0/temperature/11', Children: [] },
              ],
            },
            {
              Text: 'Levels',
              Children: [
                { Text: 'Life', Value: '97.0 %', Type: 'Level', SensorId: '/nvme/0/level/20', Children: [] },
              ],
            },
            {
              Text: 'Factors',
              Children: [
                { Text: 'Power On Hours', Value: '2449.000', Type: 'Factor', SensorId: '/nvme/0/factor/24', Children: [] },
              ],
            },
            {
              Text: 'Data',
              Children: [
                { Text: 'Total Space', Value: '1024.2 GB', Type: 'Data', SensorId: '/nvme/0/data/32', Children: [] },
              ],
            },
          ],
        },
        {
          Text: 'Samsung - M425R1GB4BB0-CWMOD (DIMM #0)',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                { Text: 'DIMM #0', Value: '61.3 \u00b0C', Type: 'Temperature', SensorId: '/memory/dimm/0/temperature/0', Children: [] },
                { Text: 'Thermal Sensor High Limit', Value: '55.0 \u00b0C', Type: 'Temperature', SensorId: '/memory/dimm/0/temperature/3', Children: [] },
                { Text: 'Temperature Sensor Resolution', Value: '0.3 \u00b0C', Type: 'Temperature', SensorId: '/memory/dimm/0/temperature/1', Children: [] },
              ],
            },
          ],
        },
        {
          Text: 'NVIDIA GeForce RTX 4060 Laptop GPU',
          Children: [
            {
              Text: 'Temperatures',
              Children: [
                { Text: 'GPU Core', Value: '51.0 \u00b0C', Type: 'Temperature', SensorId: '/gpu-nvidia/0/temperature/0', Children: [] },
              ],
            },
          ],
        },
      ],
    },
  ],
}

test('a reading is found however deep it sits, and named for its hardware', () => {
  const { temperatures } = parseLhm(LHM_TREE)
  const byName = Object.fromEntries(temperatures.map((t) => [t.name, t]))

  // The device is the *grandparent* — the parent is a heading called
  // "Temperatures". Getting that wrong named every sensor after the computer.
  assert.equal(byName['Composite Temperature'].device, 'SAMSUNG MZVL21T0HCLR-00BL2')
  assert.equal(byName['Core (Tctl/Tdie)'].device, 'AMD Ryzen 7 7745HX with Radeon Graphics')

  // Classified by the sensor's own path, not its display name.
  assert.equal(byName['Core (Tctl/Tdie)'].kind, 'cpu')
  assert.equal(byName['Composite Temperature'].kind, 'disk')
  assert.equal(byName['DIMM #0'].kind, 'memory')
  assert.equal(byName['GPU Core'].kind, 'gpu')

  // Voltages, clocks and loads share the tree and are not temperatures.
  assert.ok(!temperatures.some((t) => t.name === 'Core #1 VID'))
})

test('a drive\'s warning threshold is not reported as its temperature', () => {
  // Every NVMe publishes its warning and critical limits as temperature
  // sensors sitting beside the live one. They are constants, they are higher,
  // and showing one would say a drive at 61 is at 86.
  const names = parseLhm(LHM_TREE).temperatures.map((t) => t.name)
  for (const excluded of [
    'Warning Temperature',
    'Critical Temperature',
    'Thermal Sensor High Limit',
    'Temperature Sensor Resolution',
  ]) {
    assert.ok(!names.includes(excluded), `${excluded} was reported as a reading`)
  }
  assert.ok(names.includes('Composite Temperature'), 'and the real one survived')
})

test('a comma decimal separator is read as a decimal, not truncated', () => {
  // The server formats with the machine's locale, so on a German or Greek
  // Windows every reading arrives as "61,0 °C" — which parseFloat reads as 61
  // exactly, silently, and only for some users.
  assert.equal(parseValue('61,3 \u00b0C'), 61.3)
  assert.equal(parseValue('89.9 \u00b0C'), 89.9)
  assert.equal(parseValue('-5.0 \u00b0C'), -5)
  assert.equal(parseValue(''), null)
  assert.equal(parseValue(undefined), null)
  assert.equal(parseValue('n/a'), null)
})

test('anything that is not a sensor tree comes back empty rather than throwing', () => {
  // This format belongs to somebody else and arrives over a socket.
  for (const junk of [null, undefined, 42, 'nope', {}, { Children: null }]) {
    assert.deepEqual(parseLhm(junk).temperatures, [], `threw or guessed on ${JSON.stringify(junk)}`)
  }
})

test('a drive brings its wear, its hours and its capacity', () => {
  // Wear and hours are the two figures Windows keeps behind an administrator,
  // and capacity is what lets a drive here be matched to the same drive there.
  const { disks } = parseLhm(LHM_TREE)
  const nvme = disks.find((d) => d.name.includes('MZVL21T0'))
  assert.ok(nvme, `no drive found in ${JSON.stringify(disks.map((d) => d.name))}`)
  assert.equal(nvme.lifePercent, 97)
  assert.equal(nvme.powerOnHours, 2449)
  assert.equal(nvme.totalBytes, 1024.2e9)
  // The live reading, not the warning threshold sitting beside it.
  assert.equal(nvme.temperature, 61)
})

test('capacities are decimal, because that is what the storage stack agrees with', () => {
  // Reading these as gibibytes puts an 8 TB drive out by 7%, which is more than
  // enough to stop it matching the same drive reported in bytes by Windows —
  // and the failure is silent, showing as a drive with no temperature.
  assert.equal(parseBytes('8001.6 GB'), 8001.6e9)
  assert.equal(parseBytes('512.1 GB'), 512.1e9)
  assert.equal(parseBytes('2.0 TB'), 2e12)
  assert.equal(parseBytes('45908.0 GB'), 45908e9)
  assert.equal(parseBytes(undefined), null)

  // The real numbers off the machine this was written on: what the sensor
  // source prints, against what the storage stack reports in bytes. They have
  // to land inside the matcher's one-in-a-thousand tolerance.
  for (const [printed, exact] of [
    ['512.1 GB', 512110190592],
    ['1024.2 GB', 1024209543168],
    ['8001.6 GB', 8001563222016],
  ]) {
    const got = parseBytes(printed)
    assert.ok(Math.abs(got - exact) / exact < 0.001, `${printed} vs ${exact} is outside tolerance`)
  }
})

// ------------------------------------------------------ weather and air

// Captured from the two services, trimmed. Both are somebody else's format
// arriving over a socket, and every failure here is quiet: a renamed field
// parses to null and reads as "the sensor did not say".

test('Open-Meteo is read, and its weather code becomes a phrase', () => {
  const w = parseOpenMeteo({
    current: {
      temperature_2m: 25.5,
      relative_humidity_2m: 53,
      apparent_temperature: 26.4,
      surface_pressure: 1001.2,
      wind_speed_10m: 5.8,
      wind_direction_10m: 30,
      weather_code: 0,
    },
  })
  assert.equal(w.temperature, 25.5)
  assert.equal(w.humidity, 53)
  assert.equal(w.pressure, 1001.2)
  // Asked for in km/h at the API rather than converted here, so there is only
  // ever one place the unit is decided.
  assert.equal(w.windSpeed, 5.8)
  assert.equal(w.description, 'clear sky', 'code 0 is clear sky')
  assert.equal(parseOpenMeteo({ current: { weather_code: 95 } }).description, 'thunderstorm')
  assert.equal(parseOpenMeteo({ current: { weather_code: 4242 } }).description, '', 'an unknown code is not invented')
})

test('the air index carries the scale it is on', () => {
  // The two providers do not share a scale: 3 is middling on OpenWeatherMap's
  // 1–5 and excellent on the European 0–100+. A bare number would be
  // unreadable and would look perfectly fine, which is worse.
  const euro = parseOpenMeteoAir({ current: { european_aqi: 30, pm2_5: 7.3, pm10: 16.7, ozone: 75 } })
  assert.equal(euro.index, 30)
  assert.equal(euro.scale, 'european')
  assert.equal(euro.pm2_5, 7.3)

  const owm = parseOwmAir({ list: [{ main: { aqi: 2 }, components: { pm2_5: 7.3, pm10: 16.7, o3: 75, nh3: 0.5 } }] })
  assert.equal(owm.index, 2)
  assert.equal(owm.scale, 'owm')
  assert.equal(owm.nh3, 0.5, 'the one pollutant Open-Meteo does not report')
})

test('OpenWeatherMap wind is converted, so both providers mean km/h', () => {
  // It reports metres per second under units=metric. Left alone, a 5 m/s
  // breeze would read as 5 km/h beside Open-Meteo's 18 and look like calmer
  // weather rather than a different unit.
  const w = parseOwm({ name: 'Athens', main: { temp: 25.5, humidity: 53, pressure: 1001 }, wind: { speed: 5, deg: 30 }, weather: [{ description: 'clear sky' }] })
  assert.equal(w.windSpeed, 18)
  assert.equal(w.place, 'Athens')
  assert.equal(w.description, 'clear sky')
})

test('nothing is requested until there is somewhere to ask about', async () => {
  // The only part of the app that talks to a third party, so doing it by
  // accident has to be impossible rather than merely unlikely.
  const nowhere = await readWeather({ provider: 'open-meteo', lat: NaN, lon: NaN })
  assert.equal(nowhere.error, 'no-location')
  assert.equal(nowhere.weather, null)

  const keyless = await readWeather({ provider: 'openweathermap', lat: 37.9, lon: 23.7 })
  assert.equal(keyless.error, 'no-key', 'a provider that needs a key does not fire without one')
})

test('junk from either service comes back empty rather than throwing', () => {
  for (const junk of [null, undefined, 42, 'nope', {}, { current: null }, { list: [] }]) {
    assert.equal(parseOpenMeteo(junk), null, `parseOpenMeteo threw or guessed on ${JSON.stringify(junk)}`)
    assert.equal(parseOpenMeteoAir(junk), null)
    assert.equal(parseOwm(junk), null)
    assert.equal(parseOwmAir(junk), null)
  }
})

// ------------------------------------------------------------------- runner

let failed = 0
for (const [name, fn] of tests) {
  try {
    fn()
    console.log(`  ok ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message}`)
  }
}

console.log(`\n${tests.length - failed}/${tests.length} checks passed`)
if (failed) process.exit(1)
