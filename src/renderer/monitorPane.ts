/**
 * What this machine is doing, in a pane.
 *
 * The question it answers is the one you have with twenty shells open and a
 * build running somewhere: is the machine coping, and if not, with what. That
 * is a different question from the one a system monitor usually answers — this
 * is not trying to be Task Manager, and there is deliberately no process list
 * in it, because the pane next door already has one scoped to the panes you
 * started (see `PortsPane`).
 *
 * Everything on screen needs no driver, no helper and no administrator, which
 * is what makes it identical on Windows, macOS and Linux. The cost of that rule
 * falls almost entirely on temperatures: there is no portable way to read one,
 * and on Windows it takes a signed kernel driver — which is what HWiNFO and
 * LibreHardwareMonitor *are*, and what this app is not going to ship. So they
 * are read where somebody else has already paid that cost: an NVIDIA card
 * through the `nvidia-smi` its driver installed, everything Linux publishes
 * under `hwmon`, and LibreHardwareMonitor's own sensors if it happens to be
 * running. On a Windows machine with none of those, the card says so.
 *
 * Drives are the discovery that came out of measuring rather than assuming.
 * Throughput and Windows' own health verdict per drive are both free, and the
 * detail behind them — wear, hours, temperature — is behind an administrator
 * and stays unread. See `systemStats.ts`, where each of those was timed.
 *
 * Where a reading cannot be taken, the row says so in words. It never shows a
 * zero standing in for "we do not know" — the same rule the Claude usage rows
 * follow, and for the same reason: a plausible wrong number is worse than an
 * admitted gap, and 0 °C is very plausible and very wrong.
 */
import type { AuxPane } from './auxPane'
import type {
  AirQuality,
  DiskStats,
  NetworkStats,
  SystemStats,
  TemperatureStats,
  WeatherReading,
} from '../shared/types'
import { backend } from '../backend'
import { showWeatherSettings } from './ui/weatherSettings'
import { store } from './state'
import { cpuTemperature } from '../shared/sensors'
import { showContextMenu } from './ui/contextMenu'
import { sparklines, type SparkSeries } from './ui/sparkline'
import {
  band,
  bytes,
  duration,
  percent,
  rate,
  watchSystem,
  latestSystem,
  systemHistory,
  type SystemHistory,
} from './ui/systemMonitor'
import { latestUsage, refreshUsageNow, statusPageLink, usageResetLine } from './ui/usageMonitor'

/**
 * How often the pane samples.
 *
 * Two seconds. One is a spawn every second for a graph nobody watches that
 * closely; five is slow enough that you press a key, look up, and the line has
 * not moved yet. It is also what the Rainmeter skin this borrows its shape from
 * settled on, which is the same judgement made once already.
 */
const POLL_MS = 2000

/**
 * How alarmed a reading looks.
 *
 * Three of these are the whole panel's vocabulary — a machine reading is fine,
 * getting warm, or on fire, and inventing gradations of "fine" is how a warning
 * colour comes to mean nothing. The air block is the exception and needs five,
 * because the scales it reports on *are* five-band: every agency that publishes
 * an air quality index publishes it as good / fair / moderate / poor / very
 * poor, and flattening that to three would be this app disagreeing with the
 * legend printed beside the same number everywhere else.
 */
type Tone = 'idle' | 'good' | 'fair' | 'mid' | 'warn' | 'high'

interface Figure {
  value: string | null
  tone: Tone
  label?: string
  title: string
  empty?: string
  /** Which graph line this number is, so the two share a colour. */
  series?: 'load' | 'memory' | 'temp'
}

export class MonitorPane implements AuxPane {
  /** A scratch canvas, shared by every panel: text measured without a reflow. */
  private static gauge: CanvasRenderingContext2D | null = null

