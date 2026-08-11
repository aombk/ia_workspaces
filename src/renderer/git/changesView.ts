/**
 * What has changed in this workspace, and the three steps that move it along.
 *
 * The question you have most often once an agent has been editing is "what did
 * it just do to my repo", and answering it used to mean typing `git diff` and
 * losing your prompt. This is that, standing still — and then the rest of it,
 * because showing someone what changed and then telling them the way to keep it
 * is in the terminal is only half an answer.
 *
 * The view is the three steps and nothing else:
 *
 *   pick (stage)  →  save (commit)  →  send (push)
 *
 * Each is a separate motion with its own gate, in that order, because the whole
 * confusion about git is that those three are three and not one: picked is not
 * saved, and saved is not online. A pane with one "Commit and push" button
 * would be quicker and would teach the opposite of the truth. Every git word on
 * screen carries its plain meaning beside it, for the same reason.
 *
 * Picking works at three sizes — the file, the block, the line — because a file
 * is the wrong unit on the day you have fixed a bug and also left a stray
 * `console.log` three lines further down. Git's own answer to that is `git add
 * -p` and sixteen single-letter replies; this is the same thing with the patch
 * on screen and a tick beside each line. See `src/shared/diffPatch.ts` for the
 * arithmetic, which is where all the difficulty actually is.
 *
 * Nothing here can destroy work. There is no discard and no force anything. The
 * two operations that *undo* — taking back the last save, and folding what is
 * picked into it — keep every file exactly as it is on disk and refuse outright
 * once the save has left this machine, which is the line between correcting
 * yourself and rewriting something somebody else already has.
 */
import { backend } from '../../backend'
import {
  buildPatch,
  hunkCounts,
  hunkLineIndices,
  parsePatch,
  type FilePatch,
  type Hunk,
  type PatchLine,
} from '../../shared/diffPatch'
import { hostLabel } from '../../shared/gitHosts'
import type { ChangedFile, RepoStatus } from '../../shared/types'
import { confirmDialog } from '../ui/confirm'
import { explain, gitButton, gitWordFirst, plainWord } from '../ui/gitWord'
import { patchElement, text } from './common'
import type { RepoSnapshot } from './repoWatch'
import type { GitContext, GitView } from './view'

/** Which of a file's two halves a row is showing. */
type Side = 'picked' | 'changed'

interface Selection {
  repoPath: string
  side: Side
}

export class ChangesView implements GitView {
  readonly element: HTMLDivElement
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
  private readonly undoRow: HTMLDivElement

  private snapshot: RepoSnapshot | null = null
  private selected: Selection | null = null
  /** The patch currently on screen, parsed, so a tick can be turned into one. */
  private patch: FilePatch | null = null
  /** Ticked line indices within that patch. Cleared whenever the patch is refetched. */
  private ticked = new Set<number>()
  private disposed = false
  /** True once git has answered at all, so "no answer" stops reading as "no repository". */
  private answered = false
  /** Bumped per request so a slow diff can't overwrite a newer one. */
  private token = 0

