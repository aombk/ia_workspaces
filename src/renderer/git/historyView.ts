/**
 * Every save in this project, and the lines they sit on.
 *
 * The changes view answers "what is different right now". This answers the
 * other question — "what has happened, and where am I in it" — and it answers
 * it as a picture, because the shape of a project's history is the one thing
 * about git that a paragraph cannot convey and a drawing can. Lines that run
 * side by side are work happening in parallel; a line that splits is somebody
 * starting from where you were; two lines meeting is that work coming back.
 * Nobody has to be told that. It is the same picture in every git client, and
 * it is the reason they all draw it.
 *
 * What is different here is the words. Every git term on screen carries its
 * plain meaning, either in brackets beside it or one hover away, and the rows
 * that exist only on this machine say so in as many words — because "have I
 * actually sent this" is the question people get wrong about git more than any
 * other, and no client answers it out loud.
 *
 * Read-mostly. It can go to a branch, start one, put a name on a save and undo
 * one *by making a new save that puts it back* — which is the only kind of undo
 * that is safe on work other people already have. It cannot delete a branch,
 * rewrite a save or reset anything: see `src/main/git.ts` for why that line is
 * where it is.
 */
import { backend } from '../../backend'
import { layoutGraph, graphWidth, type GraphRow } from '../../shared/gitGraph'
import { commitWebUrl, hostLabel } from '../../shared/gitHosts'
import type { Branch, ChangedFile, Commit, HistoryFilter } from '../../shared/types'
import { confirmDialog, promptDialog } from '../ui/confirm'
import { explain, gitButton } from '../ui/gitWord'
import { showToast } from '../ui/toast'
import { ago, patchElement, splitResizer } from './common'
import type { RepoSnapshot } from './repoWatch'
import type { GitContext, GitView } from './view'

/** Saves fetched. Past this the picture is scrolling, not reading. */
const PAGE = 400
/** One row of the picture, in pixels. */
const ROW_H = 28
/** How far apart the columns of the picture sit. */
const LANE_W = 15
const DOT_R = 3.6
/** Columns drawn before the picture is cut off and the rest is text only. */
const MAX_LANES = 12

export class HistoryView implements GitView {
  readonly element: HTMLDivElement
  private readonly searchEl: HTMLDivElement
  private readonly branchEl: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly detailEl: HTMLDivElement
  private readonly textInput: HTMLInputElement
  private readonly authorInput: HTMLInputElement
  private readonly contentInput: HTMLInputElement
  private readonly filterNote: HTMLDivElement

