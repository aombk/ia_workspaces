/**
 * One pane for git, with two views in it.
 *
 * These were two panes. They were split on the reasoning that a pane doing both
 * would put the buttons that change things next to four hundred rows of
 * history, and that reasoning was right about a *merged* pane and wrong about
 * this one: the views still never share a screen, they share a shell. What they
 * had actually been sharing was worse — two timers asking git the same question
 * about the same folder, two copies of the head bar, two copies of the "send"
 * dialog, and two ideas of what the branch was called that could be a second
 * apart from each other.
 *
 * So the shell owns everything that is a fact about the repository:
 *
 * - the poll, which is now one poll however many panes are open (`repoWatch`),
 * - the band that answers "where is my work, and is it safe",
 * - the busy lock, so nothing can be pressed twice while a push is in flight,
 * - the way an operation reports itself, in git's words and ours,
 *
 * and each view owns only its own question. The switch is the one in every
 * client that does this — Changes and History, side by side, one at a time.
 *
 * The old `diff` and `history` pane kinds still open, and land on the matching
 * view. That is not politeness: a workspace file written by an older build
 * carries those names, and a build that does not recognise a kind rewrites it
 * as a terminal — so dropping them would silently demolish somebody's tabs the
 * first time they opened an old workspace.
 */
import { backend } from '../../backend'
import { hostLabel } from '../../shared/gitHosts'
import type { GitResult } from '../../shared/types'
import { remoteHostOfPane, store } from '../state'
import type { AuxPane } from '../auxPane'
import { confirmDialog } from '../ui/confirm'
import { explain, gitButton, gitWordFirst, showGlossary } from '../ui/gitWord'
import { showToast } from '../ui/toast'
import { ChangesView } from './changesView'
import { gitRoot, text } from './common'
import { HistoryView } from './historyView'
import { showPublish } from './publish'
import { invalidateRepo, refreshRepo, watchRepo, type RepoSnapshot } from './repoWatch'
import type { GitContext, GitView } from './view'

export type GitViewName = 'changes' | 'history'