  constructor(private readonly ctx: GitContext) {
    this.element = document.createElement('div')
    this.element.className = 'changes-view'

    const split = document.createElement('div')
    split.className = 'diff-split'

    this.listEl = document.createElement('div')
    this.listEl.className = 'diff-files'
    split.appendChild(this.listEl)

    this.diffEl = document.createElement('div')
    this.diffEl.className = 'diff-body'
    split.appendChild(this.diffEl)

    this.element.appendChild(split)

    // The save box is built once and never replaced, only relabelled. A view
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

    this.saveBtn = gitButton('Save', 'git commit', { className: 'diff-btn primary' })
    this.saveLabel = this.saveBtn.firstChild as HTMLSpanElement
    this.saveBtn.addEventListener('click', () => void this.save())
    explain(this.saveBtn, 'commit')
    buttons.appendChild(this.saveBtn)

    this.sendBtn = gitButton('Send', 'git push', { className: 'diff-btn' })
    this.sendLabel = this.sendBtn.firstChild as HTMLSpanElement
    this.sendBtn.addEventListener('click', () => void this.send())
    explain(this.sendBtn, 'push', 'origin')
    buttons.appendChild(this.sendBtn)

    this.footNoteEl = document.createElement('div')
    this.footNoteEl.className = 'diff-foot__note'
    buttons.appendChild(this.footNoteEl)

    this.footEl.appendChild(buttons)

    // The two ways back, on their own line under the two ways forward. Below
    // rather than beside, and never in the primary style: these are for the
    // minute after a save you did not mean to make, not part of the loop.
    this.undoRow = document.createElement('div')
    this.undoRow.className = 'diff-foot__undo'
    this.footEl.appendChild(this.undoRow)

    this.element.appendChild(this.footEl)

    const waiting = document.createElement('div')
    waiting.className = 'diff-empty'
    waiting.textContent = 'Reading what has changed…'
    this.listEl.replaceChildren(waiting)
  }

  // ------------------------------------------------------------------ state

  update(snapshot: RepoSnapshot | null): void {
    // Nothing has come back yet. The placeholder the constructor put up stays,
    // because "Reading what has changed…" and "this folder is not a project"
    // are different sentences and only one of them is true at this point — and
    // on a cold start the first answer queues behind whatever the main process
    // is doing to get going, which is long enough to read the wrong one.
    if (!snapshot && !this.answered) {
      this.footEl.hidden = true
      return
    }
    if (snapshot) this.answered = true

    this.snapshot = snapshot
    const status = snapshot?.status

    // A file that stopped being changed should not leave its diff on screen.
    if (this.selected && !status?.files.some((f) => f.repoPath === this.selected!.repoPath)) {
      this.selected = null
    }

    this.render()
    void this.loadDiff()
  }

  private render(): void {
    this.renderList()
    this.updateFoot()
  }

  // ------------------------------------------------------------- file list

