/**
 * What the Git pane's two halves have in common.
 *
 * The pane owns the things that are true of the repository rather than of one
 * view — the poll, the "where is your work" band, the busy lock, the way an
 * operation reports itself — and hands each view a context to reach them
 * through. So a view never runs a timer, never shows its own toast for a
 * failure, and cannot disagree with the other about what the branch is called.
 */
import type { GitResult } from '../../shared/types'
import type { RepoSnapshot } from './repoWatch'

export interface GitView {
  readonly element: HTMLElement
  /** A new answer from git. Null while the folder is not a repository. */
  update(snapshot: RepoSnapshot | null): void
  /** This view just became the visible one. */
  activate?(): void
  dispose(): void
}

export interface GitContext {
  paneId: string
  /** The folder being watched — the repository root once there is one. */
  root(): string
  /** True while an operation is in flight and every button should be dead. */
  busy(): boolean
  /**
   * Runs one operation with the pane locked, reports it, and refreshes.
   *
   * Every button in both views goes through this, which is why neither of them
   * contains a toast: git's own message and the plain sentence beside it are
   * composed in one place, so they cannot drift into two house styles.
   *
   * `label` is what the progress bar says before git has said anything — the
   * first second of a push, where there is no percentage yet and "working…"
   * would say less than the caller already knows. Present tense, no full stop:
   * it sits beside a number.
   */
  run(work: () => Promise<GitResult>, success: string, label: string): Promise<void>
  /** Opens the panel that puts this project online. */
  openPublish(): void
  /** Switches to the other view, from a link in this one. */
  show(view: 'changes' | 'history'): void
  /** Shows the history of one file — the History view's filter, set from Changes. */
  showFileHistory(repoPath: string): void
}
