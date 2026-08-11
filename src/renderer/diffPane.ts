/**
 * What has changed in this workspace, and the three steps that move it along.
 *
 * The question you have most often once an agent has been editing is "what did
 * it just do to my repo", and answering it used to mean typing `git diff` and
 * losing your prompt. This is that, standing still — and now the rest of it,
 * because showing someone what changed and then telling them the way to keep it
 * is in the terminal is only half an answer.
 *
 * The pane is the three steps and nothing else:
 *
 *   pick (stage)  →  save (commit)  →  send (push)
 *
 * Each is a separate motion with its own gate, in that order, because the whole
 * confusion about git is that those three are three and not one: picked is not
 * saved, and saved is not on GitHub. A pane with one "Commit and push" button
 * would be quicker and would teach the opposite of the truth. Every git word on
 * screen carries its plain meaning beside it, for the same reason.
 *
 * Nothing here can destroy work. There is no discard, no undo of a save, no
 * force anything — the worst outcome of any button in this pane is a save you
 * did not mean to make, which is a thing you can then undo. The operations that
 * bin work are real and necessary and live in the terminal one pane away, where
 * they read as what they are.
 */
import { backend } from '../backend'
import { fallbackCwd } from '../shared/platform'
import type { ChangedFile, GitResult, RepoStatus } from '../shared/types'
import { remoteHostOfPane, store } from './state'
import { explain, gitButton, gitWordFirst, plainWord, showGlossary } from './ui/gitWord'
import { confirmDialog } from './ui/confirm'
import { showToast } from './ui/toast'
import type { AuxPane } from './auxPane'

/** How often the file list is re-read while the pane is visible. */
const POLL_MS = 2500

/** Which of a file's two halves a row is showing. */
type Side = 'picked' | 'changed'

interface Selection {
  repoPath: string
  side: Side
}

export interface DiffPaneHooks {
  /** Opens (or jumps to) the history pane for this workspace. */
  openHistory(workspaceId: string): void
}

export class DiffPane implements AuxPane {
  readonly element: HTMLDivElement
  private readonly headEl: HTMLDivElement
  private readonly listEl: HTMLDivElement
  private readonly diffEl: HTMLDivElement
  private readonly footEl: HTMLDivElement
  private readonly messageEl: HTMLTextAreaElement
  private readonly saveBtn: HTMLButtonElement
  private readonly sendBtn: HTMLButtonElement
  /** The label halves, so relabelling never touches the command beside them. */
  private readonly saveLabel: HTMLSpanElement
  private readonly sendLabel: HTMLSpanElement
  private readonly footNoteEl: HTMLDivElement
  private aboutEl: HTMLDivElement

  private status: RepoStatus | null = null
  private selected: Selection | null = null
  private signature = ''
  private busy = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  /** Bumped per request so a slow diff can't overwrite a newer one. */
  private token = 0

  constructor(
    readonly paneId: string,
    private cwd: string,
    private readonly hooks: DiffPaneHooks
  ) {
    this.element = document.createElement('div')
    this.element.className = 'diff-pane'

    this.headEl = document.createElement('div')
    this.headEl.className = 'diff-head'
    this.element.appendChild(this.headEl)

    // What this pane is and what it is pointed at. Without it "Changes" is a
    // word with no subject — the first question is always "changes to what".
    this.aboutEl = document.createElement('div')
    this.aboutEl.className = 'pane-about'
    this.element.appendChild(this.aboutEl)
    this.describe()

    const split = document.createElement('div')
    split.className = 'diff-split'

    this.listEl = document.createElement('div')
    this.listEl.className = 'diff-files'
    split.appendChild(this.listEl)

    this.diffEl = document.createElement('div')
    this.diffEl.className = 'diff-body'
    split.appendChild(this.diffEl)

    this.element.appendChild(split)

    // The save box is built once and never replaced, only relabelled. A pane
    // that rebuilt it on the poll would take the message out from under
    // somebody halfway through typing it.
    this.footEl = document.createElement('div')
    this.footEl.className = 'diff-foot'

    this.messageEl = document.createElement('textarea')
    this.messageEl.className = 'diff-message'
    this.messageEl.rows = 2
    this.messageEl.spellcheck = false
    this.messageEl.placeholder = 'What did you change? One line is plenty.'
    this.messageEl.addEventListener('input', () => this.updateFoot())
    this.messageEl.addEventListener('keydown', (e) => {
      // Ctrl+Enter saves, the convention every commit box has. Enter alone
      // stays a newline: a message is allowed to be more than one line, and a
      // key that saves on the way past is a key that saves by accident.
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        void this.save()
      }
    })
    this.footEl.appendChild(this.messageEl)