  private renderList(): void {
    this.listEl.replaceChildren()
    const status = this.snapshot?.status

    if (!status?.root) {
      const note = document.createElement('div')
      note.className = 'diff-empty'
      note.textContent = 'This folder is not part of a project git is watching.'
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
        ? 'Tick to put one into the next save, or open it to pick part of it.'
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
      btn.disabled = this.ctx.busy()
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
    const active = this.selected?.repoPath === file.repoPath && this.selected.side === side
    row.className = 'diff-file' + (active ? ' active' : '') + (flavour ? ` ${flavour}` : '')
    row.title = file.repoPath

    const tick = document.createElement('input')
    tick.type = 'checkbox'
    tick.className = 'diff-tick'
    tick.checked = side === 'picked'
    tick.disabled = this.ctx.busy() || flavour === 'conflict'
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
    name.addEventListener('click', () => this.select({ repoPath: file.repoPath, side }))
    row.appendChild(name)

    // "Where did this file come from" is a question you have while looking at
    // what it has just become, and it is one filter away in the other view.
    const past = document.createElement('button')
    past.className = 'diff-file__past'
    past.textContent = '⟲'
    past.title = `Every save that touched ${file.repoPath}.`
    past.addEventListener('click', (e) => {
      e.stopPropagation()
      this.ctx.showFileHistory(file.repoPath)
    })
    if (!file.untracked) row.appendChild(past)

    return row
  }

  private select(selection: Selection | null): void {
    this.selected = selection
    this.ticked.clear()
    this.renderList()
    void this.loadDiff()
  }

  // ----------------------------------------------------------------- patch

  private async loadDiff(): Promise<void> {
    const token = ++this.token
    const status = this.snapshot?.status
    if (!status?.root) {
      this.diffEl.replaceChildren()
      return
    }

    const selection = this.selected
    const file = selection ? status.files.find((f) => f.repoPath === selection.repoPath) : undefined

    let raw: string
    try {
      raw =
        selection && file
          ? await backend().git.fileDiff(this.ctx.root(), file.repoPath, {
              picked: selection.side === 'picked',
              untracked: file.untracked && selection.side === 'changed',
            })
          : await backend().git.pickedDiff(this.ctx.root())
    } catch (err) {
      if (token !== this.token || this.disposed) return
      const problem = document.createElement('div')
      problem.className = 'diff-empty'
      problem.textContent = err instanceof Error ? err.message : String(err)
      this.diffEl.replaceChildren(problem)
      return
    }
    if (token !== this.token || this.disposed) return

    // A patch that has been refetched is a patch whose line numbers may have
    // moved, and a tick held against the old one would pick a different line.
    // Dropping the selection is the only honest option — see the "patch does
    // not apply" hint, which is what would happen otherwise.
    this.ticked.clear()
    this.patch = null

    this.diffEl.replaceChildren()

    const caption = document.createElement('div')
    caption.className = 'diff-caption'
    caption.textContent = selection
      ? selection.side === 'picked'
        ? `${selection.repoPath} — the part that is picked, and going into the next save.`
        : `${selection.repoPath} — the part that is not picked, and staying out of the next save.`
      : 'Everything picked, together — this is exactly what the next save will hold.'
    this.diffEl.appendChild(caption)

    if (!raw.trim()) {
      const empty = document.createElement('div')
      empty.className = 'diff-empty'
      empty.textContent = selection
        ? 'No changed lines on this side of the file.'
        : 'Nothing is picked, so the next save would hold nothing. Tick a file on the left.'
      this.diffEl.appendChild(empty)
      return
    }

    // Only a single file's patch can be ticked. The "everything picked" view is
    // several files at once and its unit is already the file, which the list on
    // the left does better; and an untracked file has no patch git can apply
    // part of, because git has never seen a version of it to apply against.
    const pickable = !!selection && !!file && !(file.untracked && selection.side === 'changed')
    if (!pickable) {
      if (file?.untracked) {
        const note = document.createElement('div')
        note.className = 'diff-note'
        note.textContent =
          'Git has never been told about this file, so it goes into a save whole or not at all — there is no earlier version of it to pick lines against.'
        this.diffEl.appendChild(note)
      }
      this.diffEl.appendChild(patchElement(raw))
      return
    }

    const files = parsePatch(raw)
    this.patch = files[0] ?? null
    if (!this.patch || this.patch.binaryOrEmpty) {
      const note = document.createElement('div')
      note.className = 'diff-note'
      note.textContent = this.patch
        ? 'This change has no lines to pick — it is a rename, a permission change, or a file git treats as binary.'
        : 'Git returned something this pane could not read as a patch. It is shown as it came.'
      this.diffEl.appendChild(note)
      this.diffEl.appendChild(patchElement(raw))
      return
    }

    this.renderPatch()
  }

  /**
   * The patch, with a tick against every changed line.
   *
   * Redrawn in full whenever a tick moves. A patch is at most a few hundred
   * lines — the pane caps what it fetches long before this matters — and the
   * alternative is holding a node per line and keeping two models in step,
   * which is the bug that ships.
   */
  private renderPatch(): void {
    const patch = this.patch
    const selection = this.selected
    if (!patch || !selection) return

    // Everything after the caption belongs to the patch.
    while (this.diffEl.children.length > 1) this.diffEl.lastElementChild!.remove()

    const picked = selection.side === 'picked'
    const bar = document.createElement('div')
    bar.className = 'hunk-bar'

    const count = this.ticked.size
    const summary = document.createElement('span')
    summary.className = 'hunk-bar__note'
    summary.textContent = count
      ? `${count} line${count === 1 ? '' : 's'} ticked`
      : 'Tick single lines, or take a whole block with the button beside it.'
    bar.appendChild(summary)

    if (count) {
      const apply = gitButton(
        picked ? `Unpick ${count} line${count === 1 ? '' : 's'}` : `Pick ${count} line${count === 1 ? '' : 's'}`,
        picked ? 'git apply --cached -R' : 'git apply --cached',
        { className: 'diff-btn primary' }
      )
      apply.disabled = this.ctx.busy()
      apply.addEventListener('click', () => void this.applyTicked(patch.hunks))
      bar.appendChild(apply)

      const clear = document.createElement('button')
      clear.className = 'diff-btn'
      clear.textContent = 'Clear ticks'
      clear.addEventListener('click', () => {
        this.ticked.clear()
        this.renderPatch()
      })
      bar.appendChild(clear)
    }
    this.diffEl.appendChild(bar)

    for (const hunk of patch.hunks) {
      this.diffEl.appendChild(this.hunkElement(patch, hunk, picked))
    }
  }

  private hunkElement(patch: FilePatch, hunk: Hunk, picked: boolean): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'hunk'

    const head = document.createElement('div')
    head.className = 'hunk-head'

    const { added, removed } = hunkCounts(hunk)
    const where = document.createElement('span')
    where.className = 'hunk-head__where'
    // The line number people can act on is the one in the file as it is now.
    where.textContent = `line ${hunk.newStart}`
    head.appendChild(where)

    const counts = document.createElement('span')
    counts.className = 'hunk-head__counts'
    counts.textContent = `${added ? `+${added}` : ''}${added && removed ? ' ' : ''}${removed ? `−${removed}` : ''}`
    head.appendChild(counts)

    const context = hunk.header.replace(/^@@[^@]*@@\s*/, '')
    if (context) {
      const inWhat = document.createElement('span')
      inWhat.className = 'hunk-head__context'
      inWhat.textContent = context
      head.appendChild(inWhat)
    }

    const whole = document.createElement('button')
    whole.className = 'diff-btn hunk-head__action'
    whole.textContent = picked ? 'Unpick this block' : 'Pick this block'
    whole.title = picked
      ? 'Take these lines back out of the next save. Your file is not touched.'
      : 'Put these lines into the next save, and leave the rest of the file out.'
    whole.disabled = this.ctx.busy()
    whole.addEventListener('click', () => void this.applyHunk(patch, hunk))
    head.appendChild(whole)

    wrap.appendChild(head)

    const body = document.createElement('div')
    body.className = 'hunk-body'
    for (const line of hunk.lines) body.appendChild(this.lineElement(line))
    wrap.appendChild(body)

    return wrap
  }

