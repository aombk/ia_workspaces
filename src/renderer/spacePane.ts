/**
 * How much room this project takes, and getting some of it back.
 *
 * Three levels, matching how a project is actually left:
 *
 * - **Compress** for one you are resting — weeks away, coming back. Smaller on
 *   disk, nothing to reinstall or rebuild, opens instantly.
 * - **Clean** the folders a tool puts back, for one you will not build for a
 *   while. Costs the install and the first build when you return.
 * - **Park** is both: clean, then compress what is left.
 *
 * And the history, which on an old fork can be most of the folder. Compacting
 * it is lossless. Keeping only recent commits, squashing to one, or removing
 * `.git` are not — each writes a bundle of the whole history to a file you pick
 * first, and none of them pushes anything. A shortened history only reaches a
 * remote if somebody force-pushes it.
 *
 * Nothing is measured until the pane opens, and nothing is deleted without a
 * dialog that names what goes.
 */
import type { AuxPane } from './auxPane'
import { backend } from '../backend'
import { store } from './state'
import { confirmDialog, promptDialog } from './ui/confirm'
import { showToast } from './ui/toast'
import { ago } from './git/common'
import { formatSize } from '../shared/gitSize'
import { MAX_KEPT_COMMITS } from '../shared/space'
import { measureSpace, spaceSizeOf, watchSpaceSizes } from './spaceSizes'
import type { SpaceCompressor, SpaceGitInfo, SpaceReport, SpaceResult } from '../shared/types'

export interface SpacePaneHooks {
  /** Opens the space pane of another workspace, for the all-projects list. */
  openSpace(workspaceId: string): void
}