    const buttons = document.createElement('div')
    buttons.className = 'diff-foot__buttons'

    // The two that matter most carry the command they run, and the label is
    // relabelled rather than rebuilt — so `saveLabel` is held separately.
    this.saveBtn = gitButton('Save', 'git commit', { className: 'diff-btn primary' })
    this.saveLabel = this.saveBtn.firstChild as HTMLSpanElement
    this.saveBtn.addEventListener('click', () => void this.save())
    explain(this.saveBtn, 'commit')
    buttons.appendChild(this.saveBtn)

    this.sendBtn = gitButton('Send to GitHub', 'git push', { className: 'diff-btn' })
    this.sendLabel = this.sendBtn.firstChild as HTMLSpanElement
    this.sendBtn.addEventListener('click', () => void this.send())
    explain(this.sendBtn, 'push', 'origin')
    buttons.appendChild(this.sendBtn)

    this.footNoteEl = document.createElement('div')
    this.footNoteEl.className = 'diff-foot__note'
    buttons.appendChild(this.footNoteEl)

    this.footEl.appendChild(buttons)
    this.element.appendChild(this.footEl)

    // Something on screen before the first answer comes back — see the same
    // note in the history pane. An empty pane and a broken one look alike.
    const waiting = document.createElement('div')
    waiting.className = 'diff-empty'
    waiting.textContent = 'Reading what has changed…'
    this.listEl.replaceChildren(waiting)