  readonly element: HTMLDivElement
  private readonly bodyEl: HTMLDivElement
  private readonly aboutEl: HTMLDivElement
  private unwatch: (() => void) | null = null
  /** Dropped on dispose, so a closed panel stops redrawing on every store change. */
  private unsubscribe: (() => void) | null = null
  /** The block being dragged, so the others know what a drop would move. */
  private dragging: string | null = null
  /** The last weather answer, or null before the first. */
  private weather: WeatherReading | null = null
  private weatherTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(readonly paneId: string) {
    this.element = document.createElement('div')
    this.element.className = 'monitor-pane'

    this.aboutEl = document.createElement('div')
    this.aboutEl.className = 'pane-about'
    this.aboutEl.textContent =
      'What this machine is doing. Everything here is read from counters the system keeps for every program — ' +
      'nothing is installed, no driver is loaded and nothing is asked of an administrator.'
    this.element.appendChild(this.aboutEl)

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'monitor-body'
    this.element.appendChild(this.bodyEl)

    const waiting = document.createElement('div')
    waiting.className = 'diff-empty'
    waiting.textContent = 'Reading…'
    this.bodyEl.appendChild(waiting)

    this.element.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      this.openBlockMenu(e.clientX, e.clientY)
    })

    this.unwatch = watchSystem((stats, history) => this.render(stats, history), POLL_MS)
    // Toggling a block should land immediately rather than on the next sample,
    // which is up to two seconds away.
    this.unsubscribe = store.subscribe(() => this.render(latestSystem(), systemHistory()))

    // Its own clock, and a slow one. The collector caches for ten minutes, so
    // this mostly returns without touching the network — see `refreshWeather`.
    // Opening this panel is the deliberate act that earns a keychain dialog on
    // macOS, if one was dismissed earlier. Nothing happens on any other platform
    // or in the ordinary case, where the last poll already has the numbers.
    refreshUsageNow(true)

    void this.refreshWeather()
    this.weatherTimer = setInterval(() => void this.refreshWeather(), 60_000)
  }

  private render(stats: SystemStats | null, history: SystemHistory): void {
    if (this.disposed) return

    if (!stats) {
      const problem = document.createElement('div')
      problem.className = 'diff-empty'
      problem.textContent = 'That sample could not be taken. Still watching — the next one is a couple of seconds away.'
      this.bodyEl.replaceChildren(problem)
      return
    }

    // Only the blocks that are switched on, in the order `MONITOR_BLOCKS`
    // states once. A panel you leave open beside your work is one where what
    // earns its space is personal, so the list is the user's — see the
    // right-click menu, and `readSystemStats`, which skips its one expensive
    // probe outright when the drives block is off.
    //
    // `drives` and `volumes` are the exception to one entry, one card: a volume
    // is drawn under the drive it sits on, so with both on they are one block
    // and the volumes entry builds nothing of its own. It becomes a card only
    // when the drives block is off and there is no drive left to sit under.
    const volumes = store.monitorShows('volumes')
    const build: Record<string, () => HTMLElement> = {
      cpu: () => this.cpuCard(stats, history),
      gpu: () => this.gpuCard(stats, history),
      network: () => this.networkCard(stats, history),
      drives: () => this.drivesCard(stats, history, volumes),
      volumes: () => this.volumesCard(stats),
      temperatures: () => this.sensorsCard(stats),
      claude: () => this.claudeCard(),
      app: () => this.appCard(stats),
      system: () => this.systemCard(stats),
      weather: () => this.weatherCard(),
      air: () => this.airCard(),
    }

    const cards = this.drawn().map((id) => this.draggable(build[id](), id))
    this.bodyEl.replaceChildren(
      ...(cards.length ? cards : [this.note('Every block is switched off. Right-click here to bring one back.')])
    )
  }

  /**
   * The blocks that end up on screen, in the order they are drawn.
   *
   * Not the same list as the ones switched on: `volumes` is on and absent for
   * as long as the drives block is the thing drawing it. Said in one place
   * because the drop maths has to work among the boxes that are *there* — a
   * block that is on but not drawn puts every card after it one slot out, which
   * is the same bug the hidden blocks caused before `drop` started translating
   * through the block it lands in front of.
   */
  private drawn(): string[] {
    const drives = store.monitorShows('drives')
    return store.monitorBlocks
      .map((block) => block.id)
      .filter((id) => store.monitorShows(id))
      .filter((id) => id !== 'volumes' || !drives)
  }

  /**
   * Which blocks to show, on the panel's own right-click.
   *
   * A menu rather than buttons in the title bar: the bar has one control and
   * the point of it is that it has one. Right-click is where a list of "what
   * is in this thing" belongs, and it is the same gesture every other panel in
   * this app answers.
   */
  private openBlockMenu(x: number, y: number): void {
    showContextMenu(
      x,
      y,
      store.monitorBlocks.map((block) => ({
        label: block.label,
        checked: store.monitorShows(block.id),
        onClick: () => store.setMonitorBlock(block.id, !store.monitorShows(block.id)),
      }))
    )
  }

  /**
   * Lets a block be dragged into a different place in the panel.
   *
   * By its heading rather than anywhere on the card, because the cards hold
   * things you click — a drive row, a filename, a usage bar — and a card that
   * starts moving when you press one of those is a card you cannot use. The
   * heading is the part with nothing in it, which is what makes it the handle.
   *
   * The drop line is drawn on the card being hovered rather than the list being
   * re-laid-out live: reordering under the cursor makes the target move as you
   * approach it, which is the interaction everybody has fought at least once.
   */
  private draggable(card: HTMLElement, id: string): HTMLElement {
    card.dataset.block = id
    const head = card.querySelector('.monitor-card__head') as HTMLElement | null
    if (head) {
      head.draggable = true
      head.title = 'Drag to move this block'
      head.addEventListener('dragstart', (e) => {
        this.dragging = id
        e.dataTransfer?.setData('text/plain', id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      head.addEventListener('dragend', () => {
        this.dragging = null
        for (const el of this.bodyEl.querySelectorAll('.drop-before, .drop-after')) {
          el.classList.remove('drop-before', 'drop-after', 'drop-across')
        }
      })
    }

    card.addEventListener('dragover', (e) => {
      if (!this.dragging || this.dragging === id) return
      e.preventDefault()
      // Which half of the card the pointer is in decides which side of it the
      // block lands on, so a drag to the very bottom can reach the last slot.
      const box = card.getBoundingClientRect()
      const across = this.horizontal()
      const after = across
        ? e.clientX > box.left + box.width / 2
        : e.clientY > box.top + box.height / 2
      // Which way the line is drawn is the same answer, said to the stylesheet:
      // a line along the edge the block would land on, whichever axis that is.
      card.classList.toggle('drop-across', across)
      card.classList.toggle('drop-before', !after)
      card.classList.toggle('drop-after', after)
    })
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget as Node)) {
        card.classList.remove('drop-before', 'drop-after', 'drop-across')
      }
    })
    card.addEventListener('drop', (e) => {
      const moving = this.dragging
      card.classList.remove('drop-before', 'drop-after', 'drop-across')
      if (!moving || moving === id) return
      e.preventDefault()
      this.dragging = null

      const box = card.getBoundingClientRect()
      const after = this.horizontal()
        ? e.clientX > box.left + box.width / 2
        : e.clientY > box.top + box.height / 2

      // Where it lands is worked out among the blocks that are *on screen*, and
      // then translated into a position in the full list — which is the whole
      // of this. The two lists are not the same list the moment anything is
      // switched off, and handing a position in the visible one to a store that
      // indexes the complete one put the block a slot early for every hidden
      // block above it: the drop line said one thing and the panel did another.
      //
      // Translated through the block it should end up *in front of* rather than
      // by counting, because that is the one fact both lists agree on. Null
      // means the end.
      const all = store.monitorBlocks.map((b) => b.id)
      const shown = this.drawn()
      let slot = shown.indexOf(id) + (after ? 1 : 0)
      // Removing the dragged block first shifts everything after it up by one,
      // so a drop below its old position has to account for that.
      if (shown.indexOf(moving) < slot) slot -= 1
      const rest = shown.filter((blockId) => blockId !== moving)
      const anchor = rest[slot] ?? null

      // `moveMonitorBlock` inserts at a position in the list with the block
      // already taken out of it, so the anchor is looked up in that same list.
      const without = all.filter((blockId) => blockId !== moving)
      store.moveMonitorBlock(moving, anchor === null ? without.length : without.indexOf(anchor))
    })
    return card
  }

  /**
   * True when the blocks run across rather than down.
   *
   * Which half of a card a drop counts as depends on it: left/right of the
   * middle where they run across, above/below where they stack. Asked of the
   * boxes themselves rather than of the display mode — `grid` was the old test
   * and it is not the same question, since the pane in a tab is a grid that is
   * a single column whenever it is narrow, and there a drop was being judged on
   * the axis the blocks do not move along.
   */
  private horizontal(): boolean {
    const [first, second] = this.bodyEl.children
    if (!first || !second) return false
    return second.getBoundingClientRect().left >= first.getBoundingClientRect().right - 1
  }

  // ---------------------------------------------------------------- cards

  /**
   * Load, temperature and memory as three numbers and one picture.
   *
   * Laid out the way the Rainmeter skin this borrows from lays it out, and the
   * reasons are its reasons. A label reading "busy" beside a number ending in
   * `%` is a word spent saying what the symbol already said, so the figures
   * carry their own units and nothing else. The three graphs share one trough
   * and are told apart by colour, because the interesting thing about load and
   * temperature is the *lag* between them and a lag is invisible when the two
   * are stacked in separate boxes.
   *
   * The per-core bars are not labelled "cores" either. There is a bar for each,
   * so anyone who wants the number can count them, and the row exists to answer
   * a different question anyway: whether it is one thread pinned or all of them
   * working, which is the difference between a stuck process and a build.
   */
  private cpuCard(stats: SystemStats, history: SystemHistory): HTMLElement {
    const ram = percent(stats.memory.used, stats.memory.total)
    // The sensor, not only its value: a processor publishes several and they
    // disagree by tens of degrees, so a bare number is one nothing else on the
    // machine can be checked against. See `cpuTemperature`.
    const sensor = cpuTemperature(stats.temperatures)
    const temp = sensor?.celsius ?? history.cpuTemp[history.cpuTemp.length - 1] ?? null

    // Load, heat and memory on the heading's own line, which is the skin's
    // arrangement and saves a line per block over a row of its own. The model
    // is what the line would otherwise have carried; it is now the tooltip on
    // the word `cpu`, because a part number is read once and then never again.
    const card = this.card('cpu', stats.cpu.model, [
      { value: stats.cpu.load === null ? null : `${stats.cpu.load.toFixed(0)}%`, empty: '--%', tone: band(stats.cpu.load), series: 'load', title: 'Processor busy' },
      {
        value: temp === null ? null : `${temp.toFixed(0)}°C`,
        empty: '--°C',
        tone: temp === null ? 'idle' : hot({ name: '', celsius: temp, kind: 'cpu' }),
        series: 'temp',
        title: sensor ? `Processor temperature — ${sensor.name}` : 'Processor temperature',
      },
      // Never banded, unlike the two beside it. Memory filling up is what the
      // green line is drawing, and a figure that turns amber at 75% and red at
      // 90% is a figure that has stopped being the line's label at exactly the
      // moment somebody looks up to find out which line is which. The number
      // says 87% on its own; it does not need a second colour to say it again.
      { value: `${ram.toFixed(0)}%`, tone: 'idle', label: 'ram', series: 'memory', title: `${bytes(stats.memory.used)} of ${bytes(stats.memory.total)} in use` },
    ])

    // Load, temperature and memory over each other. Temperature keeps its own
    // ceiling — a percentage and a Celsius reading share no scale, and forcing
    // them onto one would flatten whichever is smaller into the floor.
    card.appendChild(
      this.graphs([
        { values: history.cpu, className: 'spark__line--a', max: 100 },
        { values: history.cpuTemp, className: 'spark__line--b', max: 100 },
        { values: history.memory, className: 'spark__line--c', max: 100 },
      ])
    )

    // What no process list contains, and what "where has my memory gone" is
    // actually asking. Only shown where the platform answered — see MemoryStats.
    const mem = stats.memory
    // Promised *against the limit*, not against physical memory.
    //
    // Committing more than the machine has is ordinary and costs nothing on its
    // own: a promise is an entry in a ledger, and most of what is promised is
    // never touched, so it is stored neither in memory nor on disk. Measured on
    // the machine this was written on — 25 GB promised against 15 GB of memory,
    // with 1.5 GB actually in the page file. Reporting the 10 GB difference as
    // "kept on disk" was wrong by a factor of six.
    //
    // What genuinely bites is the promise running out. Windows refuses an
    // allocation the moment the ledger is full, and a program refused memory
    // does not slow down, it fails — so this warns as the limit approaches and
    // says nothing at all before then.
    const strained =
      mem.committed !== null && mem.commitLimit !== null && mem.committed > mem.commitLimit * 0.85
    if (strained) {
      card.appendChild(
        this.note(
          `${bytes(mem.committed!)} of the ${bytes(mem.commitLimit!)} this machine can promise is already spoken for. ` +
            'Past the limit Windows starts refusing memory outright, and programs fail rather than slow down. ' +
            'Closing something, or growing the page file, is what makes room.'
        )
      )
    }
    // No row of memory detail here any more. `free`, `promised` and `drivers`
    // were added to answer one diagnostic question and then sat on screen for
    // ever afterwards: what has been promised is not a thing to watch, since
    // exceeding physical memory is ordinary, and the driver pools change about
    // as often as the drivers do. The percentage above already carries the
    // fact worth glancing at, and it has a line behind it. All three are still
    // collected — they cost nothing, and the warning above needs them.

    if (stats.cpu.perCore.length) {
      const cores = document.createElement('div')
      cores.className = 'monitor-cores'
      for (const [index, value] of stats.cpu.perCore.entries()) {
        const cell = document.createElement('span')
        // Not banded, and not the theme's accent either. These bars are load —
        // the same fact as the `%` at the top of the block and the same line on
        // the graph — so they are drawn in load's colour and stay in it. A bar
        // that turns red at 90% is a bar you can no longer match to anything
        // else on the card, and its own height had already said as much.
        cell.className = 'monitor-core'
        // Which core, as well as how busy. The bars are two pixels wide and
        // counting along a row of twenty-four to work out which one you are
        // pointing at is not something to ask of somebody who just wanted to
        // know whether it is one thread pinned or all of them. Numbered from 0,
        // which is what every other tool on the machine calls the first one.
        cell.title = `core ${index}: ${value.toFixed(0)}%`
        const fill = document.createElement('span')
        fill.className = 'monitor-core__fill'
        fill.style.height = `${Math.max(2, value)}%`
        cell.appendChild(fill)
        cores.appendChild(cell)
      }
      card.appendChild(cores)
    }

    // No load average. It was three numbers that read like percentages, are not
    // percentages, and answer a question this card already answers better: the
    // busy figure and the per-core bars say what the processor is doing now, and
    // the run queue only adds to that on a machine deep enough into overload
    // that you would know without being told. It is also not comparable between
    // these machines — 6.0 across an Apple efficiency cluster and 6.0 across
    // desktop cores are different amounts of work — so the one reading it could
    // have supported was a misleading one.
    return card
  }

  /**
   * The card that carries its units instead of labels.
   *
   * Four numbers — busy, degrees, memory, watts — and only the memory one needs
   * a word, because `4.2 GB` on its own could be the card's memory or the
   * machine's. `%`, `°` and `W` say what they are, and repeating that in a
   * label beside them is the noise this was rearranged to remove.
   */
  private gpuCard(stats: SystemStats, history: SystemHistory): HTMLElement {
    const gpu = stats.gpus[0]
    if (!gpu) {
      const card = this.card('gpu', 'no readable graphics card')
      // Named rather than blank. "No GPU row" reads as the app being unfinished;
      // this reads as the machine not having a source, which is the truth, and
      // it says what would change that.
      card.appendChild(
        this.note(
          'Graphics load and temperature come from nvidia-smi, which arrives with the NVIDIA driver. ' +
            'AMD and Intel cards publish nothing a program can read without a sensor driver, so there is nothing to show here. ' +
            'A Mac publishes its own load and memory and needs nothing installed, so an empty card there means the registry did not answer.'
        )
      )
      return card
    }

    // Same shape as the processor block: the card's name is the tooltip and the
    // readings have the heading's line.
    const card = this.card('gpu', gpu.name, [
      { value: gpu.load === null ? null : `${gpu.load.toFixed(0)}%`, empty: '--%', tone: band(gpu.load), series: 'load', title: 'Graphics busy' },
      {
        value: gpu.temperature === null ? null : `${gpu.temperature.toFixed(0)}°C`,
        empty: '--°C',
        tone: gpu.temperature === null ? 'idle' : hot({ name: '', celsius: gpu.temperature, kind: 'gpu' }),
        series: 'temp',
        title: 'Graphics temperature',
      },
      {
        value: gpu.memoryUsed === null ? null : bytes(gpu.memoryUsed, 1),
        empty: '-- GB',
        label: 'vram',
        series: 'memory',
        tone: gpu.memoryUsed !== null && gpu.memoryTotal ? band(percent(gpu.memoryUsed, gpu.memoryTotal)) : 'idle',
        title: gpu.memoryTotal ? `of ${bytes(gpu.memoryTotal)}` : 'Graphics memory in use',
      },
      { value: gpu.power === null ? null : `${gpu.power.toFixed(0)} W`, empty: '-- W', tone: 'idle', title: 'Power draw' },
    ])

    card.appendChild(
      this.graphs([
        { values: history.gpuLoad, className: 'spark__line--a', max: 100 },
        { values: history.gpuTemp, className: 'spark__line--b', max: 100 },
        { values: history.gpuMemory, className: 'spark__line--c', max: 100 },
      ])
    )
    return card
  }

  private networkCard(stats: SystemStats, history: SystemHistory): HTMLElement {
    const down = history.rx[history.rx.length - 1] ?? null
    const up = history.tx[history.tx.length - 1] ?? null
    // `net`, and one line: the word, what is coming down and what is going up.
    // Down and up are one fact about one connection, and reading them off two
    // rows means comparing two numbers that were never side by side.
    const card = this.card(
      'net',
      `${stats.networks.length} interface${stats.networks.length === 1 ? '' : 's'} carrying traffic`,
      [
        { value: `↓ ${rate(down)}`, tone: 'idle' as const, series: 'load' as const, title: 'Coming in' },
        { value: `↑ ${rate(up)}`, tone: 'idle' as const, series: 'memory' as const, title: 'Going out' },
      ]
    )

    // Both on one pair of axes, scaled together, because the thing you are
    // usually asking is which of them is happening — and drawn by the same
    // helper as every other graph here, so the trough behind them matches. Two
    // separately-stacked sparklines was the old spelling and it left the
    // network the one block with a different background.
    const ceiling = Math.max(1, ...[...history.rx, ...history.tx].filter((v): v is number => v !== null))
    card.appendChild(
      this.graphs([
        { values: history.rx, className: 'spark__line--a', max: ceiling },
        { values: history.tx, className: 'spark__line--c', max: ceiling },
      ])
    )

    const list = document.createElement('div')
    list.className = 'monitor-list'
    // The name and the address get a column apiece, measured the same way the
    // volume rows are measured and for the same reason: both are strings that do
    // not change between polls, and a column sized to them is a column the rates
    // cannot walk. See `alignNetwork`.
    this.alignNetwork(list, stats.networks)
    for (const net of [...stats.networks].sort((a, b) => (b.rxPerSec ?? 0) + (b.txPerSec ?? 0) - ((a.rxPerSec ?? 0) + (a.txPerSec ?? 0)))) {
      const row = document.createElement('div')
      row.className = 'monitor-list__row'
      const name = document.createElement('span')
      name.className = 'monitor-list__name'
      name.textContent = net.name
      name.title = `${bytes(net.rxTotal)} in and ${bytes(net.txTotal)} out since this machine booted.`
      row.appendChild(name)
      // The address this one answers on. The first is the one worth the width —
      // IPv4 where there is one — and an interface holding several says so on
      // hover rather than pushing the rates off the row.
      const addr = document.createElement('span')
      addr.className = 'monitor-list__addr'
      addr.textContent = net.addresses[0] ?? ''
      if (net.addresses.length > 1) {
        addr.title = `${net.name} also answers on ${net.addresses.slice(1).join(', ')}.`
      }
      row.appendChild(addr)
      const value = document.createElement('span')
      value.className = 'monitor-list__value'
      value.appendChild(this.rateCell('↓', net.rxPerSec))
      value.appendChild(this.rateCell('↑', net.txPerSec))
      row.appendChild(value)
      list.appendChild(row)
    }
    card.appendChild(list)
    return card
  }

  /**
   * One direction's rate, in a cell of its own.
   *
   * Two cells rather than one string, and the pair hard against the right edge:
   * that is what keeps the numbers still without reserving room for numbers
   * nobody has. Up is last, so it never moves at all; down growing a character
   * takes the character from the gap in the middle of the row, which is the one
   * place on the line where nothing is written.
   */
  private rateCell(arrow: string, value: number | null | undefined): HTMLElement {
    const cell = document.createElement('span')
    cell.className = 'monitor-list__rate'
    cell.textContent = `${arrow} ${rate(value)}`
    return cell
  }

  /**
   * The width of the two columns the network rows share.
   *
   * Measured, for the reason `alignVolumes` explains at length — the columns
   * have to agree across rows that no `auto` track can see at once. What is
   * measured here is the part of the row that *does not* move: an interface is
   * called what it is called and answers where it answers, so a column sized to
   * the widest of each is a column with no slack in it and no drift either. All
   * the change on the line is in the rates, and they sit at the far end with the
   * flexible gap in front of them.
   *
   * The address column is fixed rather than shrinkable, unlike the name: a name
   * clipped to `Ethern…` is still the row you know, and half an IP is nothing at
   * all. So a row too narrow for everything takes it out of the name.
   */
  private alignNetwork(list: HTMLElement, nets: NetworkStats[]): void {
    if (!nets.length) return
    const addresses = nets.map((net) => net.addresses[0] ?? '')
    const name = this.widest(nets.map((net) => net.name))
    const addr = addresses.some(Boolean) ? this.widest(addresses) : 0
    if (name === null || addr === null) return
    list.style.setProperty('--net-name', `${name}px`)
    list.style.setProperty('--net-addr', `${addr}px`)
  }

  /**
   * How wide the widest of these strings is drawn, in pixels, or null if the
   * measuring canvas could not be had.
   *
   * On a canvas rather than by asking the laid-out rows: reading geometry and
   * then writing it back, twice a second, is the shape of every layout thrash
   * there has ever been. Nothing is in the document yet when this runs.
   *
   * Two pixels of slack, because the figures are drawn in tabular numerals and
   * measured in whatever the face's default is — the same width in most
   * interface fonts, and a hair wider in the rest. The size and the family have
   * to be asked for rather than assumed: the family is a setting, and the themes
   * change it.
   */
  private widest(texts: string[]): number | null {
    const gauge = (MonitorPane.gauge ??= document.createElement('canvas').getContext('2d'))
    if (!gauge) return null
    gauge.font = `11px ${getComputedStyle(this.element).fontFamily || 'sans-serif'}`
    return Math.ceil(Math.max(...texts.map((text) => gauge.measureText(text).width))) + 2
  }

  /**
   * The drives, and the volumes that sit on them.
   *
   * One block rather than two. Volumes and drives were separate cards, and the
   * split put "C: is 86% full" a screen away from "the disk C: lives on is at
   * 61 °C and 3% worn" — two halves of one question about one piece of
   * hardware, which is how you end up scrolling between them to answer it.
   *
   * No bars. A bar is a good way to show one proportion and a poor way to show
   * four numbers, and every reading here already carries its unit. What earns
   * the space instead is a *graph*, because activity and temperature are the
   * two things that move and the two things a bar cannot show over time.
   *
   * Which volumes belong to which drive is free: the Windows counter names its
   * instances `0 C:` — the device number, then the letters on it — so the
   * grouping falls out of a string that had to be parsed anyway.
   *
   * `volumes` is that half of the block switched on or off from the same menu
   * as everything else. Off, this is the hardware alone; on, the letters sit
   * under the drive they are on and the two are one block. See `MONITOR_BLOCKS`.
   */
  private drivesCard(stats: SystemStats, history: SystemHistory, withVolumes: boolean): HTMLElement {
    const count = Math.max(stats.diskIo.length, stats.health.length)
    const drives = count ? `${count} drive${count === 1 ? '' : 's'}` : 'no drives answered'
    const card = this.card(
      'drives',
      withVolumes && stats.disks.length
        ? `${drives}, ${stats.disks.length} volume${stats.disks.length === 1 ? '' : 's'}`
        : drives
    )
    // Every volume in the block draws its bar between the same two edges, and
    // this is what tells them where those edges are. Done once for the card, on
    // the whole of `stats.disks`, because every volume ends up in it by one path
    // or the other — under the drive it sits on, or in the unclaimed list below.
    if (withVolumes) this.alignVolumes(card, stats.disks)

    if (!stats.diskIo.length && !stats.health.length) {
      card.appendChild(
        this.note(
          'Throughput and drive health are read on a slower clock than the rest of this panel, so the first sample after ' +
            'opening it is empty. If this stays empty, nothing on this machine answered.'
        )
      )
      // The volumes are known even when the drives are not, and a full disk is
      // worth saying regardless of what is underneath it.
      if (withVolumes) for (const volume of stats.disks) card.appendChild(this.volumeRow(volume))
      return card
    }

    const claimed = new Set<string>()
    for (const io of stats.diskIo) {
      const name = io.label ?? io.name
      const health = stats.health.find((h) => h.name === name)
      const letters = volumeLetters(io.name)
      const volumes = stats.disks.filter((v) => letters.includes(v.mount.toUpperCase()))
      for (const v of volumes) claimed.add(v.mount)

      const row = document.createElement('div')
      row.className = 'monitor-drive'

      // The drive's own line: what it is called, then how hard it is working,
      // how hot it is and how worn — the readings beside the name rather than
      // under it, which is a line saved on every drive in the machine.
      const head = document.createElement('div')
      head.className = 'monitor-drive__head'
      const label = document.createElement('span')
      label.className = 'monitor-drive__name'
      // `model` is what the sensor source calls the drive and `name` is what
      // the storage stack calls it. They differ only when there is an enclosure
      // in between — Windows names the enclosure and the sensor source names
      // the disk in it — and then both are true of different things, so both
      // are shown, in the order that reads as a sentence.
      label.textContent = health?.model && health.model !== name ? `${health.model} in ${name}` : name
      label.title = io.name
      head.appendChild(label)
      head.appendChild(
        this.figures([
          { value: io.busyPercent === null ? null : `${io.busyPercent.toFixed(0)}%`, empty: '--%', tone: io.busyPercent === null ? 'idle' : band(io.busyPercent), series: 'load', title: 'Percent of the time this drive was working' },
          { value: health?.temperature != null ? `${health.temperature.toFixed(0)}°C` : null, empty: '--°C', tone: health?.temperature != null ? hot({ name: '', celsius: health.temperature, kind: 'disk' }) : 'idle', series: 'temp', title: 'Drive temperature' },
          { value: health?.wearPercent != null ? `${health.wearPercent.toFixed(0)}%` : null, empty: '--%', label: 'worn', tone: (health?.wearPercent ?? 0) >= 80 ? 'high' : (health?.wearPercent ?? 0) >= 50 ? 'warn' : 'idle', title: 'Percent of the rated write life used' },
          // Right, in fixed character-width columns — the alignment lives in
          // `.monitor-figures--drive`, and the reason it has to is that a name
          // of any length precedes it. The `left` above is what the variant
          // overrides; it is left in place so the row still reads as a table if
          // the variant is ever dropped.
        ], 'left', 'monitor-figures--drive')
      )
      row.appendChild(head)

      // The letters go directly under the drive they are on, before the graph
      // rather than after it. Both orders group correctly and only one of them
      // *looks* it: with a graph in between, a volume row sits closer to the
      // next drive's name than to its own, and the grouping the counter's
      // instance name hands us for free reads as an accident.
      if (withVolumes) for (const volume of volumes) row.appendChild(this.volumeRow(volume))

      // Activity and heat over each other: a drive that is warm because it is
      // working looks different from one that is simply warm, and that is only
      // visible when the two share an axis.
      row.appendChild(
        this.graphs([
          { values: history.driveBusy[name] ?? [], className: 'spark__line--a', max: 100 },
          { values: history.driveTemp[name] ?? [], className: 'spark__line--b', max: 100 },
        ])
      )
      card.appendChild(row)
    }

    // Anything the counters did not account for — a drive with no throughput
    // instance, or a volume on hardware that reported nothing.
    if (withVolumes) {
      for (const volume of stats.disks) {
        if (!claimed.has(volume.mount)) card.appendChild(this.volumeRow(volume))
      }
    }
    return card
  }

  /**
   * The volumes with no drives above them.
   *
   * Only reached with the drives block switched off, because that is the only
   * time these have nothing to sit under. Same rows, same measured columns —
   * what changes is that they carry a heading of their own instead of borrowing
   * the drive's. Switching the drives back on folds them into it again.
   */
  private volumesCard(stats: SystemStats): HTMLElement {
    const count = stats.disks.length
    const card = this.card('volumes', count ? `${count} volume${count === 1 ? '' : 's'}` : 'no volumes answered')
    // The rows are indented under a drive's name in the merged block. Here there
    // is no name to indent from, so the rule that draws that relationship would
    // be drawing one that is not there.
    card.classList.add('monitor-card--volumes')
    this.alignVolumes(card, stats.disks)
    if (!count) {
      card.appendChild(this.note('Nothing on this machine reported a fixed volume.'))
      return card
    }
    for (const volume of stats.disks) card.appendChild(this.volumeRow(volume))
    return card
  }

  /**
   * One volume: what it is called, how full it is, and what is left.
   *
   * The bar is back, and only here. A bar shows one proportion, which is
   * exactly what "how full is this disk" is — where the drive's four readings
   * above it are four different things and a bar apiece said nothing. It sits
   * between the name and the figure so the row reads left to right as one
   * sentence: which volume, how full, how much is left.
   */
  private volumeRow(disk: DiskStats): HTMLElement {
    const row = document.createElement('div')
    row.className = 'monitor-volume'

    const name = document.createElement('span')
    name.className = 'monitor-volume__name'
    name.textContent = volumeName(disk)
    row.appendChild(name)

    const used = percent(disk.total - disk.free, disk.total)
    const track = document.createElement('span')
    track.className = `monitor-volume__bar monitor-volume__bar--${band(used)}`
    const fill = document.createElement('span')
    fill.className = 'monitor-volume__fill'
    fill.style.width = `${used}%`
    track.appendChild(fill)
    row.appendChild(track)

    const value = document.createElement('span')
    value.className = 'monitor-volume__value'
    value.textContent = volumeValue(disk)
    if (used >= 90) value.classList.add('high')
    else if (used >= 75) value.classList.add('warn')
    row.appendChild(value)

    row.title = `${used.toFixed(0)}% of ${disk.mount} is in use — ${bytes(disk.total - disk.free)} used, ${bytes(disk.free)} free of ${bytes(disk.total)}.`
    return row
  }

  /**
   * How wide the name and the figure are allowed to be, for every volume at
   * once.
   *
   * The bars only read as one scale if they all begin and end in the same
   * place, and the two things deciding that — the longest volume name and the
   * longest "x free of y" — are spread across separate drive rows, so no `auto`
   * column can see all of them. CSS's own answer would be a subgrid threaded up
   * through the drive to the block, and it costs the block its `display: flex`,
   * which is what lets a docked graph take the leftover height.
   *
   * So the two widths are measured here and handed down as custom properties.
   * On a canvas rather than by asking the laid-out rows: that would be a read
   * of geometry followed by a write of it, twice a second, which is the shape
   * of every layout thrash there has ever been. Nothing is in the document yet
   * when this runs, and nothing needs to be.
   */
  private alignVolumes(card: HTMLElement, disks: DiskStats[]): void {
    if (!disks.length) return
    const name = this.widest(disks.map(volumeName))
    const value = this.widest(disks.map(volumeValue))
    if (name === null || value === null) return
    card.style.setProperty('--vol-name', `${name}px`)
    card.style.setProperty('--vol-value', `${value}px`)
  }

  /**
   * Temperatures, or the reason there are none.
   *
   * The card exists even when it is empty, and that is the point. A machine
   * that cannot report a CPU temperature is the ordinary case on Windows, and
   * an absent card reads as a feature nobody finished — while an empty one with
   * a sentence in it reads as the truth, which is that the reading is behind a
   * kernel driver this app will not ship.
   */
  private sensorsCard(stats: SystemStats): HTMLElement {
    const card = this.card(
      'temperatures',
      stats.sources.temperature ? `from ${stats.sources.temperature}` : 'nothing on this machine will say'
    )

    if (!stats.temperatures.length) {
      card.appendChild(this.note(stats.sources.temperatureNote ?? 'No temperature sensor answered.'))
    }

    for (const reading of stats.temperatures) {
      card.appendChild(
        this.reading(
          reading.name,
          `${reading.celsius.toFixed(0)} °C`,
          // Thresholds for a processor. A drive above 60 is already worth
          // knowing about, which is why the two are not judged alike.
          hot(reading)
        )
      )
    }

    // Under the degrees rather than instead of them, and only where there are
    // any to be under. It answers the question the degrees are usually being
    // read for — is this machine about to slow down — and on a Mac, where there
    // are no degrees to read, it is the whole of the answer.
    if (stats.thermalPressure) {
      const row = this.reading(
        'thermal',
        THERMAL_WORDS[stats.thermalPressure],
        stats.thermalPressure === 'critical' ? 'high' : stats.thermalPressure === 'serious' ? 'warn' : 'idle'
      )
      row.title = 'What the operating system says about its own heat, which is what it will say without a sensor driver.'
      card.appendChild(row)
    }
    return card
  }

  /**
   * How much of your Claude limit is gone, beside how much of your machine is.
   *
   * They belong on one panel for the reason they were split across two places
   * to begin with: both answer "can I start something big right now", and the
   * answer is no if either one says no. The sidebar strip still carries them —
   * this is the same numbers with room for the reset times spelled out.
   *
   * Read from the usage monitor's own five-minute poll rather than fetched
   * again. Two consumers of one request; the windows move on the scale of
   * hours, so there is nothing to be gained by asking twice.
   */
  private claudeCard(): HTMLElement {
    const usage = latestUsage()
    const card = this.card('claude', usage?.status === 'ok' ? 'usage limits' : 'usage limits, if they can be read')
    // Top right of the block, on the heading's line: the other half of "why is
    // Claude not answering" is whether Anthropic is having an incident, and
    // this is where you are standing when you ask.
    card.querySelector('.monitor-card__head')?.appendChild(statusPageLink('status'))

    if (!usage) {
      card.appendChild(this.note('Reading your usage limits…'))
      return card
    }
    if (usage.status !== 'ok') {
      // Never a zero standing in for "we could not ask". At 0% used, signed out
      // and wide open look identical, and one of them is very wrong.
      card.appendChild(
        this.note(
          usage.status === 'signed-out'
            ? 'Claude Code is not signed in on this machine, so there are no limits to report.'
            : usage.status === 'unmetered'
              ? 'This account has no usage limit to report.'
              : usage.status === 'locked'
                ? // Not a failure, and the wording says so — the login is there
                  // and the keychain was told not to hand it over. macOS asks
                  // because the entry belongs to Claude Code rather than to this
                  // app; "Always Allow" answers it once and for good.
                  'macOS keeps Claude Code’s login in the keychain, and this app was not allowed to read it. ' +
                  'Reopen this panel to be asked again, and choose “Always Allow” to be asked only once.'
                : 'Your usage limits could not be read just now.'
        )
      )
      return card
    }

    for (const bucket of usage.buckets) {
      const row = document.createElement('div')
      row.className = 'monitor-disk'

      const head = document.createElement('div')
      head.className = 'monitor-disk__head'
      const name = document.createElement('span')
      name.className = 'monitor-disk__name'
      name.textContent = bucket.label
      head.appendChild(name)
      const value = document.createElement('span')
      value.className = 'monitor-disk__value'
      value.textContent = `${bucket.percent}% used`
      head.appendChild(value)
      row.appendChild(head)

      const track = document.createElement('span')
      track.className = 'monitor-bar'
      const fill = document.createElement('span')
      fill.className = 'monitor-bar__fill'
      fill.style.width = `${Math.min(100, Math.max(0, bucket.percent))}%`
      track.appendChild(fill)
      row.appendChild(track)

      // The reset time on its own line, not in a tooltip. "29%" answers half
      // the question — whether to start something long depends on how long you
      // have left, and a number you must hover for is a number you do not read.
      const reset = usageResetLine(bucket.resetsAt)
      if (reset) {
        const under = document.createElement('div')
        under.className = 'monitor-disk__facts'
        under.textContent = reset
        row.appendChild(under)
      }
      card.appendChild(row)
    }
    return card
  }

  /**
   * The battery and how long the machine has been up.
   *
   * No heading. Every other block names a subsystem — cpu, gpu, drives — and
   * this one is the leftovers: a battery and a clock have nothing in common
   * except that neither is anywhere else. A title over them would be a word
   * picked to cover both, which is how a panel ends up with a section called
   * "miscellaneous".
   *
   * The battery detail is the part Windows does not report. A percentage and an
   * estimate come from the platform; what the pack has *lost to age*, and what
   * it is drawing right now, come from a sensor source — see `lhm.ts`.
   */
  /**
   * What this app costs, split by the process spending it.
   *
   * The total was already collected and was not actionable: an Electron app is
   * five or six processes doing unrelated jobs, and which one is holding the
   * memory decides what there is to do about it. The graphics process answers
   * to “draw with the processor instead of the graphics card”; a renderer
   * answers to scrollback and how many panes are mounted; the main process
   * holds the saved screens and answers to neither. Measured on the machine
   * this was written on, the graphics process alone held 349 MB — a third of
   * what the whole app was using, and invisible until it was split out.
   *
   * The one panel that has no excuse for not measuring itself.
   */
  private appCard(stats: SystemStats): HTMLElement {
    const app = stats.app
    const card = this.card('this app', `${app.processes} processes`, [
      {
        value: bytes(app.memory, 1),
        tone: 'idle',
        series: 'memory',
        title: 'Memory held by every process this app runs',
      },
      {
        value: `${app.cpu.toFixed(0)}%`,
        tone: band(Math.min(100, app.cpu)),
        series: 'load',
        title: 'Percent of one core, summed over those processes',
      },
    ])

    for (const part of app.parts) {
      card.appendChild(
        this.reading(
          part.count > 1 ? `${part.type} ×${part.count}` : part.type,
          `${bytes(part.memory, 1)}`,
          'idle'
        )
      )
    }

    // Said here rather than in the settings panel because this is where the
    // number that justifies it is: a graphics process holding hundreds of
    // megabytes on a machine that is short of them is the whole case for
    // drawing with the processor instead, and it is only a case while that
    // number is large.
    const gpu = app.parts.find((p) => p.type === 'gpu')
    if (gpu && gpu.memory > 250 * 1024 * 1024 && !store.settings.useSoftwareRendering) {
      card.appendChild(
        this.note(
          `The graphics process is holding ${bytes(gpu.memory, 1)}. On a machine short of memory, ` +
            '“draw with the processor instead of the graphics card” in Settings gives most of that ' +
            'back, at the cost of slower drawing in full-screen programs.'
        )
      )
    }
    return card
  }

  private systemCard(stats: SystemStats): HTMLElement {
    const card = this.card('battery', stats.battery?.charging === true ? 'on mains' : 'on battery')
    const battery = stats.battery

    if (battery) {
      card.appendChild(
        this.figures([
          {
            value: `${battery.percent}%`,
            tone: battery.percent <= 15 && battery.charging === false ? 'high' : 'idle',
            series: 'memory',
            title: battery.charging === true ? 'Charged, on mains' : 'Charge left',
          },
          {
            // A sign rather than a word: plus is charging and minus is not,
            // which is one glyph where "discharging at" is two words that push
            // the number out of its column.
            value:
              battery.rateWatts === null
                ? null
                : `${battery.charging === false ? '−' : '+'}${Math.abs(battery.rateWatts).toFixed(1)} W`,
            empty: '-- W',
            tone: 'idle',
            series: 'load',
            title: 'Watts going in or out right now',
          },
          {
            value: battery.wearPercent === null ? null : `${battery.wearPercent.toFixed(1)}%`,
            empty: '--%',
            label: 'worn',
            tone:
              (battery.wearPercent ?? 0) >= 30 ? 'high' : (battery.wearPercent ?? 0) >= 15 ? 'warn' : 'idle',
            // The cycle count is the other half of this number and belongs
            // beside it: a pack can read as unworn and still be old, and the two
            // together say which of those you are looking at.
            title:
              (battery.designWh && battery.fullWh
                ? `Holds ${battery.fullWh.toFixed(1)} Wh of the ${battery.designWh.toFixed(1)} Wh it was built with`
                : 'How much capacity the battery has lost to age') +
              (battery.cycleCount === null ? '' : `, over ${battery.cycleCount} charge cycles`),
          },
        ])
      )

      card.appendChild(
        this.reading(
          'left',
          battery.secondsLeft
            ? duration(battery.secondsLeft)
            : battery.remainingWh !== null
              ? `${battery.remainingWh.toFixed(1)} Wh`
              : null,
          'idle',
          battery.charging === true
            ? 'On mains, so there is nothing to run down.'
            : 'Neither an estimate nor a remaining capacity was reported.'
        )
      )
    }

    card.appendChild(this.reading('uptime', duration(stats.uptimeSeconds)))
    return card
  }

  /**
   * The weather where you said you are.
   *
   * One of the two blocks that leave this machine, so it does nothing at all
   * until it has been given a place. Weather and air are separate blocks —
   * either can be switched off without the other — but they share one request
   * and one location, so two blocks cost one call. See `readWeather`.
   */
  private weatherCard(): HTMLElement {
    const w = this.weather?.weather
    const card = this.card('weather', w?.place || store.settings.weatherPlace || 'nowhere set')
    card.appendChild(this.locationGear(card))

    if (!w) {
      card.appendChild(this.note(this.weatherProblem()))
      return card
    }

    card.appendChild(
      this.figures([
        {
          value: w.temperature === null ? null : `${w.temperature.toFixed(1)}°C`,
          empty: '--°C',
          tone: 'idle',
          series: 'temp',
          title: w.feelsLike === null ? 'Temperature' : `Feels like ${w.feelsLike.toFixed(1)}°C`,
        },
        {
          value: w.humidity === null ? null : `${w.humidity.toFixed(0)}%`,
          empty: '--%',
          label: 'hum',
          tone: 'idle',
          series: 'load',
          title: 'Humidity',
        },
        {
          value: w.pressure === null ? null : `${w.pressure.toFixed(0)} hPa`,
          empty: '--',
          tone: 'idle',
          title: 'Pressure at the surface',
        },
      ])
    )
    card.appendChild(this.reading('sky', w.description || null))
    card.appendChild(
      this.reading(
        'wind',
        w.windSpeed === null
          ? null
          : `${w.windSpeed.toFixed(1)} km/h${w.windDegrees === null ? '' : ` from ${compass(w.windDegrees)}`}`
      )
    )
    return card
  }

  /**
   * The air, in the units every service reports it in.
   *
   * The index carries its scale, because the two providers do not share one:
   * Open-Meteo reports the European index, which runs from 0 to past 100, and
   * OpenWeatherMap reports 1 to 5. A bare number would be unreadable and would
   * look perfectly fine, which is worse.
   */
  private airCard(): HTMLElement {
    const air = this.weather?.air

    if (!air) {
      const card = this.card('air', 'nowhere set')
      card.appendChild(this.locationGear(card))
      card.appendChild(this.note(this.weatherProblem()))
      return card
    }

    // The heading carries the place and nothing else — `air`, where, and the
    // gear. The readings are all one kind of thing and belong together in a
    // block of their own rather than with two of them promoted into the title.
    const card = this.card('air', `${airWords(air)} at ${store.settings.weatherPlace || 'the coordinates you set'}`)
    card.appendChild(this.locationGear(card))

    // All eight in one element rather than two rows of four, and the block's
    // own width decides whether that draws as one line or two — see
    // `.monitor-figures--air`, which is four columns until there is room for
    // eight. Two hand-written rows could only ever be two.
    //
    // Left-aligned, so wherever the wrap falls the columns above and below each
    // other agree and it reads as a table rather than as two sentences. Every
    // value but the index is µg/m³, so the unit is said once in the tooltips
    // and never on screen — eight repetitions of the same three characters is
    // noise.
    card.appendChild(
      this.figures(
        [
          {
            value: air.index === null ? null : String(Math.round(air.index)),
            empty: '--',
            label: 'aqi',
            tone: airIndexTone(air),
            title:
              air.scale === 'owm'
                ? 'OpenWeatherMap air quality index: 1 good, 2 fair, 3 moderate, 4 poor, 5 very poor. It is the worst of the pollutants below, not their average.'
                : 'European Air Quality Index: under 20 good, 40 fair, 60 moderate, 80 poor, above that very poor. It is the worst of the pollutants below, not their average.',
          },
          gasFigure('pm2.5', air.pm2_5, 1, 'Fine particulates, µg/m³ — the reading that matters most for health'),
          gasFigure('pm10', air.pm10, 1, 'Coarse particulates, µg/m³'),
          gasFigure('o3', air.o3, 0, 'Ozone, µg/m³'),
          gasFigure('no2', air.no2, 1, 'Nitrogen dioxide, µg/m³ — traffic'),
          gasFigure('so2', air.so2, 1, 'Sulphur dioxide, µg/m³ — burnt fuel'),
          gasFigure('co', air.co, 0, 'Carbon monoxide, µg/m³'),
          gasFigure('nh3', air.nh3, 1, 'Ammonia, µg/m³ — farming. Not reported by every provider.'),
        ],
        'left',
        'monitor-figures--air'
      )
    )
    return card
  }

  /** Why a weather block is empty, in terms of what to do about it. */
  private weatherProblem(): string {
    const error = this.weather?.error
    if (!error || error === 'no-location') {
      return 'No location set. Press the gear and give it a latitude and longitude — Open-Meteo needs nothing else, no key and no account.'
    }
    if (error === 'no-key') {
      return 'OpenWeatherMap needs a key. Press the gear to add one, or switch to Open-Meteo, which needs none.'
    }
    return `Could not be read: ${error}`
  }

  /**
   * The gear, which opens the one panel both blocks are configured from.
   *
   * It marks the block as well as decorating it: the gear floats over the top
   * right corner, which is where the heading line's last reading now ends, so
   * the block has to hold that corner clear whether the gear is showing or not.
   * Reserved rather than shuffled aside on hover — a number that moves when the
   * pointer nears it is worse than one that sits a few pixels in.
   *
   * With places saved it lists them first and opens the panel from the bottom
   * of that list. Switching between two cities you keep is then one click and
   * one more, where going through the panel meant reading four fields and
   * pressing Save to change one of them.
   */
  private locationGear(card: HTMLElement): HTMLElement {
    card.classList.add('monitor-card--sited')
    const gear = document.createElement('button')
    gear.className = 'monitor-gear'
    gear.textContent = '⚙'
    // Says what pressing it does, in the words the thing is called. It read
    // "Where to look, and who to ask", which is the sentence that explains the
    // panel to somebody already inside it and a riddle to anybody hovering a
    // gear wondering what it is about to open.
    gear.title = store.settings.weatherPlaces.length
      ? 'Change location, or add one'
      : 'Set the location, and the weather service'
    gear.addEventListener('click', (e) => {
      e.stopPropagation()
      const places = store.settings.weatherPlaces
      if (!places.length) return this.openLocationPanel()
      const s = store.settings
      showContextMenu(e.clientX, e.clientY, [
        ...places.map((entry) => ({
          label: entry.place,
          checked: entry.lat === s.weatherLat && entry.lon === s.weatherLon,
          onClick: () => {
            store.updateSettings({
              weatherPlace: entry.place,
              weatherLat: entry.lat,
              weatherLon: entry.lon,
            })
            // Straight away rather than on the next tick of the weather clock,
            // which is a minute off: a place you just chose that takes a minute
            // to appear reads as a click that did not land. The collector keys
            // its cache on the coordinates, so this is a real request and the
            // old answer is not reused for the new place.
            void this.refreshWeather(true)
          },
        })),
        'separator' as const,
        { label: 'Locations and weather service…', onClick: () => this.openLocationPanel() },
      ])
    })
    return gear
  }

  private openLocationPanel(): void {
    void showWeatherSettings().then((saved) => {
      if (saved) void this.refreshWeather(true)
    })
  }

  /**
   * Asks for the weather, at a fraction of the panel's own rate.
   *
   * The collector caches for ten minutes and this asks every two, which sounds
   * wasteful and is not: the call returns the cached answer without touching
   * the network, and asking often is what makes a changed location appear at
   * once rather than after the deadline.
   */
  private async refreshWeather(force = false): Promise<void> {
    if (this.disposed) return
    const s = store.settings
    const lat = Number(s.weatherLat)
    const lon = Number(s.weatherLon)
    try {
      this.weather = await backend().weather({
        provider: s.weatherProvider,
        lat,
        lon,
        key: s.weatherKey,
        place: s.weatherPlace,
      })
    } catch {
      // Leave the last answer up. See `readWeather` for the same reasoning.
      return
    }
    if (force && !this.disposed) this.render(latestSystem(), systemHistory())
  }

  // -------------------------------------------------------------- pieces

  /**
   * One block, with or without a heading.
   *
   * An empty title still builds the head row, and that is not laziness: the row
   * is what a block is dragged by, so a block without one could not be moved.
   * It is empty rather than absent — the grip stays, the word goes.
   */
  private card(title: string, subtitle: string, figures?: Figure[]): HTMLElement {
    const card = document.createElement('section')
    card.className = 'monitor-card' + (title ? '' : ' monitor-card--untitled')
    const head = document.createElement('div')
    head.className = 'monitor-card__head'
    if (title) {
      const name = document.createElement('h3')
      name.textContent = title
      // Where the subtitle goes when the readings have taken the line: a
      // processor's part number and a card's model are read once and then never
      // again, and a line of their own is a line every block pays for ever
      // after. The tooltip sits on the word rather than on the row because the
      // row is the drag handle and already has one of its own.
      if (figures) name.title = subtitle
      head.appendChild(name)
    }
    if (figures) {
      head.appendChild(this.figures(figures))
    } else {
      const sub = document.createElement('span')
      sub.className = 'monitor-card__sub'
      sub.textContent = subtitle
      sub.title = subtitle
      head.appendChild(sub)
    }
    card.appendChild(head)
    return card
  }

  /** One labelled number, or the reason there is not one. */
  private reading(
    label: string,
    value: string | null,
    tone: 'idle' | 'warn' | 'high' = 'idle',
    absent = 'Not available on this machine.'
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = `monitor-reading monitor-reading--${value === null ? 'idle' : tone}`
    const name = document.createElement('span')
    name.className = 'monitor-reading__label'
    name.textContent = label
    row.appendChild(name)
    const out = document.createElement('span')
    out.className = value === null ? 'monitor-reading__value muted' : 'monitor-reading__value'
    out.textContent = value ?? 'not readable here'
    if (value === null) out.title = absent
    row.appendChild(out)
    return row
  }

  /**
   * A row of numbers that carry their own units.
   *
   * The alternative — a label column and a value column — spends a word per row
   * saying what the `%` already said, and turns three facts into three lines.
   * A label is only added where the number genuinely is ambiguous without one,
   * which in practice is `ram` and `vram`.
   *
   * The tooltip carries the long form, so nothing is actually lost by dropping
   * the labels: hovering "72%" still says "Processor busy".
   */
  private figures(
    items: Figure[],
    /**
     * `spread` pins the first left, the last right and centres the rest, which
     * suits a row that is the whole of a block. `left` starts every cell at its
     * own column, which is what makes several rows line up with each other —
     * three drives one under another read as a table only if the columns agree,
     * and centring moves a cell whenever its number changes width.
     */
    align: 'spread' | 'left' = 'spread',
    /**
     * A class that owns the column layout instead of this method.
     *
     * Two callers want it. The air table's eight readings are four to a line in
     * a narrow block and eight in a wide one, which is a question about the
     * block's width and so belongs in a container query rather than here; the
     * drive head's three want columns measured in characters and set hard
     * right, so a drive's name gets whatever they do not need. Both are things
     * a stylesheet can say and `1fr` per figure cannot.
     *
     * The inline style is what has to give way: it would beat any stylesheet
     * rule, so where a variant is named it is simply not written.
     */
    variant?: string
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'monitor-figures' + (variant ? ` ${variant}` : '')
    // One equal column per figure, so a reading is at the same place on screen
    // whatever the ones beside it happen to say. A flex row — even with
    // space-between — re-spaces everything when `4%` becomes `100%`, and a
    // number that moves as it changes is a number you cannot watch out of the
    // corner of your eye, which is the whole job of this panel.
    if (!variant) row.style.gridTemplateColumns = `repeat(${items.length}, 1fr)`

    items.forEach((item, index) => {
      const cell = document.createElement('span')
      const place =
        align === 'left' ? 'start' : index === 0 ? 'start' : index === items.length - 1 ? 'end' : 'center'
      // The series colour identifies which line on the graph this number is;
      // the tone overrides it when the reading is actually alarming, because
      // knowing *which* reading is on fire matters less than knowing one is.
      cell.className =
        `monitor-figure monitor-figure--${item.value === null ? 'idle' : item.tone} monitor-figure--${place}` +
        (item.series && item.tone === 'idle' && item.value !== null ? ` monitor-figure--${item.series}` : '')
      cell.title = item.title

      // The label comes first, where a unit does not: "ram 61%" reads as a
      // sentence and "61% ram" reads as a number that has been annotated.
      if (item.label) {
        const label = document.createElement('span')
        label.className = 'monitor-figure__label'
        label.textContent = item.label
        cell.appendChild(label)
      }

      const value = document.createElement('span')
      value.className = 'monitor-figure__value' + (item.value === null ? ' muted' : '')
      // A reading that could not be taken keeps its unit — `--°C` says what is
      // missing, where a bare dash says only that something is. Never a zero,
      // which is the rule the whole pane follows and is very plausible here.
      value.textContent = item.value ?? item.empty ?? '—'
      cell.appendChild(value)

      row.appendChild(cell)
    })
    return row
  }

  /** Several series over one trough, told apart by colour. */
  private graphs(series: SparkSeries[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'monitor-graph'
    wrap.appendChild(sparklines(series))
    return wrap
  }

  private note(text: string): HTMLElement {
    const el = document.createElement('p')
    el.className = 'monitor-note'
    el.textContent = text
    return el
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.weatherTimer) clearInterval(this.weatherTimer)
    this.weatherTimer = null
  }
}

