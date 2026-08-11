/**
 * The history pane: every save in this project, and the lines they sit on.
 *
 * The changes pane answers "what is different right now". This answers the
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
 * Read-mostly. It can go to a branch and start one, because both are reversible
 * and both are how you use the picture. It cannot delete a branch, rewrite a
 * save or reset anything: see `src/main/git.ts` for why that line is where it is.
 */
import { backend } from '../backend'
import { fallbackCwd } from '../shared/platform'
import { layoutGraph, graphWidth, type GraphRow } from '../shared/gitGraph'
import type { Branch, ChangedFile, Commit, GitResult, RepoStatus } from '../shared/types'
import { remoteHostOfPane, store } from './state'
import { classify } from './diffPane'
import { explain, gitButton, gitWordFirst, plainWord, showGlossary } from './ui/gitWord'
import { confirmDialog, promptDialog } from './ui/confirm'
import { showToast } from './ui/toast'
import type { AuxPane } from './auxPane'

/** How often the headline is re-read while the pane is visible. */
const STATUS_POLL_MS = 3000
/**
 * The picture costs more to fetch than the headline, so it is re-read every
 * third beat rather than every one. A save made in another pane shows up within
 * ten seconds, and anything this pane does itself refreshes both immediately.
 */
const HISTORY_EVERY = 3
/** Saves fetched. Past this the picture is scrolling, not reading. */
const HISTORY_LIMIT = 400

/** One row of the picture, in pixels. */
const ROW_H = 28
/** How far apart the columns of the picture sit. */
const LANE_W = 15
const DOT_R = 3.6
/** Columns drawn before the picture is cut off and the rest is text only. */
const MAX_LANES = 12

export interface HistoryPaneHooks {
  /** Opens (or jumps to) the changes pane for this workspace. */
  openChanges(workspaceId: string): void
}

