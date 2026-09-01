/**
 * Typing a line into a pane on the user's behalf, and saying so when it cannot
 * be done.
 *
 * Not to be confused with `paneHistory.putOnPrompt`, which is the arrow-key
 * recall: that one clears whatever is on the line first, because it is
 * *replacing* what you were typing. This one adds to it.
 *
 * Several features end the same way: the runbook, the command history, the
 * prompt explorer, a file dropped on a terminal, a process the ports pane
 * offers to end, the image-notes editor. Each one hands the user a line **typed and
 * not submitted** — the rule argued at length in `runbookPane.ts`, and the
 * reason none of them press Enter for you.
 *
 * What none of them used to do is notice when the line went nowhere. A pane can
 * have no shell to write to: one that has not finished starting, one whose
 * shell has exited, or one detached by a lost session host — and in every case
 * the write was silently discarded and the feature simply appeared not to work.
 * `PtyManager.write` reports which happened now, and this is the one place that
 * turns that into something a person can read.
 *
 * Deliberately not used by *typing*. A keystroke aimed at a pane whose shell
 * has gone should vanish; a toast per character would be the worst possible
 * reading of the same fact.
 */
import { backend } from '../../backend'
import { showToast } from './toast'

/**
 * Types `text` into the pane, without submitting it.
 *
 * Returns whether it landed, for the rare caller that wants to do something
 * else about it. Everything is already said to the user, so most can ignore it.
 */
export async function typeIntoPane(paneId: string | undefined, text: string): Promise<boolean> {
  if (!paneId) {
    showToast('No terminal to type into', 'Open or focus a terminal pane first.')
    return false
  }

  let landed = false
  try {
    landed = await backend().pty.write(paneId, text)
  } catch {
    landed = false
  }

  if (!landed) {
    // Three causes, one sentence. Which of them it was is not a distinction the
    // reader can act on differently — the answer is the same in all three, and
    // a pane detached by a lost host has already said so in its own scrollback.
    showToast(
      'That pane has no shell',
      'Nothing was typed. Its shell has ended, or has not started yet — open a new tab to get one.'
    )
  }
  return landed
}