/**
 * Which volumes sit on a drive, from the counter's own instance name.
 *
 * Windows names them `0 C:` — the device number, then every drive letter on
 * it, so a disk carrying two partitions is `1 D: E:`. That string had to be
 * parsed anyway to find the device number, and it happens to carry the
 * grouping the panel wants, which is why no second query is made for it.
 *
 * Anything that is not that shape yields nothing, which is the right answer on
 * Linux and macOS where the counter name is a device like `nvme0n1`.
 */
/**
 * What a volume is called: the letter is what you type, the label is what you
 * called it, so it goes in brackets after rather than competing with it.
 *
 * Written once because it is needed twice — the row shows it, and the measuring
 * pass sizes a column to it, and a column sized to a string other than the one
 * on screen is a column that is wrong by exactly the difference.
 */
function volumeName(disk: DiskStats): string {
  return disk.label ? `${disk.mount} (${disk.label})` : disk.mount
}

/**
 * What is left on it and how big it is, in the same two places.
 *
 * Free and total, and not used as well: the bar beside it is already drawing
 * used, and the third number costs every volume in the panel a third of the
 * line to say something two of them and a bar have said between them. Free is
 * the one that answers the question anybody is actually asking of a disk —
 * whether the thing they are about to build will fit.
 */
function volumeValue(disk: DiskStats): string {
  return `${bytes(disk.free)} free of ${bytes(disk.total)}`
}