  private lineElement(line: PatchLine): HTMLElement {
    const row = document.createElement('div')
    const kind = line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : line.kind === 'ctx' ? 'ctx' : 'meta'
    const changeable = line.kind === 'add' || line.kind === 'del'
    const on = changeable && this.ticked.has(line.index)
    row.className = `hunk-line hunk-line--${kind}` + (on ? ' ticked' : '') + (changeable ? ' pickable' : '')

    const mark = document.createElement('span')
    mark.className = 'hunk-line__mark'
    mark.textContent = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : line.kind === 'nonewline' ? '\\' : ' '
    row.appendChild(mark)

    const body = document.createElement('span')
    body.className = 'hunk-line__text'
    // textContent, always: this is the content of files we did not write.
    body.textContent = line.text || ' '
    row.appendChild(body)

    if (changeable) {
      row.tabIndex = 0
      row.setAttribute('role', 'checkbox')
      row.setAttribute('aria-checked', String(on))
      const toggle = () => {
        if (this.ticked.has(line.index)) this.ticked.delete(line.index)
        else this.ticked.add(line.index)
        this.renderPatch()
      }
      row.addEventListener('click', toggle)
      row.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          toggle()
        }
      })
    }
    return row
  }

  // ------------------------------------------------------------ operations

  private pick(paths: string[]): Promise<void> {
    return this.ctx.run(
      () => backend().git.pick(this.ctx.root(), paths),
      paths.length ? 'Picked. Nothing is saved yet.' : 'Picked everything. Nothing is saved yet.'
    )
  }

  private unpick(paths: string[]): Promise<void> {
    return this.ctx.run(
      () => backend().git.unpick(this.ctx.root(), paths),
      'Taken back out. Your files were not touched.'
    )
  }

  /** One block, whichever way the side it is on implies. */
  private applyHunk(patch: FilePatch, hunk: Hunk): Promise<void> {
    return this.applyLines(patch, [hunk], new Set(hunkLineIndices(hunk)))
  }

  private applyTicked(hunks: readonly Hunk[]): Promise<void> {
    const patch = this.patch
    if (!patch) return Promise.resolve()
    // Only the blocks with something ticked in them: a block that contributes
    // nothing but context is a block git has to check and can only reject.
    const touched = hunks.filter((h) => h.lines.some((l) => this.ticked.has(l.index)))
    return this.applyLines(patch, touched, new Set(this.ticked))
  }

  private async applyLines(patch: FilePatch, hunks: readonly Hunk[], lines: Set<number>): Promise<void> {
    const side = this.selected?.side ?? 'changed'
    const direction = side === 'picked' ? 'unpick' : 'pick'
    const built = buildPatch(patch, hunks, lines, direction)
    if (!built) return

    const count = lines.size
    await this.ctx.run(
      () => backend().git.applyLines(this.ctx.root(), built, direction),
      direction === 'pick'
        ? `${count} line${count === 1 ? '' : 's'} picked. Nothing is saved yet.`
        : `${count} line${count === 1 ? '' : 's'} taken back out. Your file was not touched.`
    )
    // The ticks named lines in a patch that has just been refetched, and the
    // same numbers now mean different lines. The shell forces the redraw that
    // refetches it — picking part of a file leaves the porcelain letters
    // unchanged, so nothing else would notice anything had happened.
    this.ticked.clear()
  }

  private async save(): Promise<void> {
    const message = this.messageEl.value.trim()
    if (!message) return
    await this.ctx.run(async () => {
      const res = await backend().git.save(this.ctx.root(), message)
      // Only cleared on success: a message thrown away because git refused for
      // a reason you then fixed is a message you have to write again.
      if (res.ok) this.messageEl.value = ''
      return res
    }, 'Saved — on this machine. Nowhere else has it until you send it.')
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
    await this.ctx.run(() => backend().git.send(this.ctx.root()), `Sent. Your saves are on ${where}.`)
  }

  private async undoLastSave(): Promise<void> {
    const status = this.snapshot?.status
    const last = status?.lastSave
    if (!last) return
    const ok = await confirmDialog({
      title: `Undo the save "${last.subject}"?`,
      body:
        'Every file stays exactly as it is on disk — not one character changes. What the save held goes back to being picked, ' +
        'ready to be saved again with a different message or split into two. ' +
        'This is git reset --soft, and it is the reversible one: the --hard you will find online deletes the work, and this pane does not offer it.',
      confirmLabel: 'Undo the save',
    })
    if (!ok) return
    await this.ctx.run(
      () => backend().git.undoLastSave(this.ctx.root()),
      'Undone. Your files are untouched and the changes are picked again.'
    )
  }

  private async amend(): Promise<void> {
    const status = this.snapshot?.status
    const last = status?.lastSave
    if (!last) return
    const message = this.messageEl.value.trim()
    const ok = await confirmDialog({
      title: `Add this to "${last.subject}"?`,
      body:
        'What is picked goes into the save that already exists rather than into a new one, so the two changes end up as one. ' +
        (message
          ? `Its message becomes "${message}".`
          : 'Its message stays as it is — leave the box empty to keep it, or type to replace it.') +
        ' Only offered while the save has not left this machine.',
      confirmLabel: 'Add to it',
    })
    if (!ok) return
    await this.ctx.run(async () => {
      const res = await backend().git.amend(this.ctx.root(), message)
      if (res.ok) this.messageEl.value = ''
      return res
    }, 'Added. It is one save, not two.')
  }

  // ------------------------------------------------------------- save box

  /**
   * Relabels the save box for what is currently true.
   *
   * Labels rather than a rebuild, because this runs on every keystroke in the
   * message and on every poll, and because the message box has to survive both.
   */
  private updateFoot(): void {
    const status = this.snapshot?.status
    this.footEl.hidden = !status?.root

    const picked = status?.files.filter((f) => f.picked && !f.conflicted).length ?? 0
    const conflicts = status?.files.some((f) => f.conflicted) ?? false
    const hasMessage = this.messageEl.value.trim().length > 0
    const busy = this.ctx.busy()

    this.saveLabel.textContent = picked ? `Save ${picked} picked file${picked === 1 ? '' : 's'}` : 'Save'
    this.saveBtn.disabled = busy || picked === 0 || !hasMessage || conflicts || !!status?.inProgress

    const ahead = status?.ahead ?? 0
    const where = hostLabel(this.snapshot?.remote)
    this.sendLabel.textContent = ahead ? `Send ${ahead} save${ahead === 1 ? '' : 's'} to ${where}` : `Send to ${where}`
    this.sendBtn.disabled =
      busy || !status?.hasRemote || (ahead === 0 && !!status?.upstream) || !!status?.inProgress

    this.footNoteEl.replaceChildren()
    if (status?.inProgress) {
      this.footNoteEl.textContent = `A ${status.inProgress} stopped part-way and is waiting. Finish it in the terminal beside this pane first — saving now would mean something else.`
    } else if (conflicts) {
      this.footNoteEl.textContent =
        'Sort the files git is asking about first. Nothing is lost while they sit there.'
    } else if (picked && !hasMessage) {
      this.footNoteEl.textContent = 'A save needs a line saying what it is.'
    } else if (picked) {
      this.footNoteEl.append(text('Saving keeps it on this machine only — that is all a '))
      this.footNoteEl.appendChild(gitWordFirst('commit'))
      this.footNoteEl.append(text(' is. Sending is the step that puts it somewhere else.'))
    } else if (ahead) {
      this.footNoteEl.textContent = `${ahead} save${ahead === 1 ? '' : 's'} here that ${where} has not got.`
    } else {
      this.footNoteEl.textContent = ''
    }

    this.renderUndo(status, picked, busy)
  }

  /**
   * The two ways back, shown only while they are honest.
   *
   * Both are hidden outright once the last save has been sent, rather than
   * shown and disabled: a greyed button invites a hunt for the way to enable
   * it, and the answer here is that there is deliberately no way — the
   * operation that would do it anyway is a rewrite, and it lives in the
   * terminal where it reads as one.
   */
  private renderUndo(status: RepoStatus | undefined, picked: number, busy: boolean): void {
    this.undoRow.replaceChildren()
    const last = status?.lastSave
    if (!last || status?.inProgress) return
    const sent = !!status?.hasRemote && !status.unsent.includes(last.sha)
    if (sent) return

    const label = document.createElement('span')
    label.className = 'diff-foot__undo-label'
    label.textContent = `Last save: “${truncate(last.subject, 48)}” — not sent yet, so it can still be changed:`
    this.undoRow.appendChild(label)

    const undo = gitButton('Undo it, keep my files', 'git reset --soft HEAD~1', { className: 'diff-btn' })
    undo.title = 'Takes the save back. Every file stays exactly as it is, and what it held becomes picked again.'
    undo.disabled = busy
    undo.addEventListener('click', () => void this.undoLastSave())
    this.undoRow.appendChild(undo)

    const add = gitButton('Add what is picked to it', 'git commit --amend', { className: 'diff-btn' })
    add.title = picked
      ? 'Folds what is picked into that save instead of making a second one.'
      : 'Nothing is picked, so there is nothing to add to it yet.'
    add.disabled = busy || picked === 0
    add.addEventListener('click', () => void this.amend())
    this.undoRow.appendChild(add)
  }

  dispose(): void {
    this.disposed = true
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
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