  private snapshot: RepoSnapshot | null = null
  private commits: Commit[] = []
  private rows: GraphRow[] = []
  private branches: Branch[] = []
  private selected: string | null = null
  private limit = PAGE
  private filter: HistoryFilter = {}
  private disposed = false
  /** True once this view has been looked at, so it never fetches unseen. */
  private awake = false
  /** What the last fetch was for, so an unchanged one is not repeated. */
  private fetchedFor = ''
  private detailToken = 0
  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly ctx: GitContext) {
    this.element = document.createElement('div')
    this.element.className = 'history-view'

    this.searchEl = document.createElement('div')
    this.searchEl.className = 'history-search'
    this.element.appendChild(this.searchEl)

    // Three boxes rather than one, because they are three different questions
    // and git answers them with three different flags. The third is the one
    // nobody finds and everybody wants: "when did this line of code appear",
    // which no amount of reading save messages will ever answer.
    this.textInput = this.searchBox('Words in the message', 'what the save says it did')
    this.authorInput = this.searchBox('Who saved it', 'a name or an email')
    this.contentInput = this.searchBox('Code that appeared or vanished', 'text from a file, not a message')

    this.filterNote = document.createElement('div')
    this.filterNote.className = 'history-filter-note'
    this.filterNote.hidden = true
    this.element.appendChild(this.filterNote)

    this.branchEl = document.createElement('div')
    this.branchEl.className = 'history-branches'
    this.element.appendChild(this.branchEl)

    const split = document.createElement('div')
    split.className = 'diff-split history-split'

    this.listEl = document.createElement('div')
    this.listEl.className = 'history-list'
    split.appendChild(this.listEl)

    split.appendChild(splitResizer(this.listEl, 'history'))

    this.detailEl = document.createElement('div')
    this.detailEl.className = 'history-detail'
    split.appendChild(this.detailEl)

    this.element.appendChild(split)

    const note = document.createElement('div')
    note.className = 'diff-empty'
    note.textContent = 'Reading the list of saves…'
    this.listEl.replaceChildren(note)
  }

  private searchBox(label: string, placeholder: string): HTMLInputElement {
    const wrap = document.createElement('label')
    wrap.className = 'history-search__field'

    const caption = document.createElement('span')
    caption.textContent = label
    wrap.appendChild(caption)

    const input = document.createElement('input')
    input.className = 'text-input'
    input.spellcheck = false
    input.placeholder = placeholder
    // Debounced, because every keystroke would otherwise be a `git log` over
    // the whole project — the same mistake the two panes' timers were making,
    // at typing speed.
    input.addEventListener('input', () => {
      if (this.searchTimer) clearTimeout(this.searchTimer)
      this.searchTimer = setTimeout(() => this.applySearch(), 300)
    })
    wrap.appendChild(input)

    this.searchEl.appendChild(wrap)
    return input
  }

  private applySearch(): void {
    this.filter = {
      ...this.filter,
      text: this.textInput.value.trim() || undefined,
      author: this.authorInput.value.trim() || undefined,
      content: this.contentInput.value.trim() || undefined,
    }
    this.limit = PAGE
    void this.fetch(true)
  }

  /** Set from the changes view: only the saves that touched one file. */
  filterByFile(repoPath: string): void {
    this.filter = { ...this.filter, path: repoPath }
    this.limit = PAGE
    void this.fetch(true)
  }

  activate(): void {
    this.awake = true
    void this.fetch(false)
  }

  update(snapshot: RepoSnapshot | null): void {
    // See the same guard in the changes view: before the first answer arrives,
    // the placeholder is the only honest thing to show.
    if (!snapshot) return
    this.snapshot = snapshot

    if (!snapshot.status.root) {
      this.commits = []
      const note = document.createElement('div')
      note.className = 'diff-empty'
      note.textContent =
        'This folder is not part of a project git is watching, so there are no saves to show.'
      this.listEl.replaceChildren(note)
      return
    }
    void this.fetch(false)
  }

  /**
   * Fetches the list, when there is a reason to.
   *
   * The picture costs more than the status does, and it only changes when a
   * save is made, a branch moves, or the filter does — so the key carries all
   * three and an unchanged key costs nothing. This is why the History half can
   * sit behind the Changes half without costing anything at all: unseen, it is
   * never awake, and it never asks.
   */
  private async fetch(force: boolean): Promise<void> {
    const status = this.snapshot?.status
    if (!this.awake || this.disposed || !status?.root) return

    const key = [
      status.root,
      status.headFull,
      status.branch,
      this.limit,
      this.filter.text,
      this.filter.author,
      this.filter.content,
      this.filter.path,
      this.branchStamp(status.unsent.length),
    ].join('|')
    if (!force && key === this.fetchedFor) {
      // Still redraw: `unsent` and the branch chips come from the status, and
      // a push changes those without changing a single save.
      this.render()
      return
    }
    this.fetchedFor = key

    try {
      const [commits, branches] = await Promise.all([
        backend().git.history(this.ctx.root(), this.limit, this.hasFilter() ? this.filter : undefined),
        backend().git.branches(this.ctx.root()),
      ])
      if (this.disposed) return
      this.commits = commits
      this.branches = branches
      // A filtered list is a handful of saves plucked out of the middle of the
      // project, and the lines joining them are not there — so the picture is
      // only laid out when it would be telling the truth.
      this.rows = this.hasFilter() ? [] : layoutGraph(commits)
    } catch {
      /* leave the last good picture up rather than blanking it */
      return
    }
    this.render()
  }

  private branchStamp(unsent: number): string {
    return `${unsent}:${this.branches.map((b) => `${b.name}${b.head}`).join(',')}`
  }

  private hasFilter(): boolean {
    return !!(this.filter.text || this.filter.author || this.filter.content || this.filter.path)
  }

  // ------------------------------------------------------------------ draw

  private render(): void {
    this.renderFilterNote()
    this.renderBranches()
    this.renderList()
    void this.renderDetail()
  }

  private renderFilterNote(): void {
    this.filterNote.replaceChildren()
    if (!this.hasFilter()) {
      this.filterNote.hidden = true
      return
    }
    this.filterNote.hidden = false

    const parts: string[] = []
    if (this.filter.path) parts.push(`only saves that touched ${this.filter.path}`)
    if (this.filter.text) parts.push(`message mentioning “${this.filter.text}”`)
    if (this.filter.author) parts.push(`saved by “${this.filter.author}”`)
    if (this.filter.content) parts.push(`where “${this.filter.content}” appeared or vanished`)

    const label = document.createElement('span')
    label.textContent = `Showing ${this.commits.length} save${this.commits.length === 1 ? '' : 's'}: ${parts.join(', ')}. The picture is hidden while the list is narrowed — the lines between these saves are not all here.`
    this.filterNote.appendChild(label)

    const clear = document.createElement('button')
    clear.className = 'history-link'
    clear.textContent = 'Show everything again'
    clear.addEventListener('click', () => {
      this.filter = {}
      this.textInput.value = ''
      this.authorInput.value = ''
      this.contentInput.value = ''
      this.limit = PAGE
      void this.fetch(true)
    })
    this.filterNote.appendChild(clear)
  }

  private renderBranches(): void {
    this.branchEl.replaceChildren()
    if (!this.branches.length) return

    const label = document.createElement('span')
    label.className = 'history-branches__label'
    label.textContent = 'lines of saves (branches):'
    explain(label, 'branch')
    this.branchEl.appendChild(label)

    for (const branch of this.branches) {
      const chip = document.createElement('button')
      chip.className =
        'history-branch' + (branch.current ? ' current' : '') + (branch.remote ? ' remote' : '')

      const name = document.createElement('span')
      name.textContent = branch.name
      chip.appendChild(name)

      if (branch.ahead || branch.behind) {
        const counts = document.createElement('span')
        counts.className = 'history-branch__counts'
        counts.textContent =
          (branch.ahead ? `↑${branch.ahead}` : '') + (branch.behind ? `↓${branch.behind}` : '')
        chip.appendChild(counts)
      }

      chip.title = `${branchTooltip(branch, hostLabel(this.snapshot?.remote))}\n\ngit switch ${branch.name.replace(/^[^/]+\//, '')}`
      if (branch.current) {
        chip.disabled = true
      } else if (branch.checkedOutAt) {
        // Git refuses to have one branch in two checkouts at once, and it is
        // right to: two folders sharing a line of saves is how work gets lost.
        chip.disabled = true
        chip.title = `${chip.title}\n\nAlready open in ${branch.checkedOutAt}, so you cannot go to it from here as well.`
      } else {
        chip.addEventListener('click', () => void this.goTo(branch))
      }
      this.branchEl.appendChild(chip)
    }

    const start = gitButton('start a new line of saves', 'git switch -c', { className: 'history-branch new' })
    explain(start, 'branch')
    start.addEventListener('click', () => void this.startBranch())
    this.branchEl.appendChild(start)
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    if (!this.commits.length) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent = this.hasFilter()
        ? 'No saves match what you are looking for.'
        : 'No saves yet. Once you pick some files and save them in Changes, they appear here.'
      this.listEl.appendChild(empty)
      return
    }

    const unsent = new Set(this.snapshot?.status.unsent ?? [])
    const drawing = this.rows.length > 0
    const lanes = Math.min(MAX_LANES, graphWidth(this.rows))
    const graphW = lanes * LANE_W + 8

    this.commits.forEach((commit, index) => {
      const el = document.createElement('button')
      el.className = 'history-row' + (commit.sha === this.selected ? ' active' : '')

      if (drawing) el.appendChild(drawRow(this.rows[index], lanes, graphW))

      const body = document.createElement('span')
      body.className = 'history-row__text'

      for (const ref of commit.refs) {
        const badge = document.createElement('span')
        badge.className = `history-ref history-ref--${ref.kind}`
        badge.textContent = ref.kind === 'head' ? `you are here: ${ref.name}` : ref.name
        badge.title =
          ref.kind === 'head'
            ? 'Where you are — the save your files came from.'
            : ref.kind === 'tag'
              ? 'A sticker (tag) on this save, so it can be found by name instead of by its number.'
              : ref.kind === 'remote'
                ? `The copy online has a line of saves pointing at this save.`
                : 'A line of saves (branch) here points at this save.'
        body.appendChild(badge)
      }

      const subject = document.createElement('span')
      subject.className = 'history-row__subject'
      subject.textContent = commit.subject || '(no message)'
      body.appendChild(subject)
      el.appendChild(body)

      if (unsent.has(commit.sha)) {
        const mark = document.createElement('span')
        mark.className = 'history-unsent'
        mark.textContent = 'this machine only'
        mark.title =
          'This save is not on the copy online. It exists on this disk and nowhere else, until you send (push) it.'
        el.appendChild(mark)
      }

      const meta = document.createElement('span')
      meta.className = 'history-row__meta'
      meta.textContent = `${commit.author} · ${ago(commit.at)}`
      meta.title = new Date(commit.at).toLocaleString()
      el.appendChild(meta)

      const sha = document.createElement('span')
      sha.className = 'history-row__sha'
      sha.textContent = commit.short
      sha.title = `${commit.sha}\n\nThe save's number (hash) — the name git gives this one save.`
      el.appendChild(sha)

      el.addEventListener('click', () => {
        this.selected = commit.sha
        this.renderList()
        void this.renderDetail()
      })
      this.listEl.appendChild(el)
    })

    // Only offered when the list is full, which is the only time there might be
    // more. A button that fetches nothing is a button that looks broken.
    if (this.commits.length >= this.limit) {
      const more = document.createElement('button')
      more.className = 'history-more'
      more.textContent = `Show ${PAGE} more`
      more.addEventListener('click', () => {
        this.limit += PAGE
        void this.fetch(true)
      })
      this.listEl.appendChild(more)
    }
  }

  private async renderDetail(): Promise<void> {
    const token = ++this.detailToken
    const commit = this.commits.find((c) => c.sha === this.selected)
    this.detailEl.replaceChildren()

    if (!commit) {
      const hint = document.createElement('div')
      hint.className = 'diff-empty'
      hint.textContent =
        'Pick a save on the left to see what changed in it. Each dot is one save; the lines joining them are the order they were made in.'
      this.detailEl.appendChild(hint)
      return
    }

    this.detailEl.appendChild(this.detailHead(commit))

    let files: ChangedFile[]
    let patch: string
    try {
      ;[files, patch] = await Promise.all([
        backend().git.commitFiles(this.ctx.root(), commit.sha),
        backend().git.commitDiff(this.ctx.root(), commit.sha),
      ])
    } catch {
      return
    }
    if (token !== this.detailToken || this.disposed) return

    const count = document.createElement('div')
    count.className = 'history-detail__files'
    count.textContent = files.length
      ? `${files.length} file${files.length === 1 ? '' : 's'} changed in this save`
      : 'No files changed in this save'
    this.detailEl.appendChild(count)

    // Each name narrows the list to that file's own past, which is the natural
    // next question once you are looking at one save that touched it.
    const names = document.createElement('div')
    names.className = 'history-detail__filelist'
    for (const file of files) {
      const link = document.createElement('button')
      link.className = 'history-link'
      link.textContent = file.repoPath
      link.title = `Every save that touched ${file.repoPath}.`
      link.addEventListener('click', () => this.filterByFile(file.repoPath))
      names.appendChild(link)
    }
    this.detailEl.appendChild(names)

    this.detailEl.appendChild(patchElement(patch))
  }

  private detailHead(commit: Commit): HTMLElement {
    const head = document.createElement('div')
    head.className = 'history-detail__head'

    const subject = document.createElement('div')
    subject.className = 'history-detail__subject'
    subject.textContent = commit.subject || '(no message)'
    head.appendChild(subject)

    const who = document.createElement('div')
    who.className = 'history-detail__who'
    who.textContent = `Saved by ${commit.author} (${commit.email}) — ${new Date(commit.at).toLocaleString()}`
    head.appendChild(who)

    const facts = document.createElement('div')
    facts.className = 'history-detail__facts'

    const number = document.createElement('code')
    number.textContent = commit.short
    number.title = commit.sha
    facts.appendChild(number)

    if (commit.parents.length > 1) {
      const merge = document.createElement('span')
      merge.textContent = 'two lines of saves meet here (a merge commit)'
      facts.appendChild(merge)
    } else if (commit.parents.length === 0) {
      const first = document.createElement('span')
      first.textContent = 'the very first save in this project'
      facts.appendChild(first)
    }
    if ((this.snapshot?.status.unsent ?? []).includes(commit.sha)) {
      const unsent = document.createElement('span')
      unsent.className = 'history-unsent'
      unsent.textContent = 'not sent (pushed) yet'
      facts.appendChild(unsent)
    }
    head.appendChild(facts)

    if (commit.body) {
      const body = document.createElement('pre')
      body.className = 'history-detail__body'
      body.textContent = commit.body
      head.appendChild(body)
    }

    head.appendChild(this.commitActions(commit))
    return head
  }

  /**
   * What can be done to one save.
   *
   * "Undo" here is `git revert`, which does not remove the save — it writes a
   * new one whose content is the old one turned around. That is the whole
   * reason it is offered on any save at any age while the changes view's undo
   * is offered on exactly one: reverting adds to the record and rewriting
   * replaces it, and only the first is safe once somebody else has a copy.
   */
  private commitActions(commit: Commit): HTMLElement {
    const row = document.createElement('div')
    row.className = 'history-detail__actions'

    const copy = document.createElement('button')
    copy.className = 'diff-btn'
    copy.textContent = 'Copy its number'
    copy.title = `${commit.sha}\n\nThe name git gives this one save, in full.`
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(commit.sha)
      showToast('Copied', 'The save\'s number is on the clipboard.')
    })
    row.appendChild(copy)

    // Always drawn, greyed when there is nowhere to open. It used to exist only
    // when the project had a web remote, so the two buttons after it sat in one
    // place on a project with a GitHub copy and 130px to the left on one without
    // — including on the same project, in the second before the first fetch came
    // back. A save that has not been sent is likewise disabled rather than
    // dropped: a link that 404s reads as the app being wrong rather than as the
    // save being unsent, which is a thing the row beside it already says.
    const web = commitWebUrl(this.snapshot?.remote, commit.sha)
    const unsent = (this.snapshot?.status.unsent ?? []).includes(commit.sha)
    const open = document.createElement('button')
    open.className = 'diff-btn'
    open.textContent = `Open on ${hostLabel(this.snapshot?.remote)}`
    open.disabled = !web || unsent
    open.title = !web
      ? 'This project has no copy online to open this save on.'
      : unsent
        ? 'This save has not been sent yet, so there is nothing there to open.'
        : web
    if (web) open.addEventListener('click', () => void backend().openExternal(web))
    row.appendChild(open)

    const tag = gitButton('put a name on this save', 'git tag', { className: 'diff-btn' })
    tag.disabled = this.ctx.busy()
    tag.addEventListener('click', () => void this.tag(commit))
    row.appendChild(tag)

    const revert = gitButton('undo what this save did', 'git revert', { className: 'diff-btn' })
    revert.title =
      'Makes a new save that puts this one back the way it was. The save itself stays in the list — nothing is rewritten.'
    revert.disabled = this.ctx.busy() || !!this.snapshot?.status.inProgress
    revert.addEventListener('click', () => void this.revert(commit))
    row.appendChild(revert)

    return row
  }

  // ------------------------------------------------------------ operations

  private async goTo(branch: Branch): Promise<void> {
    const dirty = this.snapshot?.status.files.length ?? 0
    const ok = await confirmDialog({
      title: `Go to "${branch.name}"?`,
      body:
        'Your files become what they are on that line of saves (git switch — "checkout" in older git). ' +
        (dirty
          ? `You have ${dirty} changed file${dirty === 1 ? '' : 's'} that are not saved. Git will either carry them across or refuse outright — it never throws them away.`
          : 'Nothing here is unsaved, so nothing is at risk.'),
      confirmLabel: 'Go there',
    })
    if (!ok) return
    await this.ctx.run(
      () => backend().git.goTo(this.ctx.root(), branch.name),
      `You are now on ${branch.name.replace(/^[^/]+\//, '')}.`,
      `Going to ${branch.name}`
    )
  }

  private async startBranch(): Promise<void> {
    const name = await promptDialog({
      title: 'Start a new line of saves',
      body:
        'A branch is just a name marking the newest save in a line of them. Starting one changes nothing about your files — ' +
        'it means the saves you make from now on go on their own line, leaving the one you are on as it is.',
      placeholder: 'what-you-are-working-on',
      confirmLabel: 'Start it',
    })
    if (!name) return
    await this.ctx.run(
      () => backend().git.startBranch(this.ctx.root(), name),
      `You are now on ${name}.`,
      `Starting ${name}`
    )
  }

  private async tag(commit: Commit): Promise<void> {
    const name = await promptDialog({
      title: 'Put a name on this save',
      body:
        `A tag is a sticker on one save, so it can be found by a name instead of by its number (${commit.short}). ` +
        'Nothing about the save changes, and nothing else moves. Sending it to the copy online is a separate step.',
      placeholder: 'v1.0',
      confirmLabel: 'Name it',
    })
    if (!name) return
    await this.ctx.run(
      () => backend().git.tag(this.ctx.root(), commit.sha, name),
      `That save is now called ${name}. It is on this machine only until you send it.`,
      `Naming it ${name}`
    )
  }

  private async revert(commit: Commit): Promise<void> {
    const ok = await confirmDialog({
      title: `Undo what "${commit.subject || commit.short}" did?`,
      body:
        'This makes a *new* save that puts those changes back the way they were. The save you picked stays exactly where it is in the list — ' +
        'nothing is deleted and nothing is rewritten, which is why this is safe even on a save other people already have. ' +
        'If the code has moved on since, git will stop and ask which version wins.',
      confirmLabel: 'Make the undo save',
    })
    if (!ok) return
    await this.ctx.run(
      () => backend().git.revert(this.ctx.root(), commit.sha),
      'Done — a new save putting that one back is at the top of the list.',
      'Making the undo save'
    )
  }

  dispose(): void {
    this.disposed = true
    if (this.searchTimer) clearTimeout(this.searchTimer)
  }
}