function volumeLetters(counterName: string): string[] {
  return [...counterName.matchAll(/([A-Za-z]:)/g)].map((m) => m[1].toUpperCase())
}

/**
 * How alarmed to be about one temperature.
 *
 * A processor and a drive are not judged alike, and the difference is large: a
 * CPU at 75 °C is working, and an SSD at 75 °C is throttling itself and losing
 * endurance. Anything unclassified gets the processor's thresholds, which is
 * the more forgiving pair — a false calm beats crying wolf about a chipset
 * sensor nobody can act on.
 */
function hot(reading: TemperatureStats): 'idle' | 'warn' | 'high' {
  const [warn, high] = HEAT[reading.kind]
  if (reading.celsius >= high) return 'high'
  if (reading.celsius >= warn) return 'warn'
  return 'idle'
}

/**
 * Warn and alarm, per kind of thing, because they are nothing alike.
 *
 * A modern mobile processor is *designed* to sit at 85–95 °C under load and
 * throttles itself at around 100, so colouring it orange at 75 is crying wolf
 * at the ordinary case — which is how a warning colour comes to mean nothing.
 * A solid-state drive at those temperatures is a different story: it starts
 * throttling in the sixties and loses endurance above that, so its thresholds
 * are far lower and genuinely worth acting on.
 */