    void this.refresh(true)
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS)
    window.addEventListener('focus', this.onFocus)
  }

  private readonly onFocus = () => void this.refresh(true)

  private describe(): void {
    this.aboutEl.textContent =
      `Everything in ${this.cwd} that is different from the last save (commit). ` +
      'Tick a file to pick it (stage it) for the next save.'
    this.aboutEl.title = this.cwd
  }

  /**
   * Says whose machine this workspace is on, instead of listing the wrong files.
   *
   * Deliberately names the host rather than saying "not supported": the pane is
   * working correctly and the answer is simply somewhere this process cannot
   * reach, and knowing which machine is what tells you to go and run `git` in
   * the terminal beside it.
   */
  private showRemoteNotice(host: string): void {
    this.listEl.replaceChildren()
    this.diffEl.replaceChildren()
    this.headEl.replaceChildren()
    this.footEl.hidden = true
    this.aboutEl.textContent = `This workspace runs its shells on ${host}`
    this.aboutEl.title = host
    const note = document.createElement('div')
    note.className = 'diff-empty'
    note.textContent = `Changes are read from this machine, and this workspace's folder is on ${host}. Run git in the terminal beside this pane.`
    this.diffEl.appendChild(note)
  }

  /**
   * Follows the workspace's folder when it moves.
   *
   * "Change folder…" can move the root under an open pane, and a pane still
   * diffing the folder it was opened in would be quietly answering a question
   * about somewhere else.
   */
  sync(): void {
    const root = diffRoot(this.paneId)
    if (root === this.cwd || this.disposed) return
    this.cwd = root
    this.selected = null
    this.signature = ''
    this.describe()
    void this.refresh(true)
  }

  private async refresh(force = false): Promise<void> {
    if (this.disposed || this.busy) return
    // Minimised window *or* a pane on a tab nobody is looking at — see the same
    // guard in `historyPane`. Both were polling git regardless of being seen.
    //
    // `force` for the same reason that pane has it, and one more: at mount the
    // element is not in the document yet, and `checkVisibility` says false for
    // anything detached. Without the escape hatch the first draw would be
    // skipped and the pane would sit on "Reading what has changed…" until the
    // poll came round.
    if (!force && (document.hidden || !this.element.checkVisibility())) return

    // An SSH workspace's folder is a path on the far machine, and `git` here
    // would either fail or — worse — answer about a directory of the same name
    // that happens to exist locally. Saying so is the only honest option:
    // running git over the connection would need a second, remote
    // implementation of this whole pane.
    const remote = remoteHostOfPane(this.paneId)
    if (remote) {
      this.showRemoteNotice(remote)
      return
    }

    let status: RepoStatus
    try {
      status = await backend().git.repoStatus(this.cwd)
    } catch {
      return
    }
    if (this.disposed) return
    this.status = status

    const signature = [
      status.root,
      status.branch,
      status.ahead,
      status.behind,
      status.inProgress,
      this.busy,
      this.selected ? `${this.selected.side}:${this.selected.repoPath}` : '',
      ...status.files.map((f) => `${f.picked}${f.changed}${f.untracked ? '?' : ''}${f.repoPath}`),
    ].join('\n')
    if (signature === this.signature) return
    this.signature = signature

    // A file that stopped being changed should not leave its diff on screen.
    if (this.selected && !status.files.some((f) => f.repoPath === this.selected!.repoPath)) {
      this.selected = null
    }

    this.render()
    void this.loadDiff()
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    this.renderHead()
    this.renderList()
    this.updateFoot()
  }

  private renderHead(): void {
    const status = this.status
    this.headEl.replaceChildren()

    const files = status?.files ?? []
    const picked = files.filter((f) => f.picked && !f.conflicted)

    const title = document.createElement('span')
    title.className = 'diff-title'
    title.textContent = files.length
      ? `${files.length} changed file${files.length === 1 ? '' : 's'}${picked.length ? `, ${picked.length} picked (staged)` : ''}`
      : 'No changes'
    this.headEl.appendChild(title)

    if (status?.branch) {
      const where = document.createElement('span')
      where.className = 'history-where'
      where.textContent = 'on '
      const name = document.createElement('strong')
      name.textContent = status.branch
      where.appendChild(name)
      explain(where, 'branch', 'HEAD')
      this.headEl.appendChild(where)
    }

    const all = gitButton('What is picked', 'git diff --cached', {
      className: 'diff-btn' + (this.selected === null ? ' active' : ''),
      title: 'The changed lines that are going into the next save, all together.',
    })
    all.addEventListener('click', () => {
      this.selected = null
      this.renderList()
      void this.loadDiff()
    })
    this.headEl.appendChild(all)

    const history = document.createElement('button')
    history.className = 'diff-btn'
    history.textContent = 'History'
    history.title = 'The picture of every save in this project, and the lines they sit on.'
    history.addEventListener('click', () => this.hooks.openHistory(workspaceOf(this.paneId)))
    this.headEl.appendChild(history)

    // No command beside this one — see the note on its twin in the history
    // pane. The slot means "what pressing me runs", and this one opens a page.
    const words = document.createElement('button')
    words.className = 'diff-btn'
    words.textContent = 'Words'
    words.title = 'Every git word, in plain words.'
    words.addEventListener('click', () => showGlossary())
    this.headEl.appendChild(words)
  }

  private renderList(): void {
    this.listEl.replaceChildren()
    const status = this.status

    if (!status?.root) {
      const note = document.createElement('div')
      note.className = 'diff-empty'
      note.textContent = 'Not inside a repository (a folder git is watching).'
      this.listEl.appendChild(note)
      return
    }

    const files = status.files

    // With nothing changed there is nothing to sort into groups, and two
    // headings explaining which half of nothing you are looking at read as a
    // contradiction. One sentence.
    if (!files.length) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent = 'Nothing has changed since the last save.'
      this.listEl.appendChild(empty)
      return
    }

    const conflicted = files.filter((f) => f.conflicted)
    const picked = files.filter((f) => f.picked && !f.conflicted)
    const changed = files.filter((f) => f.changed && !f.conflicted)

    if (conflicted.length) {
      this.group(
        [gitWordFirst('conflict'), text(' — both sides changed the same lines')],
        `${conflicted.length} file${conflicted.length === 1 ? '' : 's'} git cannot decide for you. ` +
          'Open each one, delete the <<<<<<< ======= >>>>>>> marker lines, keep the code you want, then tick it.',
        conflicted.map((file) => this.fileRow(file, 'changed', 'conflict'))
      )
    }

    // "picked (staged)" rather than "Picked" with the git word hidden in a
    // tooltip. A word you have to hover for is a word you never learn: the
    // whole point is that both are on screen at once, every time, until the
    // pair stops needing to be a pair.
    this.group(
      [plainWord('staged'), text(' — going into the next save')],
      picked.length
        ? 'Untick to take one back out. Nothing on disk changes either way.'
        : 'Nothing is picked yet, so a save right now would hold nothing. Tick something below.',
      picked.map((file) => this.fileRow(file, 'picked')),
      picked.length ? { label: 'Unpick all', command: 'git reset', run: () => this.unpick([]) } : undefined
    )

    this.group(
      [text('Not picked (not staged) — changed, and staying out')],
      changed.length
        ? 'Tick to put one into the next save.'
        : 'Everything that has changed is already picked.',
      changed.map((file) => this.fileRow(file, 'changed')),
      changed.length ? { label: 'Pick all', command: 'git add -A', run: () => this.pick([]) } : undefined
    )
  }

  private group(
    title: Node[],
    note: string,
    rows: HTMLElement[],
    action?: { label: string; command: string; run: () => void | Promise<void> }
  ): void {
    const head = document.createElement('div')
    head.className = 'diff-group'

    const label = document.createElement('span')
    label.className = 'diff-group__title'
    label.append(...title)
    head.appendChild(label)

    if (action) {
      const btn = gitButton(action.label, action.command, { className: 'diff-group__action' })
      btn.disabled = this.busy
      btn.addEventListener('click', () => void action.run())
      head.appendChild(btn)
    }
    this.listEl.appendChild(head)

    const hint = document.createElement('div')
    hint.className = 'diff-group__note'
    hint.textContent = note
    this.listEl.appendChild(hint)

    for (const row of rows) this.listEl.appendChild(row)
  }

  private fileRow(file: ChangedFile, side: Side, flavour?: 'conflict'): HTMLElement {
    const row = document.createElement('div')
    const active =
      this.selected?.repoPath === file.repoPath && this.selected.side === side
    row.className = 'diff-file' + (active ? ' active' : '') + (flavour ? ` ${flavour}` : '')
    row.title = file.repoPath

    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.className = 'diff-tick'
    tick.checked = side === 'picked'
    tick.disabled = this.busy || flavour === 'conflict'
    tick.title =
      side === 'picked'
        ? `Picked for the next save. Untick to take it out — your file is not touched.\n\ngit reset -- ${file.repoPath}`
        : `Tick to pick this file (stage it) for the next save.\n\ngit add -- ${file.repoPath}`
    tick.addEventListener('click', (e) => {
      e.stopPropagation()
      void (side === 'picked' ? this.unpick([file.repoPath]) : this.pick([file.repoPath]))
    })
    row.appendChild(tick)

    const letter = document.createElement('span')
    const code = (side === 'picked' ? file.picked : file.changed) || 'M'
    letter.className = `diff-status diff-status--${file.untracked ? 'new' : code.toLowerCase()}`
    letter.textContent = file.untracked ? '?' : code
    letter.title = letterMeaning(file, side)
    row.appendChild(letter)

    const name = document.createElement('button')
    name.className = 'diff-file__name'
    name.textContent = file.from ? `${file.repoPath} (was ${file.from})` : file.repoPath
    name.addEventListener('click', () => {
      this.selected = { repoPath: file.repoPath, side }
      this.renderList()
      void this.loadDiff()
    })
    row.appendChild(name)

    return row
  }

  private async loadDiff(): Promise<void> {
    const token = ++this.token
    const status = this.status
    this.diffEl.replaceChildren()
    if (!status?.root) return

    const selection = this.selected
    const file = selection ? status.files.find((f) => f.repoPath === selection.repoPath) : undefined

    let text: string
    try {
      text = selection && file
        ? await backend().git.fileDiff(this.cwd, file.repoPath, {
            picked: selection.side === 'picked',
            untracked: file.untracked && selection.side === 'changed',
          })
        : await backend().git.pickedDiff(this.cwd)
    } catch (err) {
      if (token !== this.token || this.disposed) return
      const problem = document.createElement('div')
      problem.className = 'diff-empty'
      problem.textContent = err instanceof Error ? err.message : String(err)
      this.diffEl.replaceChildren(problem)
      return
    }
    if (token !== this.token || this.disposed) return

    this.diffEl.replaceChildren()

    const caption = document.createElement('div')
    caption.className = 'diff-caption'
    caption.textContent = selection
      ? selection.side === 'picked'
        ? `${selection.repoPath} — the part that is picked, and going into the next save.`
        : `${selection.repoPath} — the part that is not picked, and staying out of the next save.`
      : 'Everything picked, together — this is exactly what the next save will hold.'
    this.diffEl.appendChild(caption)

    if (!text.trim()) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent = selection
        ? 'No changed lines on this side of the file.'
        : 'Nothing is picked, so the next save would hold nothing. Tick a file on the left.'
      this.diffEl.appendChild(empty)
      return
    }

    const pre = document.createElement('pre')
    pre.className = 'diff-text'
    for (const line of text.split('\n')) {
      const span = document.createElement('span')
      span.className = `diff-line diff-line--${classify(line)}`
      // textContent, always: this is the content of files we did not write.
      span.textContent = line || ' '
      pre.appendChild(span)
    }
    this.diffEl.appendChild(pre)
  }

  /**
   * Relabels the save box for what is currently true.
   *
   * Labels rather than a rebuild, because this runs on every keystroke in the
   * message and on every poll, and because the message box has to survive both.
   */
  private updateFoot(): void {
    const status = this.status
    this.footEl.hidden = !status?.root

    const picked = status?.files.filter((f) => f.picked && !f.conflicted).length ?? 0
    const conflicts = status?.files.some((f) => f.conflicted) ?? false
    const hasMessage = this.messageEl.value.trim().length > 0

    this.saveLabel.textContent = picked
      ? `Save ${picked} picked file${picked === 1 ? '' : 's'}`
      : 'Save'
    this.saveBtn.disabled = this.busy || picked === 0 || !hasMessage || conflicts || !!status?.inProgress

    const ahead = status?.ahead ?? 0
    this.sendLabel.textContent = ahead
      ? `Send ${ahead} save${ahead === 1 ? '' : 's'} to GitHub`
      : 'Send to GitHub'
    this.sendBtn.disabled =
      this.busy || !status?.hasRemote || (ahead === 0 && !!status?.upstream) || !!status?.inProgress

    this.footNoteEl.replaceChildren()
    if (status?.inProgress) {
      this.footNoteEl.textContent = `A ${status.inProgress} stopped part-way and is waiting. Finish it in the terminal beside this pane first — saving now would mean something else.`
    } else if (conflicts) {
      this.footNoteEl.textContent =
        'Sort the files git is asking about first. Nothing is lost while they sit there.'
    } else if (picked && !hasMessage) {
      this.footNoteEl.textContent = 'A save needs a line saying what it is.'
    } else if (picked) {
      // Not "on this machine only (commit (save))" — the term renders its own
      // brackets, and a sentence that supplies a second pair around it reads as
      // a typo rather than as a gloss.
      this.footNoteEl.append(document.createTextNode('Saving keeps it on this machine only — that is all a '))
      this.footNoteEl.appendChild(gitWordFirst('commit'))
      this.footNoteEl.append(document.createTextNode(' is. Sending is the step that puts it on GitHub.'))
    } else if (ahead) {
      this.footNoteEl.textContent = `${ahead} save${ahead === 1 ? '' : 's'} here that GitHub has not got.`
    } else {
      this.footNoteEl.textContent = ''
    }
  }

  // -------------------------------------------------------------- operations

  private async guard(work: () => Promise<GitResult>, success: string): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.render()
    try {
      const res = await work()
      if (res.ok) showToast('Done', success)
      else
        showToast('Git said no', res.hint ? `${res.hint}\n\ngit: ${res.error}` : (res.error ?? ''), {
          kind: 'warn',
          timeout: 20000,
        })
    } finally {
      this.busy = false
      this.signature = ''
      await this.refresh(true)
      // The poll only redraws when something changed, and an operation that
      // changed nothing — unpicking a file that was not picked — would
      // otherwise leave every button disabled until the next real change.
      this.render()
      void this.loadDiff()
    }
  }

  private pick(paths: string[]): Promise<void> {
    return this.guard(
      () => backend().git.pick(this.cwd, paths),
      paths.length ? 'Picked. Nothing is saved yet.' : 'Picked everything. Nothing is saved yet.'
    )
  }

  private unpick(paths: string[]): Promise<void> {
    return this.guard(
      () => backend().git.unpick(this.cwd, paths),
      'Taken back out. Your files were not touched.'
    )
  }

  private async save(): Promise<void> {
    const message = this.messageEl.value.trim()
    if (!message) return
    await this.guard(async () => {
      const res = await backend().git.save(this.cwd, message)
      // Only cleared on success: a message thrown away because git refused for
      // a reason you then fixed is a message you have to write again.
      if (res.ok) this.messageEl.value = ''
      return res
    }, 'Saved — on this machine. GitHub has not got it until you send it.')
  }

  private async send(): Promise<void> {
    const status = this.status
    if (!status) return
    const ok = await confirmDialog({
      title: 'Send your saves to GitHub?',
      body:
        `This sends ${status.ahead || 'every'} save${status.ahead === 1 ? '' : 's'} on "${status.branch ?? 'this line'}" to GitHub (push to origin). ` +
        'It is the only step that leaves this machine. Nothing here changes, and nothing is deleted anywhere.',
      confirmLabel: 'Send',
    })
    if (!ok) return
    await this.guard(() => backend().git.send(this.cwd), 'Sent. Your saves are on GitHub.')
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    window.removeEventListener('focus', this.onFocus)
  }
}