export class GitPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly headEl: HTMLDivElement
  private readonly switchEl: HTMLDivElement
  private readonly aboutEl: HTMLDivElement
  private readonly bandEl: HTMLDivElement
  private readonly bodyEl: HTMLDivElement

  private readonly changes: ChangesView
  private readonly history: HistoryView
  private view: GitViewName
  private snapshot: RepoSnapshot | null = null
  private unwatch: (() => void) | null = null
  private busyFlag = false
  private disposed = false

  constructor(
    readonly paneId: string,
    private cwd: string,
    startOn: GitViewName = 'changes'
  ) {
    this.view = startOn

    this.element = document.createElement('div')
    this.element.className = 'git-pane'

    this.headEl = document.createElement('div')
    this.headEl.className = 'diff-head'
    this.element.appendChild(this.headEl)

    this.switchEl = document.createElement('div')
    this.switchEl.className = 'git-switch'
    this.headEl.appendChild(this.switchEl)

    this.aboutEl = document.createElement('div')
    this.aboutEl.className = 'pane-about'
    this.element.appendChild(this.aboutEl)

    this.bandEl = document.createElement('div')
    this.bandEl.className = 'history-band'
    this.bandEl.hidden = true
    this.element.appendChild(this.bandEl)

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'git-body'
    this.element.appendChild(this.bodyEl)

    const ctx: GitContext = {
      paneId,
      root: () => this.cwd,
      busy: () => this.busyFlag,
      run: (work, success) => this.run(work, success),
      openPublish: () => void this.publish(),
      show: (view) => this.showView(view),
      showFileHistory: (repoPath) => {
        this.showView('history')
        this.history.filterByFile(repoPath)
      },
    }

    this.changes = new ChangesView(ctx)
    this.history = new HistoryView(ctx)

    this.describe()
    this.renderHead()
    this.mountView()
    this.start()
  }

  // ------------------------------------------------------------- watching

  private start(): void {
    // An SSH workspace's folder is a path on the far machine, and git here
    // would either fail or — worse — quietly answer about a folder of the same
    // name that happens to exist locally. So nothing is watched at all: the
    // band says which machine the work is on, and the views are not mounted,
    // because a list of somebody else's files under the heading "your changes"
    // is worse than an empty pane.
    if (remoteHostOfPane(this.paneId)) {
      this.renderBand()
      return
    }

    this.unwatch = watchRepo(this.cwd, {
      // A pane on a workspace tab nobody is looking at is as unseen as a
      // minimised window, and the watcher asks rather than assuming — see the
      // note there about why this is not each view's job any more.
      isVisible: () => !this.disposed && this.element.checkVisibility(),
      onSnapshot: (snapshot) => this.onSnapshot(snapshot),
    })
  }

  private onSnapshot(snapshot: RepoSnapshot): void {
    if (this.disposed) return
    this.snapshot = snapshot
    this.renderHead()
    this.renderBand()
    this.activeView().update(snapshot)
  }

  /**
   * Follows the workspace's folder when "Change folder…" moves it.
   *
   * A pane still answering about the folder it was opened in would be quietly
   * answering a question about somewhere else.
   */
  sync(): void {
    if (this.disposed) return

    // The kind is the view, so something else setting it — "History" from the
    // tab menu while this pane is showing Changes — has to land here. Without
    // this the tab would rename itself and show the other thing.
    const wanted = viewForKind(store.pane(this.paneId)?.kind ?? 'diff')
    if (wanted !== this.view) {
      this.view = wanted
      this.mountView()
      this.describe()
      this.renderHead()
      this.renderBand()
    }

    // A workspace that stops running its shells over SSH has a folder this
    // machine can answer about after all, and nothing else would ever start
    // the watch it was denied at birth.
    if (!this.unwatch && !remoteHostOfPane(this.paneId)) {
      this.mountView()
      this.start()
    }

    const root = gitRoot(this.paneId)
    if (root === this.cwd) return
    this.cwd = root
    this.snapshot = null
    this.unwatch?.()
    this.describe()
    this.renderHead()
    this.start()
  }

  private describe(): void {
    this.aboutEl.textContent =
      this.view === 'changes'
        ? `Everything in ${this.cwd} that is different from the last save (commit). Tick a file — or a block, or a line — to pick it for the next save.`
        : `Every save (commit) in ${this.cwd}, and the lines of saves (branches) they sit on. Newest at the top.`
    this.aboutEl.title = this.cwd
  }

  // --------------------------------------------------------------- views

  private activeView(): GitView {
    return this.view === 'changes' ? this.changes : this.history
  }

  private showView(view: GitViewName): void {
    if (view === this.view) return
    this.view = view
    // Written back as the pane's kind, which renames the tab and is what brings
    // you back to this view after a restart. See `setPaneKind`.
    store.setPaneKind(this.paneId, view === 'history' ? 'history' : 'diff')
    this.mountView()
    this.describe()
    this.renderHead()
    this.renderBand()
  }

  private mountView(): void {
    // See `start`: on a remote workspace there is nothing here git can answer
    // about, and the band is the whole of the pane.
    if (remoteHostOfPane(this.paneId)) {
      this.bodyEl.replaceChildren()
      return
    }
    const view = this.activeView()
    this.bodyEl.replaceChildren(view.element)
    view.update(this.snapshot)
    view.activate?.()
  }

  // ---------------------------------------------------------------- head

  private renderHead(): void {
    this.renderSwitch()

    // Everything after the switch is rebuilt; the switch itself is kept so the
    // button under the cursor does not move on every poll.
    while (this.headEl.children.length > 1) this.headEl.lastElementChild!.remove()

    const status = this.snapshot?.status
    const remote = remoteHostOfPane(this.paneId)
    if (remote || !status) return

    const title = document.createElement('span')
    title.className = 'diff-title'
    if (this.view === 'changes') {
      const files = status.files
      const picked = files.filter((f) => f.picked && !f.conflicted).length
      title.textContent = files.length
        ? `${files.length} changed file${files.length === 1 ? '' : 's'}${picked ? `, ${picked} picked (staged)` : ''}`
        : 'No changes'
    } else {
      title.textContent = 'the saves in this project'
    }
    this.headEl.appendChild(title)

    if (status.detached) {
      const chip = document.createElement('span')
      chip.className = 'history-where detached'
      chip.appendChild(gitWordFirst('detached HEAD'))
      this.headEl.appendChild(chip)
    } else if (status.branch) {
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

    const where = hostLabel(this.snapshot?.remote)
    const peek = gitButton(`Peek at ${where}`, 'git fetch', { className: 'diff-btn' })
    explain(peek, 'fetch')
    peek.disabled = this.busyFlag || !status.hasRemote
    peek.addEventListener('click', () =>
      void this.run(() => backend().git.peek(this.cwd), `Looked at ${where}. Nothing here was touched.`)
    )
    this.headEl.appendChild(peek)

    // No command beside this one, deliberately. That slot is a promise — it
    // says "this is what pressing me runs" — and the honest answer here is
    // "nothing, it opens a page".
    const words = document.createElement('button')
    words.className = 'diff-btn'
    words.textContent = 'Words'
    words.title = 'Every git word, in plain words.'
    words.addEventListener('click', () => showGlossary())
    this.headEl.appendChild(words)
  }

  private renderSwitch(): void {
    this.switchEl.replaceChildren()
    const make = (view: GitViewName, label: string, hint: string) => {
      const btn = document.createElement('button')
      btn.className = 'git-switch__tab' + (view === this.view ? ' current' : '')
      btn.textContent = label
      btn.title = hint
      btn.addEventListener('click', () => this.showView(view))
      this.switchEl.appendChild(btn)
    }
    make('changes', 'Changes', 'What is different right now, and how to keep it.')
    make('history', 'History', 'Every save in this project, and the lines they sit on.')
  }

  // ---------------------------------------------------------------- band

  /**
   * The one line that answers "is my work safe, and where is it".
   *
   * In the shell rather than in either view, because it is true of the
   * repository and not of the question you happen to be asking about it — and
   * because it is the one place both views used to say the same thing in two
   * slightly different sentences.
   *
   * Shown only when there is something to say. A band that permanently reads
   * "everything is level" is a band people stop reading, and then do not read
   * on the day it says something else.
   */
  private renderBand(): void {
    const status = this.snapshot?.status
    this.bandEl.replaceChildren()

    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      // An SSH workspace's folder is a path on the far machine, and git here
      // would either fail or — worse — answer about a directory of the same
      // name that happens to exist locally.
      this.bandEl.hidden = false
      this.aboutEl.textContent = `This workspace runs its shells on ${remote}`
      const note = document.createElement('div')
      note.className = 'history-note warn'
      note.textContent = `Git is read from this machine, and this workspace's folder is on ${remote}. Run git in the terminal beside this pane.`
      this.bandEl.appendChild(note)
      return
    }

    if (!status) {
      this.bandEl.hidden = true
      return
    }

    const parts: HTMLElement[] = []
    const where = hostLabel(this.snapshot?.remote)

    // Not a repository at all: the first rung of the publish ladder, and the
    // one the old panes answered with "run `git init` in the terminal" — which
    // is telling somebody the answer is in the language they cannot read.
    if (!status.root) {
      const none = document.createElement('div')
      none.className = 'history-note'
      none.append(
        text(
          `${this.cwd} is not being tracked by git, so there are no saves and nothing to compare against. `
        )
      )
      none.appendChild(this.bandButton('Start tracking it…', () => void this.publish()))
      parts.push(none)
      this.bandEl.replaceChildren(...parts)
      this.bandEl.hidden = false
      return
    }

    if (status.inProgress) {
      const stopped = document.createElement('div')
      stopped.className = 'history-note warn'
      stopped.textContent =
        status.inProgress === 'rebase'
          ? 'A rebase (restarting your saves from later) stopped part-way and is waiting for you. Nothing is lost. Finish it in the terminal beside this pane — git rebase --continue — or undo it with git rebase --abort.'
          : `A ${status.inProgress} stopped part-way and is waiting for you. Nothing is lost. Finish or undo it in the terminal beside this pane.`
      parts.push(stopped)
    }

    // Only in History: in Changes the file list *is* this sentence, and saying
    // it above the list it describes is saying it twice.
    if (status.files.length && this.view === 'history') {
      const changes = document.createElement('div')
      changes.className = 'history-note'
      const count = status.files.length
      changes.append(text(`${count} file${count === 1 ? '' : 's'} changed since the last save. `))
      changes.appendChild(this.bandButton('Open Changes to pick and save them', () => this.showView('changes')))
      parts.push(changes)
    }

    if (!status.hasRemote) {
      const alone = document.createElement('div')
      alone.className = 'history-note'
      alone.append(
        text('This project has no copy anywhere else. Every save is on this machine only — if the disk goes, they go. ')
      )
      alone.appendChild(this.bandButton('Put it online…', () => void this.publish()))
      parts.push(alone)
    } else if (status.ahead || status.behind) {
      const row = document.createElement('div')
      row.className = 'history-note'

      if (status.ahead) {
        const span = document.createElement('span')
        span.append(text(`You have ${status.ahead} save${status.ahead === 1 ? '' : 's'} ${where} has not got (`))
        span.appendChild(gitWordFirst('ahead'))
        span.append(text('). '))
        row.appendChild(span)
      }
      if (status.behind) {
        const span = document.createElement('span')
        span.append(text(`${where} has ${status.behind} save${status.behind === 1 ? '' : 's'} you have not got (`))
        span.appendChild(gitWordFirst('behind'))
        span.append(text('). '))
        row.appendChild(span)
      }
      if (status.ahead && status.behind) {
        const both = document.createElement('span')
        both.className = 'history-warn'
        both.append(text('You have '))
        both.appendChild(gitWordFirst('diverged'))
        both.append(text(` — bring ${where}'s in first, or sending will be refused. Nothing is lost either way.`))
        row.appendChild(both)
      }

      const actions = document.createElement('span')
      actions.className = 'history-note-actions'
      if (status.behind) {
        const bring = gitButton(`Bring in ${where}'s saves`, 'git pull --rebase', { className: 'diff-btn' })
        explain(bring, 'pull', 'rebase')
        bring.disabled = this.busyFlag
        bring.addEventListener('click', () => void this.bringIn())
        actions.appendChild(bring)
      }
      if (status.ahead) {
        const send = gitButton('Send mine', 'git push', { className: 'diff-btn primary' })
        explain(send, 'push')
        send.disabled = this.busyFlag
        send.addEventListener('click', () => void this.send())
        actions.appendChild(send)
      }
      row.appendChild(actions)
      parts.push(row)
    } else if (status.upstream) {
      const level = document.createElement('div')
      level.className = 'history-note ok'
      level.textContent = `Level with ${status.upstream} — every save here is on ${where} too.`
      parts.push(level)
    } else if (status.branch) {
      const never = document.createElement('div')
      never.className = 'history-note'
      never.append(
        text(`"${status.branch}" has never been sent, so ${where} has no copy of this line of saves. `)
      )
      const send = gitButton('Send it for the first time', 'git push -u origin', { className: 'diff-btn primary' })
      explain(send, 'push', 'branch')
      send.disabled = this.busyFlag
      send.addEventListener('click', () => void this.send())
      never.appendChild(send)
      parts.push(never)
    }

    this.bandEl.replaceChildren(...parts)
    this.bandEl.hidden = parts.length === 0
  }

  private bandButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.className = 'history-link'
    btn.textContent = label
    btn.addEventListener('click', onClick)
    return btn
  }

  // ---------------------------------------------------------- operations

  /**
   * Runs one operation with the pane locked, then refreshes.
   *
   * Locked because these take a round trip and the pane polls: without it a
   * second click while a push is in flight would start a second push, and the
   * refresh in between would redraw the button out from under the cursor.
   */
  private async run(work: () => Promise<GitResult>, success: string): Promise<void> {
    if (this.busyFlag) return
    this.busyFlag = true
    this.renderHead()
    this.renderBand()
    this.activeView().update(this.snapshot)
    try {
      const res = await work()
      if (res.ok) showToast('Done', success)
      else
        showToast('Git said no', res.hint ? `${res.hint}\n\ngit: ${res.error}` : (res.error ?? ''), {
          kind: 'warn',
          timeout: 20000,
        })
    } finally {
      this.busyFlag = false
      // An operation that changed nothing — unpicking a file that was not
      // picked — would otherwise leave every button disabled until the next
      // real change, because the poll only redraws when something moved.
      invalidateRepo(this.cwd)
      await refreshRepo(this.cwd)
      if (!this.disposed) {
        this.renderHead()
        this.renderBand()
        this.activeView().update(this.snapshot)
      }
    }
  }

  private async send(): Promise<void> {
    const status = this.snapshot?.status
    if (!status) return
    const where = hostLabel(this.snapshot?.remote)
    const ok = await confirmDialog({
      title: `Send your saves to ${where}?`,
      body:
        `This sends ${status.ahead || 'every'} save${status.ahead === 1 ? '' : 's'} on "${status.branch ?? 'this line'}" to ${where} (push to origin). ` +
        'It is the only step that leaves this machine. Nothing here changes, and nothing is deleted anywhere.',
      confirmLabel: 'Send',
    })
    if (!ok) return
    await this.run(() => backend().git.send(this.cwd), `Sent. Your saves are on ${where}.`)
  }

  private async bringIn(): Promise<void> {
    const where = hostLabel(this.snapshot?.remote)
    const ok = await confirmDialog({
      title: `Bring ${where}'s saves in?`,
      body:
        `This gets the saves ${where} has and you do not, and puts yours back on the end (git pull --rebase), ` +
        'so the line stays straight. If you both changed the same lines it will stop and ask you which wins — ' +
        'that is a question, not damage.',
      confirmLabel: 'Bring in',
    })
    if (!ok) return
    await this.run(() => backend().git.bringIn(this.cwd), 'Brought in. Your files are up to date.')
  }

  private async publish(): Promise<void> {
    await showPublish({
      cwd: () => this.cwd,
      status: () => this.snapshot?.status ?? null,
      run: (work, success) => this.run(work, success),
      showChanges: () => this.showView('changes'),
    })
  }

  dispose(): void {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
    this.changes.dispose()
    this.history.dispose()
  }
}

/**
 * Which view a pane kind lands on.
 *
 * The reason the two old names survive: a workspace file written before this
 * change says `diff` or `history`, and a build that meets a kind it does not
 * know rewrites the pane as a terminal — so the tab would not merely open on
 * the wrong view, it would be gone on the next save of the document.
 */
export function viewForKind(kind: string): GitViewName {
  return kind === 'history' ? 'history' : 'changes'
}