const HEAT: Record<TemperatureStats['kind'], [number, number]> = {
  cpu: [90, 98],
  gpu: [83, 92],
  disk: [55, 68],
  memory: [80, 90],
  other: [80, 95],
}

/**
 * The OS's four thermal states, said the way somebody would say them.
 *
 * Apple's own words are `nominal`, `fair`, `serious` and `critical`, and two of
 * those mean the opposite of what they look like beside a temperature: `fair`
 * reads as a middling temperature rather than as "getting warm", and `nominal`
 * reads as jargon. What the states actually describe is whether the machine has
 * started slowing itself down, so that is what they say.
 */
const THERMAL_WORDS: Record<NonNullable<SystemStats['thermalPressure']>, string> = {
  nominal: 'comfortable',
  fair: 'warm',
  serious: 'throttling',
  critical: 'throttling hard',
}

/**
 * A wind direction as a compass point.
 *
 * Sixteen points rather than degrees, because "from NNW" is a direction a
 * person can face and "from 337°" is a number they have to convert. The offset
 * of half a sector is what makes 349° round to N rather than to NNW.
 */
function compass(degrees: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return points[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16]
}

/**
 * The air quality index, in words, on whichever scale answered.
 *
 * The number alone is unreadable and — worse — looks readable: 3 is middling on
 * OpenWeatherMap's scale and excellent on the European one, and nothing about
 * either number says which you are looking at.
 */