// ---------------------------------------------------------------- drawing

const NS = 'http://www.w3.org/2000/svg'

/** Where a column's line sits, across the row. */
function x(lane: number): number {
  return lane * LANE_W + LANE_W / 2
}

/**
 * One row of the picture, as an `<svg>`.
 *
 * Per row rather than one drawing for the whole list, because the list is a
 * list: rows are added, removed and re-ordered as saves arrive, and a single
 * drawing would have to be recomputed and repainted in full every time one did.
 * A row owning its own few lines means a new save costs one row.
 *
 * Colour comes from CSS classes rather than attributes so the picture follows
 * the theme like everything else.
 */
function drawRow(row: GraphRow | undefined, lanes: number, width: number): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'history-graph')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(ROW_H))
  svg.setAttribute('viewBox', `0 0 ${width} ${ROW_H}`)
  if (!row) return svg

  const mid = ROW_H / 2
  const visible = (lane: number) => lane < lanes

  const line = (d: string, lane: number) => {
    const p = document.createElementNS(NS, 'path')
    p.setAttribute('d', d)
    p.setAttribute('class', `history-line lane-${lane % 8}`)
    svg.appendChild(p)
  }

  // Lines passing this row untouched — other work, going on beside this save.
  for (const lane of row.through) {
    if (!visible(lane)) continue
    line(`M ${x(lane)} 0 L ${x(lane)} ${ROW_H}`, lane)
  }

  // Coming in from above: the saves that were made after this one.
  for (const lane of row.in) {
    if (!visible(lane)) continue
    if (lane === row.lane) line(`M ${x(lane)} 0 L ${x(lane)} ${mid}`, lane)
    else line(`M ${x(lane)} 0 C ${x(lane)} ${mid * 0.7}, ${x(row.lane)} ${mid * 0.3}, ${x(row.lane)} ${mid}`, lane)
  }

  // Going out below: the saves this one came from. More than one is a join-up
  // save (merge commit), which is exactly where the picture forks going down.
  for (const lane of row.out) {
    if (!visible(lane)) continue
    if (lane === row.lane) line(`M ${x(lane)} ${mid} L ${x(lane)} ${ROW_H}`, lane)
    else
      line(
        `M ${x(row.lane)} ${mid} C ${x(row.lane)} ${mid + mid * 0.3}, ${x(lane)} ${mid + mid * 0.7}, ${x(lane)} ${ROW_H}`,
        lane
      )
  }

  if (visible(row.lane)) {
    const dot = document.createElementNS(NS, 'circle')
    dot.setAttribute('cx', String(x(row.lane)))
    dot.setAttribute('cy', String(mid))
    dot.setAttribute('r', String(row.out.length > 1 ? DOT_R + 1.2 : DOT_R))
    dot.setAttribute('class', `history-dot lane-${row.lane % 8}`)
    svg.appendChild(dot)
  } else {
    // Past the columns we draw. Saying so beats drawing the dot in the wrong
    // place, which would put this save on somebody else's line.
    const more = document.createElementNS(NS, 'text')
    more.setAttribute('x', String(width - 4))
    more.setAttribute('y', String(mid + 3))
    more.setAttribute('text-anchor', 'end')
    more.setAttribute('class', 'history-overflow')
    more.textContent = '»'
    svg.appendChild(more)
  }

  return svg
}

function branchTooltip(branch: Branch, where: string): string {
  const bits: string[] = []
  bits.push(
    branch.remote
      ? `${branch.name} — ${where}'s copy of a line of saves (a remote branch).`
      : `${branch.name} — a line of saves (branch) on this machine.`
  )
  if (branch.current) bits.push('This is the one you are on.')
  if (branch.upstream) bits.push(`Paired with ${branch.upstream}.`)
  if (branch.ahead) bits.push(`${branch.ahead} save(s) here that ${where} has not got.`)
  if (branch.behind) bits.push(`${branch.behind} save(s) on ${where} that this one has not got.`)
  if (branch.subject) bits.push(`Newest save: ${branch.subject}`)
  if (branch.at) bits.push(`Last touched ${ago(branch.at)}.`)
  return bits.join('\n')
}