/** Shorthand for the many small text nodes the bilingual headings are built from. */
function text(value: string): Text {
  return document.createTextNode(value)
}

/** What a porcelain letter means, spelled out, since one character cannot. */
function letterMeaning(file: ChangedFile, side: Side): string {
  if (file.conflicted) return 'Both sides changed the same lines here, and git is waiting for you to say which wins.'
  if (file.untracked) return 'New — git has never been told about this file. It will not be in any save until you pick it.'
  const code = side === 'picked' ? file.picked : file.changed
  switch (code) {
    case 'M':
      return 'Changed.'
    case 'A':
      return 'Added — this file is new to the project, and picked.'
    case 'D':
      return 'Deleted.'
    case 'R':
      return `Renamed${file.from ? ` from ${file.from}` : ''}.`
    case 'C':
      return 'Copied from another file.'
    case 'T':
      return 'Changed kind — a file became a link, or the other way round.'
    default:
      return 'Changed.'
  }
}

/** Which colour a diff line gets. Order matters: `+++` is a header, not an add. */
export function classify(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'file'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

function workspaceOf(paneId: string): string {
  return store.workspaceOfPane(paneId)?.id ?? ''
}

/** The workspace folder a diff pane should watch. */
export function diffRoot(paneId: string): string {
  return (
    store.workspaceOfPane(paneId)?.cwd ??
    store.pane(paneId)?.cwd ??
    fallbackCwd(backend().capabilities.platform)
  )
}

/** The same root, under the name the search pane reads it by. */
export const searchRoot = diffRoot