function airWords(air: AirQuality): string {
  if (air.index === null) return 'no index'
  if (air.scale === 'owm') {
    const words = ['', 'good', 'fair', 'moderate', 'poor', 'very poor']
    return `${words[air.index] ?? 'unknown'} ${air.index}/5`
  }
  const i = air.index
  const word = i <= 20 ? 'good' : i <= 40 ? 'fair' : i <= 60 ? 'moderate' : i <= 80 ? 'poor' : 'very poor'
  return `${word} ${Math.round(i)}`
}

/**
 * Where each pollutant stops being fine, in µg/m³.
 *
 * The four numbers per row are the boundaries between the five bands every air
 * quality scale is published in — below the first is good, above the last is
 * very poor. They are the OpenWeatherMap / European Environment Agency
 * breakpoints, which is what the Rainmeter skin beside this uses and what the
 * legend on any European air map shows, so a number coloured amber here is
 * amber on the map too.
 *
 * Carbon monoxide is the odd one and the reason its numbers look wrong beside
 * the others: it is harmful at a thousand times the concentration of nitrogen
 * dioxide, so a scale that fits both would colour the whole row by whichever
 * gas happens to have larger numbers. Each gets its own.
 */
const AIR_LIMITS: Record<string, [number, number, number, number]> = {
  'pm2.5': [15, 30, 55, 110],
  pm10: [25, 50, 90, 180],
  o3: [60, 120, 180, 240],
  no2: [40, 80, 180, 280],
  so2: [35, 75, 185, 304],
  co: [2345, 5155, 10883, 14320],
  nh3: [6, 12, 35, 55],
}

