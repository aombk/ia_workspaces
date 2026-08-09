/**
 * What this app started, and what is holding a port.
 *
 * Scoped to processes descending from our own panes rather than the whole
 * machine, because the question is never "what is running on this computer" —
 * it is "I closed that tab, is the dev server still up, and who has 5173".
 * Task Manager already does the other one.
 *
 * Grouped by pane, so the answer comes with the place to go and deal with it.
 */
import { backend } from '../backend'
import { store, paneLabel } from './state'
import type { AuxPane } from './auxPane'
import type { ProcessInfo } from '../shared/types'

export interface PortsPaneHooks {
  /** Bring the pane that owns a process to the front. */
  jumpToPane(workspaceId: string, paneId: string): void
  /** Type a command into a pane without submitting it. */
  suggest(paneId: string, command: string): void
}

/** Enumerating processes shells out, so this is deliberately unhurried. */
const POLL_MS = 4000

export class PortsPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly status: HTMLSpanElement
  private readonly list: HTMLDivElement
  private signature = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  constructor(
    readonly paneId: string,
    private readonly hooks: PortsPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'ports-pane'

    const head = document.createElement('div')
    head.className = 'ports-head'
    const title = document.createElement('span')
    title.className = 'ports-title'
    title.textContent = 'Running here'
    head.appendChild(title)
    this.status = document.createElement('span')
    this.status.className = 'ports-status'
    head.appendChild(this.status)
    this.element.appendChild(head)

    this.list = document.createElement('div')
    this.list.className = 'ports-list'
    this.element.appendChild(this.list)

    this.status.textContent = 'Looking…'
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), POLL_MS)
  }

  private async refresh(): Promise<void> {
    if (this.disposed || document.hidden) return
    let rows: ProcessInfo[]
    try {
      rows = await backend().processes()
    } catch (err) {
      if (this.disposed) return
      this.status.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    if (this.disposed) return

    const signature = rows
      .map((r) => `${r.paneId}|${r.pid}|${r.name}|${r.ports.join(',')}`)
      .join('\n')
    if (signature === this.signature) return
    this.signature = signature
    this.render(rows)
  }

  private render(rows: ProcessInfo[]): void {
    const listening = rows.filter((r) => r.ports.length).length
    this.status.textContent = rows.length
      ? `${rows.length} process${rows.length === 1 ? '' : 'es'}${listening ? `, ${listening} listening` : ''}`
      : ''

    this.list.replaceChildren()
    if (!rows.length) {
      const empty = document.createElement('div')
      empty.className = 'ports-empty'
      empty.textContent = 'Nothing running under any pane right now.'
      this.list.appendChild(empty)
      return
    }

    const byPane = new Map<string, ProcessInfo[]>()
    for (const row of rows) {
      const bucket = byPane.get(row.paneId)
      if (bucket) bucket.push(row)
      else byPane.set(row.paneId, [row])
    }

    for (const [paneId, group] of byPane) {
      const pane = store.pane(paneId)
      const workspace = store.workspaceOfPane(paneId)
      // A pane that has gone since the probe ran has nothing to jump to.
      if (!pane || !workspace) continue

      const header = document.createElement('button')
      header.className = 'ports-pane-row'
      header.style.setProperty('--workspace-color', workspace.color)
      const dot = document.createElement('span')
      dot.className = 'ports-dot'
      header.appendChild(dot)
      const name = document.createElement('span')
      name.className = 'ports-pane-name'
      name.textContent = `${workspace.name} · ${paneLabel(pane)}`
      header.appendChild(name)
      header.addEventListener('click', () => this.hooks.jumpToPane(workspace.id, paneId))
      this.list.appendChild(header)

      for (const row of group) this.list.appendChild(this.processRow(row, paneId))
    }
  }

  private processRow(row: ProcessInfo, paneId: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ports-row'
    // Depth is capped so a deep tree cannot indent itself off the pane.
    el.style.paddingLeft = `${20 + Math.min(row.depth, 4) * 12}px`
    el.title = row.commandLine || row.name

    const name = document.createElement('span')
    name.className = 'ports-name'
    name.textContent = row.name
    el.appendChild(name)

    const pid = document.createElement('span')
    pid.className = 'ports-pid'
    pid.textContent = String(row.pid)
    el.appendChild(pid)

    for (const port of row.ports) {
      const chip = document.createElement('span')
      chip.className = 'ports-port'
      chip.textContent = String(port)
      chip.title = `Listening on ${port}`
      el.appendChild(chip)
    }

    const stop = document.createElement('button')
    stop.className = 'ports-stop'
    stop.textContent = 'Stop'
    // Typed, not run. Ending someone else's process is not something to do on
    // one click from a list that refreshes itself — the line goes to the prompt
    // and you press Enter.
    stop.title = `Put "taskkill /PID ${row.pid} /T /F" on the prompt`
    stop.addEventListener('click', () =>
      this.hooks.suggest(paneId, `taskkill /PID ${row.pid} /T /F`)
    )
    el.appendChild(stop)

    return el
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