export class SpacePane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly body: HTMLDivElement
  private report: SpaceReport | null = null
  private git: SpaceGitInfo | null = null
  private compressor: SpaceCompressor = 'unsupported'
  /** What is running, said in words, or null. */
  private busy: string | null = null
  /** Regenerable folders the user has unticked, by path. Ticks follow the suggestion otherwise. */
  private readonly unticked = new Set<string>()
  private readonly ticked = new Set<string>()
  private measuringAll = false
  private shownCwd = ''
  private disposed = false
  private readonly unwatch: () => void

  constructor(
    readonly paneId: string,
    private readonly workspaceId: string,
    private readonly hooks: SpacePaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'space-pane'

    const about = document.createElement('div')
    about.className = 'pane-about'
    about.textContent =
      'How much room this project takes, and getting it back. Compressing changes nothing you can see; ' +
      'cleaning deletes only what a tool puts back; nothing here pushes to a remote.'
    this.element.appendChild(about)

    this.body = document.createElement('div')
    this.body.className = 'space-body'
    this.element.appendChild(this.body)

    // The all-projects list fills in as other panes measure.
    this.unwatch = watchSpaceSizes(() => this.render())
    void backend()
      .space.compressor()
      .then((c) => {
        this.compressor = c
        this.render()
      })
      .catch(() => {})
    this.render()
    void this.refresh()
  }

  private get workspace() {
    return store.workspaces.find((w) => w.id === this.workspaceId)
  }

  /** The workspace's folder can move under this pane. */
  sync(): void {
    const cwd = this.workspace?.cwd ?? ''
    if (cwd !== this.shownCwd) void this.refresh()
  }

  dispose(): void {
    this.disposed = true
    this.unwatch()
  }

  private async refresh(): Promise<void> {
    const cwd = this.workspace?.cwd
    if (!cwd) return
    this.shownCwd = cwd
    this.report = spaceSizeOf(cwd) ?? null
    this.busy = 'measuring…'
    this.render()
    try {
      const [report, git] = await Promise.all([measureSpace(cwd), backend().space.gitInfo(cwd)])
      if (this.disposed || cwd !== this.shownCwd) return
      this.report = report
      this.git = git
    } catch (err) {
      showToast('Could not measure this folder', (err as Error).message)
    } finally {
      this.busy = null
      this.render()
    }
  }

  /** Runs one operation, says what it freed, and measures again. */
  private async run(what: string, op: () => Promise<SpaceResult>): Promise<void> {
    if (this.busy) return
    this.busy = what
    this.render()
    let result: SpaceResult
    try {
      result = await op()
    } catch (err) {
      result = { ok: false, error: (err as Error).message }
    }
    this.busy = null
    const freed = result.freedBytes ? `Freed ${formatSize(result.freedBytes)}.` : ''
    if (result.ok) showToast(`${what.replace(/…$/, '')} done`, freed || 'Nothing was freed.')
    else showToast(`${what.replace(/…$/, '')} stopped`, [result.error, freed].filter(Boolean).join(' '))
    this.ticked.clear()
    this.unticked.clear()
    await this.refresh()
  }

  private isTicked(path: string, suggested: boolean): boolean {
    return this.ticked.has(path) || (suggested && !this.unticked.has(path))
  }

  private chosen(): { paths: string[]; bytes: number } {
    const rows = (this.report?.regenerables ?? []).filter((r) => !r.kept && this.isTicked(r.path, r.suggested))
    return { paths: rows.map((r) => r.path), bytes: rows.reduce((s, r) => s + r.bytes, 0) }
  }

  // ---------------------------------------------------------------- drawing

  private render(): void {
    if (this.disposed) return
    const workspace = this.workspace
    const scroll = this.body.scrollTop
    this.body.replaceChildren()
    if (!workspace) {
      this.body.appendChild(note('This workspace is gone.'))
      return
    }
    this.body.append(this.folderCard(workspace.name), this.regenerableCard(), this.gitCard(), this.allCard())
    this.body.scrollTop = scroll
  }

  private folderCard(name: string): HTMLElement {
    const card = section('this project', this.report?.dir ?? this.workspace?.cwd ?? '')
    const r = this.report
    if (r?.error) {
      card.appendChild(note(r.error))
      return card
    }

    const big = document.createElement('div')
    big.className = 'space-total'
    big.textContent = r ? formatSize(r.bytes) : '…'
    card.appendChild(big)

    if (r) {
      const pair = document.createElement('div')
      pair.className = 'space-total__pair'
      const saved = r.apparentBytes - r.bytes
      pair.textContent = compressed(r.bytes, r.apparentBytes)
        ? `on disk · ${formatSize(r.apparentBytes)} uncompressed — ${formatSize(saved)} (${Math.round((saved / r.apparentBytes) * 100)}%) saved by compression`
        : `on disk · ${formatSize(r.apparentBytes)} uncompressed — not compressed`
      card.appendChild(pair)

      const regen = r.regenerables.reduce((s, x) => s + x.bytes, 0)
      const facts = [
        `${r.files.toLocaleString()} files`,
        r.gitBytes ? `history ${formatSize(r.gitBytes)}` : 'no history',
        regen ? `regenerable ${formatSize(regen)}` : 'nothing regenerable',
        r.newest ? `last changed ${ago(r.newest)}` : '',
      ].filter(Boolean)
      card.appendChild(hint(facts.join(' · ')))
    }

    const row = buttons()
    row.appendChild(button(this.busy ?? 'measure again', !!this.busy, () => void this.refresh()))
    const compressNote =
      this.compressor === 'missing'
        ? 'afsctool is not installed — brew install afsctool'
        : this.compressor === 'unsupported'
          ? 'In-place compression is macOS only.'
          : 'Smaller on disk; every file reads back unchanged.'
    const compress = button('compress', !!this.busy || this.compressor !== 'ready', () => void this.compress(name))
    compress.title = compressNote
    row.appendChild(compress)
    const park = button('park', !!this.busy || !r, () => void this.park(name))
    park.title = 'Delete the ticked folders below, then compress what is left.'
    row.appendChild(park)
    card.appendChild(row)
    if (this.compressor !== 'ready') card.appendChild(hint(compressNote))
    return card
  }

  private regenerableCard(): HTMLElement {
    const card = section(
      'regenerable',
      'Folders a tool puts back. Deleting one costs the install or rebuild when you come back. ' +
        'List a path in a .devpark file in the project to keep it off this list.'
    )
    const rows = this.report?.regenerables ?? []
    if (!rows.length) {
      card.appendChild(note(this.report ? 'Nothing here is regenerable.' : '…'))
      return card
    }
    for (const r of rows) {
      const line = document.createElement('label')
      line.className = r.kept ? 'space-row space-row--kept' : 'space-row'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.disabled = r.kept || !!this.busy
      box.checked = !r.kept && this.isTicked(r.path, r.suggested)
      box.addEventListener('change', () => {
        this.ticked.delete(r.path)
        this.unticked.delete(r.path)
        if (box.checked !== r.suggested) (box.checked ? this.ticked : this.unticked).add(r.path)
        this.render()
      })
      const path = document.createElement('span')
      path.className = 'space-path'
      path.textContent = r.rel
      const what = document.createElement('span')
      what.className = 'space-what'
      what.textContent = r.kept ? 'kept by .devpark' : r.label
      const size = document.createElement('span')
      size.className = 'space-size'
      setSizes(size, r.bytes, r.apparentBytes)
      line.append(box, path, what, size)
      card.appendChild(line)
    }
    const { paths, bytes } = this.chosen()
    const row = buttons()
    row.appendChild(
      button(paths.length ? `delete ticked (${formatSize(bytes)})` : 'delete ticked', !!this.busy || !paths.length, () =>
        void this.clean()
      )
    )
    card.appendChild(row)
    return card
  }

  private gitCard(): HTMLElement {
    const card = section(
      'git history',
      'Every commit you ever made, kept in the hidden .git folder. Only "compact" keeps all of it; ' +
        'the others save the full history to a backup file you choose first.'
    )
    const g = this.git
    if (!g) {
      card.appendChild(note('…'))
      return card
    }
    if (!g.repo) {
      card.appendChild(note('This folder is not a git repository of its own.'))
      return card
    }
    card.appendChild(
      hint(
        [
          // The report's figures when there is one, since only the walk knows
          // what the history would take uncompressed.
          this.report?.gitApparentBytes !== undefined
            ? sizesText(this.report.gitBytes, this.report.gitApparentBytes)
            : formatSize(g.gitBytes),
          `${g.commits.toLocaleString()} commits`,
          g.branch ? `on ${g.branch}` : 'not on a branch',
          `${g.branches} branch${g.branches === 1 ? '' : 'es'}`,
          g.tags ? `${g.tags} tags` : '',
          g.stashes ? `${g.stashes} stashed` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      )
    )
    for (const warning of gitWarnings(g)) {
      const w = document.createElement('p')
      w.className = 'space-warning'
      w.textContent = warning
      card.appendChild(w)
    }
    const blocked = !!this.busy || g.worktrees > 0
    const row = buttons()
    row.appendChild(button('compact', !!this.busy, () => void this.compact()))
    row.appendChild(button('keep last N…', blocked || !g.branch || g.commits < 2, () => void this.trim(false)))
    row.appendChild(button('squash to one', blocked || !g.branch || g.commits < 2, () => void this.trim(true)))
    const remove = button('remove history', blocked, () => void this.removeHistory())
    remove.classList.add('space-danger')
    row.appendChild(remove)
    card.appendChild(row)
    return card
  }

  /** Every workspace's folder, biggest first: the `devpark status` view. */
  private allCard(): HTMLElement {
    const card = section('all workspaces', 'The last measured size of each workspace folder.')
    const seen = new Set<string>()
    const rows = store.workspaces
      .filter((w) => w.cwd && !seen.has(w.cwd) && seen.add(w.cwd))
      .map((w) => ({ w, r: spaceSizeOf(w.cwd) }))
      .sort((a, b) => (b.r?.bytes ?? -1) - (a.r?.bytes ?? -1))
    const table = document.createElement('div')
    table.className = 'space-table'
    for (const { w, r } of rows) {
      const line = document.createElement('button')
      line.type = 'button'
      line.className = w.id === this.workspaceId ? 'space-all space-all--here' : 'space-all'
      line.title = w.cwd
      const name = document.createElement('span')
      name.className = 'space-path'
      name.textContent = w.name
      const what = document.createElement('span')
      what.className = 'space-what'
      const regen = r ? r.regenerables.reduce((s, x) => s + (x.kept ? 0 : x.bytes), 0) : 0
      what.textContent = r
        ? [regen ? `${formatSize(regen)} regenerable` : '', r.newest ? `changed ${ago(r.newest)}` : '']
            .filter(Boolean)
            .join(' · ')
        : 'not measured'
      const size = document.createElement('span')
      size.className = 'space-size'
      if (r) setSizes(size, r.bytes, r.apparentBytes)
      else size.textContent = '—'
      line.append(name, what, size)
      line.addEventListener('click', () => this.hooks.openSpace(w.id))
      table.appendChild(line)
    }
    card.appendChild(table)
    const row = buttons()
    row.appendChild(
      button(this.measuringAll ? 'measuring all…' : 'measure all', this.measuringAll, () => void this.measureAll())
    )
    card.appendChild(row)
    return card
  }

  // ---------------------------------------------------------------- actions

  private async measureAll(): Promise<void> {
    this.measuringAll = true
    this.render()
    // One at a time: these are disk reads, and in parallel they only take turns.
    const dirs = [...new Set(store.workspaces.map((w) => w.cwd).filter(Boolean))]
    for (const dir of dirs) {
      if (this.disposed) return
      await measureSpace(dir).catch(() => {})
    }
    this.measuringAll = false
    this.render()
  }

  private async compress(name: string): Promise<void> {
    const dir = this.report?.dir
    if (!dir) return
    const ok = await confirmDialog({
      title: `Compress ${name}?`,
      body:
        'Every file is compressed in place. Nothing changes for you or your tools — the files read back ' +
        'exactly as they were — and files you edit or rebuild are simply stored uncompressed again. ' +
        'A large project takes a few minutes.',
      confirmLabel: 'Compress',
    })
    if (ok) await this.run('compressing…', () => backend().space.compress(dir))
  }

  private async clean(): Promise<void> {
    const dir = this.report?.dir
    const { paths, bytes } = this.chosen()
    if (!dir || !paths.length) return
    const ok = await confirmDialog({
      title: `Delete ${paths.length} folder${paths.length === 1 ? '' : 's'}?`,
      body:
        `${listOf(dir, paths)} — ${formatSize(bytes)}. These are put back by an install or a build, ` +
        'which is what you will need to run before working on this project again. They are deleted, not moved to the Trash.',
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) await this.run('deleting…', () => backend().space.clean(dir, paths))
  }

  private async park(name: string): Promise<void> {
    const dir = this.report?.dir
    if (!dir) return
    const { paths, bytes } = this.chosen()
    const compresses = this.compressor === 'ready'
    const ok = await confirmDialog({
      title: `Park ${name}?`,
      body:
        (paths.length
          ? `Deletes ${listOf(dir, paths)} (${formatSize(bytes)}), which an install or build puts back. `
          : 'Nothing is ticked to delete. ') +
        (compresses ? 'Then compresses everything else in place.' : 'Compression is not available here, so that is all.'),
      confirmLabel: 'Park',
      danger: paths.length > 0,
    })
    if (ok) await this.run('parking…', () => backend().space.park(dir, paths))
  }

  private async compact(): Promise<void> {
    const dir = this.report?.dir
    if (!dir) return
    const ok = await confirmDialog({
      title: 'Compact the history?',
      body:
        'Repacks .git as tightly as git can. Every commit, branch and tag is kept, and nothing changes on any ' +
        'remote. On a large repository this takes a few minutes.',
      confirmLabel: 'Compact',
    })
    if (ok) await this.run('compacting…', () => backend().space.gitCompact(dir))
  }

  private async trim(squash: boolean): Promise<void> {
    const dir = this.report?.dir
    const g = this.git
    if (!dir || !g?.branch) return
    let keep = 1
    if (!squash) {
      const answer = await promptDialog({
        title: 'Keep how many commits?',
        body: `The newest commits on ${g.branch} to keep, out of ${g.commits.toLocaleString()}. Older ones are dropped.`,
        initial: String(Math.min(100, g.commits - 1)),
        confirmLabel: 'Next',
      })
      if (!answer) return
      keep = Math.floor(Number(answer))
      if (!(keep >= 1 && keep < g.commits && keep <= MAX_KEPT_COMMITS)) {
        showToast('Not a number of commits to keep', `Between 1 and ${Math.min(g.commits - 1, MAX_KEPT_COMMITS)}.`)
        return
      }
    }
    const ok = await confirmDialog({
      title: squash ? 'Squash the whole history into one commit?' : `Keep only the last ${keep} commits?`,
      body:
        (squash
          ? `Your files stay exactly as they are, saved as a single commit on ${g.branch}. `
          : `The newest ${keep} commits on ${g.branch} stay, with their messages and dates. `) +
        `Everything else goes: ${dropped(g)}. ` +
        'You will pick a file to save the full history to first; nothing changes if that fails. ' +
        pushWarning(g),
      confirmLabel: 'Choose backup file…',
      danger: true,
    })
    if (!ok) return
    const file = await this.pickBackup()
    if (!file) return
    await this.run(squash ? 'squashing…' : 'trimming…', () => backend().space.gitTrim(dir, keep, file))
  }

  private async removeHistory(): Promise<void> {
    const dir = this.report?.dir
    const g = this.git
    if (!dir || !g) return
    const ok = await confirmDialog({
      title: 'Remove the history?',
      body:
        'Deletes the .git folder. Your files stay; the folder stops being a git repository, so there is nothing ' +
        `left to commit or push. ${g.commits ? 'You will pick a file to save the full history to first. ' : ''}` +
        'Any remote, such as GitHub, keeps everything it already has.',
      confirmLabel: g.commits ? 'Choose backup file…' : 'Remove',
      danger: true,
    })
    if (!ok) return
    const file = g.commits ? await this.pickBackup() : ''
    if (file === null) return
    await this.run('removing history…', () => backend().space.gitRemove(dir, file))
  }

  /** Where the full history goes before any of it is dropped. Null is a cancel. */
  private pickBackup(): Promise<string | null> {
    const name = (this.workspace?.name || 'project').replace(/[\\/:*?"<>|\s]+/g, '-')
    const date = new Date().toISOString().slice(0, 10)
    return backend().pickSaveFile({
      title: 'Save the full history to',
      defaultName: `${name}-history-${date}.bundle`,
      filters: [{ name: 'Git bundle', extensions: ['bundle'] }],
    })
  }
}

/** What a rewrite drops besides old commits, said as counts. */
function dropped(g: SpaceGitInfo): string {
  const parts = ['every older commit']
  if (g.branches > 1) parts.push(`${g.branches - 1} other branch${g.branches === 2 ? '' : 'es'}`)
  if (g.tags) parts.push(`${g.tags} tag${g.tags === 1 ? '' : 's'}`)
  if (g.stashes) parts.push(`${g.stashes} stash${g.stashes === 1 ? '' : 'es'}`)
  return parts.join(', ')
}

function pushWarning(g: SpaceGitInfo): string {
  const live = g.remotes.filter((r) => !r.missing)
  if (!live.length) return 'This project has no reachable remote, so nothing online is affected.'
  return (
    `Nothing changes on ${live.map((r) => r.name).join(', ')}. Afterwards a normal push there is refused, ` +
    'because the histories no longer match — only a force push would replace what the remote has.'
  )
}

function gitWarnings(g: SpaceGitInfo): string[] {
  const out: string[] = []
  if (g.worktrees) out.push(`${g.worktrees} other worktree(s) share this history, so it cannot be rewritten here.`)
  const missing = g.remotes.filter((r) => r.missing)
  if (missing.length) out.push(`The remote ${missing[0].name} points to ${missing[0].url}, which no longer exists.`)
  if (!g.remotes.length) out.push('No remote: this folder is the only copy of its history.')
  if (g.unpushed) out.push(`${g.unpushed} commit(s) are on no remote.`)
  if (g.dirty) out.push('There are uncommitted changes. Rewriting keeps them as they are.')
  if (g.error) out.push(g.error)
  return out
}

function listOf(dir: string, paths: string[]): string {
  const rels = paths.map((p) => p.slice(dir.length).replace(/^[\\/]/, ''))
  return rels.length > 4 ? `${rels.slice(0, 4).join(', ')} and ${rels.length - 4} more` : rels.join(', ')
}

function section(title: string, about: string): HTMLElement {
  const card = document.createElement('div')
  card.className = 'space-card'
  const head = document.createElement('h3')
  head.textContent = title
  card.appendChild(head)
  if (about) card.appendChild(hint(about))
  return card
}

/**
 * Whether compression is what separates the two sizes.
 *
 * Not any difference at all: a folder of small files takes more on disk than
 * its files add up to (every file fills whole blocks), and a few percent either
 * way is that rounding rather than compression.
 */
function compressed(onDisk: number, apparent: number | undefined): apparent is number {
  return apparent !== undefined && apparent - onDisk > Math.max(1024 * 1024, apparent * 0.05)
}

/** "1.2 GB" or, when compressed, "1.2 GB / 3.4 GB uncompressed". */
function sizesText(onDisk: number, apparent: number | undefined): string {
  return compressed(onDisk, apparent)
    ? `${formatSize(onDisk)} / ${formatSize(apparent)} uncompressed`
    : formatSize(onDisk)
}

/** A size cell: on disk, and uncompressed beside it when compression made a difference. */
function setSizes(el: HTMLElement, onDisk: number, apparent: number | undefined): void {
  el.replaceChildren()
  el.append(formatSize(onDisk))
  el.title = `${formatSize(onDisk)} on disk`
  if (!compressed(onDisk, apparent)) return
  const full = document.createElement('span')
  full.className = 'space-size__full'
  full.textContent = ` / ${formatSize(apparent)}`
  el.appendChild(full)
  el.title = `${formatSize(onDisk)} on disk, ${formatSize(apparent)} uncompressed`
}

function hint(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'space-hint'
  p.textContent = text
  return p
}

function note(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'space-note'
  p.textContent = text
  return p
}

function buttons(): HTMLElement {
  const row = document.createElement('div')
  row.className = 'space-buttons'
  return row
}

function button(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'btn'
  b.textContent = label
  b.disabled = disabled
  b.addEventListener('click', onClick)
  return b
}