export class HistoryPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly headEl: HTMLDivElement
  private readonly aboutEl: HTMLDivElement
  private readonly bandEl: HTMLDivElement
  private readonly branchEl: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly detailEl: HTMLDivElement

  private status: RepoStatus | null = null
  private commits: Commit[] = []
  private rows: GraphRow[] = []
  private branches: Branch[] = []
  private selected: string | null = null
  private busy = false
  private tick = 0
  private signature = ''
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Bumped per detail request so a slow diff cannot overwrite a newer one. */
  private detailToken = 0

  constructor(
    readonly paneId: string,
    private cwd: string,
    private readonly hooks: HistoryPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'history-pane'

    this.headEl = document.createElement('div')
    this.headEl.className = 'diff-head'
    this.element.appendChild(this.headEl)

    this.aboutEl = document.createElement('div')
    this.aboutEl.className = 'pane-about'
    this.element.appendChild(this.aboutEl)

    this.bandEl = document.createElement('div')
    this.bandEl.className = 'history-band'
    this.bandEl.hidden = true
    this.element.appendChild(this.bandEl)

    this.branchEl = document.createElement('div')
    this.branchEl.className = 'history-branches'
    this.element.appendChild(this.branchEl)

    const split = document.createElement('div')
    split.className = 'diff-split history-split'

    this.listEl = document.createElement('div')
    this.listEl.className = 'history-list'
    split.appendChild(this.listEl)

    this.detailEl = document.createElement('div')
    this.detailEl.className = 'history-detail'
    split.appendChild(this.detailEl)

    this.element.appendChild(split)

    this.describe()
    // Something on screen before the first answer comes back. The list, the
    // branches and the headline all wait on one round trip, and on a cold start
    // that trip queues behind whatever the main process is doing to get going —
    // reaping orphaned shells, most often. A pane that is empty for two seconds
    // and a pane that is broken look identical.
    this.showWaiting()
    void this.refresh(true)
    this.pollTimer = setInterval(() => void this.refresh(), STATUS_POLL_MS)
    window.addEventListener('focus', this.onFocus)
  }

  private readonly onFocus = () => void this.refresh(true)

  private describe(): void {
    this.aboutEl.textContent =
      `Every save (commit) in ${this.cwd}, and the lines of saves (branches) they sit on. ` +
      'Newest at the top.'
    this.aboutEl.title = this.cwd
  }

  /** Follows the workspace's folder when "Change folder…" moves it. */
  sync(): void {
    const root = historyRoot(this.paneId)
    if (root === this.cwd || this.disposed) return
    this.cwd = root
    this.selected = null
    this.signature = ''
    this.commits = []
    this.describe()
    void this.refresh(true)
  }

  private async refresh(force = false): Promise<void> {
    if (this.disposed || this.busy) return
    // `document.hidden` alone only catches a minimised window. A pane sitting
    // on a workspace tab nobody is looking at is just as unseen, and its timer
    // keeps running — which is how several background panes came to be spawning
    // git processes several times a second between them. `checkVisibility` is
    // the same test `filesPane` already polls behind.
    if (!force && (document.hidden || !this.element.checkVisibility())) return

    // An SSH workspace's folder is a path on the far machine. Running git here
    // would answer about a folder of the same name that happens to exist
    // locally, which is worse than not answering.
    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      this.showNotice(
        `This workspace runs its shells on ${remote}`,
        `The list of saves is read from this machine, and this workspace's folder is on ${remote}. Run git in the terminal beside this pane.`
      )
      return
    }

    let status: RepoStatus
    try {
      status = await backend().git.repoStatus(this.cwd)
    } catch {
      return
    }
    if (this.disposed) return

    if (!status.root) {
      this.status = null
      this.showNotice(
        'Not a project git is watching',
        `${this.cwd} is not inside a repository (a folder git is watching), so there are no saves to show. ` +
          'Run `git init` in the terminal beside this pane to start one.'
      )
      return
    }

    this.status = status

    const wantHistory = force || this.tick % HISTORY_EVERY === 0 || this.commits.length === 0
    this.tick++
    if (wantHistory) {
      try {
        const [commits, branches] = await Promise.all([
          backend().git.history(this.cwd, HISTORY_LIMIT),
          backend().git.branches(this.cwd),
        ])
        if (this.disposed) return
        this.commits = commits
        this.branches = branches
        this.rows = layoutGraph(commits)
      } catch {
        /* leave the last good picture up rather than blanking it */
      }
    }

    // Everything that can change what is drawn, in one string. Re-rendering a
    // list of four hundred rows every three seconds would fight the scroll
    // position and the selection for no reason.
    const signature = [
      status.branch,
      status.head,
      status.ahead,
      status.behind,
      status.inProgress,
      status.files.length,
      status.unsent.length,
      this.selected,
      this.busy,
      this.commits.map((c) => c.sha).join(','),
      this.branches.map((b) => `${b.name}${b.ahead}${b.behind}${b.current}`).join(','),
    ].join('|')
    if (signature === this.signature) return
    this.signature = signature
    this.render()
  }

  /** Says it is working, until the first answer replaces it. */
  private showWaiting(): void {
    const note = document.createElement('div')
    note.className = 'diff-empty'
    note.textContent = 'Reading the list of saves…'
    this.listEl.replaceChildren(note)
  }

  /** The pane's whole body replaced by one sentence, for the states with no picture. */
  private showNotice(title: string, body: string): void {
    this.headEl.replaceChildren()
    this.bandEl.hidden = true
    this.branchEl.replaceChildren()
    this.listEl.replaceChildren()
    this.aboutEl.textContent = title
    this.detailEl.replaceChildren()
    const note = document.createElement('div')
    note.className = 'diff-empty'
    note.textContent = body
    this.detailEl.appendChild(note)
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    this.renderHead()
    this.renderBand()
    this.renderBranches()
    this.renderList()
    void this.renderDetail()
  }

  private renderHead(): void {
    const status = this.status
    this.headEl.replaceChildren()

    const title = document.createElement('span')
    title.className = 'diff-title'
    title.textContent = `${this.commits.length} save${this.commits.length === 1 ? '' : 's'} (commits)`
    this.headEl.appendChild(title)

    if (status?.detached) {
      const chip = document.createElement('span')
      chip.className = 'history-where detached'
      chip.appendChild(gitWordFirst('detached HEAD'))
      this.headEl.appendChild(chip)
    } else if (status?.branch) {
      // "you are on main (HEAD)" — the git word visible rather than hovered,
      // because HEAD is the word people meet first in every error message and
      // it is meaningless until somebody puts it beside "where you are".
      const chip = document.createElement('span')
      chip.className = 'history-where'
      chip.textContent = 'you are on '
      const name = document.createElement('strong')
      name.textContent = status.branch
      chip.appendChild(name)
      const term = document.createElement('span')
      term.className = 'gw-alt'
      term.textContent = ' (HEAD)'
      chip.appendChild(term)
      explain(chip, 'HEAD', 'branch')
      this.headEl.appendChild(chip)
    }

    const peek = this.button('Peek at GitHub', 'git fetch', async () => {
      const res = await backend().git.peek(this.cwd)
      this.report(res, 'Looked at GitHub. Nothing here was touched.')
    })
    explain(peek, 'fetch')
    if (!this.status?.hasRemote) peek.disabled = true
    this.headEl.appendChild(peek)

    // No command beside this one, deliberately. That slot is a promise — it
    // says "this is what pressing me runs" — and the honest answer here is
    // "nothing, it opens a page". `git ia words` prints the same list, but it
    // is a separate tool that this app neither ships nor needs, and putting it
    // in the slot would claim a dependency that does not exist.
    const words = document.createElement('button')
    words.className = 'diff-btn'
    words.textContent = 'Words'
    words.disabled = this.busy
    words.title = 'Every git word, in plain words.'
    words.addEventListener('click', () => showGlossary())
    this.headEl.appendChild(words)
  }

  /**
   * The one line that answers "is my work safe, and where is it".
   *
   * Shown only when there is something to say. A band that permanently reads
   * "everything is level" is a band people stop reading, and then do not read
   * on the day it says something else.
   */
  private renderBand(): void {
    const status = this.status
    this.bandEl.replaceChildren()
    if (!status) {
      this.bandEl.hidden = true
      return
    }

    const parts: HTMLElement[] = []

    if (status.inProgress) {
      const stopped = document.createElement('div')
      stopped.className = 'history-note warn'
      stopped.textContent =
        status.inProgress === 'rebase'
          ? 'A rebase (restarting your saves from later) stopped part-way and is waiting for you. Nothing is lost. Finish it in the terminal beside this pane — git rebase --continue — or undo it with git rebase --abort.'
          : `A ${status.inProgress} stopped part-way and is waiting for you. Nothing is lost. Finish or undo it in the terminal beside this pane.`
      parts.push(stopped)
    }

    if (status.files.length) {
      const changes = document.createElement('div')
      changes.className = 'history-note'
      const count = status.files.length
      changes.append(
        document.createTextNode(
          `${count} file${count === 1 ? '' : 's'} changed since the last save. `
        )
      )
      const link = document.createElement('button')
      link.className = 'history-link'
      link.textContent = 'Open Changes to pick and save them'
      link.addEventListener('click', () => this.hooks.openChanges(workspaceOf(this.paneId)))
      changes.appendChild(link)
      parts.push(changes)
    }

    if (!status.hasRemote) {
      const alone = document.createElement('div')
      alone.className = 'history-note'
      alone.textContent =
        'This project has no copy anywhere else. Every save is on this machine only — if the disk goes, they go.'
      parts.push(alone)
    } else if (status.ahead || status.behind) {
      const row = document.createElement('div')
      row.className = 'history-note'

      if (status.ahead) {
        const text = document.createElement('span')
        text.append(
          document.createTextNode(
            `You have ${status.ahead} save${status.ahead === 1 ? '' : 's'} GitHub has not got (`
          )
        )
        text.appendChild(gitWordFirst('ahead'))
        text.append(document.createTextNode('). '))
        row.appendChild(text)
      }
      if (status.behind) {
        const text = document.createElement('span')
        text.append(
          document.createTextNode(
            `GitHub has ${status.behind} save${status.behind === 1 ? '' : 's'} you have not got (`
          )
        )
        text.appendChild(gitWordFirst('behind'))
        text.append(document.createTextNode('). '))
        row.appendChild(text)
      }
      if (status.ahead && status.behind) {
        const both = document.createElement('span')
        both.className = 'history-warn'
        both.append(document.createTextNode('You have '))
        both.appendChild(gitWordFirst('diverged'))
        both.append(
          document.createTextNode(
            ' — bring GitHub\'s in first, or sending will be refused. Nothing is lost either way.'
          )
        )
        row.appendChild(both)
      }

      const actions = document.createElement('span')
      actions.className = 'history-note-actions'
      if (status.behind) {
        const bring = this.button('Bring in GitHub\'s saves', 'git pull --rebase', () => this.bringIn())
        explain(bring, 'pull', 'rebase')
        actions.appendChild(bring)
      }
      if (status.ahead) {
        const send = this.button('Send mine to GitHub', 'git push', () => this.send(), true)
        explain(send, 'push')
        actions.appendChild(send)
      }
      row.appendChild(actions)
      parts.push(row)
    } else if (status.upstream) {
      const level = document.createElement('div')
      level.className = 'history-note ok'
      level.textContent = `Level with ${status.upstream} — every save here is on GitHub too.`
      parts.push(level)
    } else if (status.branch) {
      const never = document.createElement('div')
      never.className = 'history-note'
      never.append(
        document.createTextNode(
          `"${status.branch}" has never been sent, so GitHub has no copy of this line of saves. `
        )
      )
      const send = this.button('Send it for the first time', 'git push -u origin', () => this.send(), true)
      explain(send, 'push', 'branch')
      never.appendChild(send)
      parts.push(never)
    }

    this.bandEl.replaceChildren(...parts)
    this.bandEl.hidden = parts.length === 0
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
        'history-branch' +
        (branch.current ? ' current' : '') +
        (branch.remote ? ' remote' : '')

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

      chip.title = `${branchTooltip(branch)}\n\ngit switch ${branch.name.replace(/^[^/]+\//, '')}`
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

    const start = gitButton('+ new line of saves', 'git switch -c', { className: 'history-branch new' })
    explain(start, 'branch')
    start.addEventListener('click', () => void this.startBranch())
    this.branchEl.appendChild(start)
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    if (!this.commits.length) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent =
        'No saves yet. Once you pick some files and save them in the Changes pane, they appear here.'
      this.listEl.appendChild(empty)
      return
    }

    const unsent = new Set(this.status?.unsent ?? [])
    const lanes = Math.min(MAX_LANES, graphWidth(this.rows))
    const graphW = lanes * LANE_W + 8

    this.commits.forEach((commit, index) => {
      const row = this.rows[index]
      const el = document.createElement('button')
      el.className = 'history-row' + (commit.sha === this.selected ? ' active' : '')

      el.appendChild(drawRow(row, lanes, graphW))

      const text = document.createElement('span')
      text.className = 'history-row__text'

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
                ? 'GitHub\'s copy of a line of saves (a remote branch) points at this save.'
                : 'A line of saves (branch) here points at this save.'
        text.appendChild(badge)
      }

      const subject = document.createElement('span')
      subject.className = 'history-row__subject'
      subject.textContent = commit.subject || '(no message)'
      text.appendChild(subject)
      el.appendChild(text)

      if (unsent.has(commit.sha)) {
        const mark = document.createElement('span')
        mark.className = 'history-unsent'
        mark.textContent = 'this machine only'
        mark.title =
          'This save is not on GitHub. It exists on this disk and nowhere else, until you send (push) it.'
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
        this.signature = ''
        this.renderList()
        void this.renderDetail()
      })
      this.listEl.appendChild(el)
    })
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
    const number = document.createElement('span')
    number.appendChild(plainWord('hash'))
    const value = document.createElement('code')
    value.textContent = ` ${commit.short}`
    value.title = commit.sha
    number.appendChild(value)
    facts.appendChild(number)
    if (commit.parents.length > 1) {
      const merge = document.createElement('span')
      merge.appendChild(gitWordFirst('merge commit'))
      merge.append(document.createTextNode(` — two lines of saves meet here`))
      facts.appendChild(merge)
    } else if (commit.parents.length === 0) {
      const first = document.createElement('span')
      first.textContent = 'the very first save in this project'
      facts.appendChild(first)
    }
    if ((this.status?.unsent ?? []).includes(commit.sha)) {
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

    this.detailEl.appendChild(head)

    let files: ChangedFile[]
    let patch: string
    try {
      ;[files, patch] = await Promise.all([
        backend().git.commitFiles(this.cwd, commit.sha),
        backend().git.commitDiff(this.cwd, commit.sha),
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

    const pre = document.createElement('pre')
    pre.className = 'diff-text'
    for (const line of patch.split('\n')) {
      const span = document.createElement('span')
      span.className = `diff-line diff-line--${classify(line)}`
      // textContent, always: this is the content of files we did not write.
      span.textContent = line || ' '
      pre.appendChild(span)
    }
    this.detailEl.appendChild(pre)
  }

  // -------------------------------------------------------------- operations

  /**
   * A button that says what it does and shows the command it runs.
   *
   * The command is not decoration: it is the half of the vocabulary you
   * eventually have to type, and the one moment you are certain to care what
   * `git pull --rebase` means is the moment you are about to press the button
   * that runs it.
   */
  private button(
    label: string,
    command: string,
    onClick: () => void | Promise<void>,
    primary = false
  ): HTMLButtonElement {
    const el = gitButton(label, command, { className: 'diff-btn' + (primary ? ' primary' : '') })
    el.disabled = this.busy
    el.addEventListener('click', () => void onClick())
    return el
  }

  /**
   * Runs one operation with the pane locked, then refreshes.
   *
   * Locked because these take a network round trip and the pane polls: without
   * it, a second click while a push is in flight would start a second push, and
   * the refresh in between would redraw the button out from under the cursor.
   */
  private async guard(work: () => Promise<GitResult>, success: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.signature = ''
    this.render()
    try {
      const res = await work()
      this.report(res, success)
    } finally {
      this.busy = false
      this.signature = ''
      await this.refresh(true)
    }
  }

  /**
   * Says what happened, in both languages.
   *
   * Git's own message and our sentence, never one instead of the other: the
   * message is what matches every answer written about it anywhere, and the
   * sentence is what makes it mean something today.
   */
  private report(res: GitResult, success: string): void {
    if (res.ok) {
      showToast('Done', success)
      return
    }
    showToast('Git said no', res.hint ? `${res.hint}\n\ngit: ${res.error}` : (res.error ?? ''), {
      kind: 'warn',
      timeout: 20000,
    })
  }

  private async send(): Promise<void> {
    const status = this.status
    if (!status) return
    const ok = await confirmDialog({
      title: 'Send your saves to GitHub?',
      body:
        `This sends ${status.ahead || 'every'} save${status.ahead === 1 ? '' : 's'} on "${status.branch}" to GitHub (push to origin). ` +
        'It is the only step that leaves this machine. Nothing here changes, and nothing is deleted anywhere.',
      confirmLabel: 'Send',
    })
    if (!ok) return
    await this.guard(() => backend().git.send(this.cwd), 'Sent. Your saves are on GitHub.')
  }

  private async bringIn(): Promise<void> {
    const ok = await confirmDialog({
      title: 'Bring GitHub\'s saves in?',
      body:
        'This gets the saves GitHub has and you do not, and puts yours back on the end (git pull --rebase), ' +
        'so the line stays straight. If you both changed the same lines it will stop and ask you which wins — ' +
        'that is a question, not damage.',
      confirmLabel: 'Bring in',
    })
    if (!ok) return
    await this.guard(() => backend().git.bringIn(this.cwd), 'Brought in. Your files are up to date.')
  }

  private async goTo(branch: Branch): Promise<void> {
    const dirty = this.status?.files.length ?? 0
    const ok = await confirmDialog({
      title: `Go to "${branch.name}"?`,
      body:
        `Your files become what they are on that line of saves (git switch — "checkout" in older git). ` +
        (dirty
          ? `You have ${dirty} changed file${dirty === 1 ? '' : 's'} that are not saved. Git will either carry them across or refuse outright — it never throws them away.`
          : 'Nothing here is unsaved, so nothing is at risk.'),
      confirmLabel: 'Go there',
    })
    if (!ok) return
    await this.guard(
      () => backend().git.goTo(this.cwd, branch.name),
      `You are now on ${branch.name.replace(/^[^/]+\//, '')}.`
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
    await this.guard(() => backend().git.startBranch(this.cwd, name), `You are now on ${name}.`)
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    window.removeEventListener('focus', this.onFocus)
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
 * drawing would have to be recomputed and repainted in full every time one
 * did. A row owning its own few lines means a new save costs one row.
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

// ----------------------------------------------------------------- helpers

function branchTooltip(branch: Branch): string {
  const bits: string[] = []
  bits.push(
    branch.remote
      ? `${branch.name} — GitHub's copy of a line of saves (a remote branch).`
      : `${branch.name} — a line of saves (branch) on this machine.`
  )
  if (branch.current) bits.push('This is the one you are on.')
  if (branch.upstream) bits.push(`Paired with ${branch.upstream} on GitHub.`)
  if (branch.ahead) bits.push(`${branch.ahead} save(s) here that GitHub has not got.`)
  if (branch.behind) bits.push(`${branch.behind} save(s) on GitHub that this one has not got.`)
  if (branch.subject) bits.push(`Newest save: ${branch.subject}`)
  if (branch.at) bits.push(`Last touched ${ago(branch.at)}.`)
  return bits.join('\n')
}

/**
 * "2 hours ago", and never "in 3 seconds".
 *
 * A save made by a machine whose clock is a little ahead — which happens on any
 * shared repository — would otherwise be reported as being from the future,
 * and that reads as a bug rather than as a clock.
 */
export function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  if (days < 31) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30.4)
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
  const years = (days / 365).toFixed(1).replace(/\.0$/, '')
  return `${years} year${years === '1' ? '' : 's'} ago`
}

function workspaceOf(paneId: string): string {
  return store.workspaceOfPane(paneId)?.id ?? ''
}

/** The folder a history pane should watch — the same rule the changes pane uses. */
export function historyRoot(paneId: string): string {
  return (
    store.workspaceOfPane(paneId)?.cwd ??
    store.pane(paneId)?.cwd ??
    fallbackCwd(backend().capabilities.platform)
  )
}