/** One pollutant, coloured against its own limits. */
function gasFigure(name: string, value: number | null, decimals: number, title: string): Figure {
  const limits = AIR_LIMITS[name]
  return {
    value: value === null ? null : value.toFixed(decimals),
    empty: '--',
    label: name,
    tone: value === null ? 'idle' : airTone(value, limits),
    // The limit it is being judged against, spelled out. A colour says "this is
    // high" and only the number says how high, or how close to turning.
    title: `${title}. Good below ${limits[0]}, very poor above ${limits[3]}.`,
  }
}

/** Which of the five bands a value falls in. */
function airTone(value: number, [fair, mid, poor, bad]: [number, number, number, number]): Tone {
  if (value >= bad) return 'high'
  if (value >= poor) return 'warn'
  if (value >= mid) return 'mid'
  if (value >= fair) return 'fair'
  return 'good'
}

/**
 * The index's own colour, on whichever scale answered.
 *
 * The two do not share a range — OpenWeatherMap counts 1 to 5 and Europe counts
 * 0 to past 100 — so they cannot share a threshold table either. Both are five
 * bands, which is what makes one set of colours right for both.
 */
function airIndexTone(air: AirQuality): Tone {
  if (air.index === null) return 'idle'
  if (air.scale === 'owm') {
    return (['good', 'good', 'fair', 'mid', 'warn', 'high'] as const)[Math.round(air.index)] ?? 'idle'
  }
  return airTone(air.index, [20, 40, 60, 80])
}
