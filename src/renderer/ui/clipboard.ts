import { showToast } from './toast'

/**
 * Puts text on the clipboard and says so.
 *
 * The toast is the whole point: a clipboard write is silent, and "did that
 * copy?" is the question every menu item like this leaves behind. `note` is
 * what the toast shows — the text itself when it is a path or a name, a
 * summary when the text is a paragraph nobody wants read back at them.
 */
export async function copyText(text: string, note = text): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    showToast('Copied', note)
  } catch {
    showToast('Could not copy', '', { kind: 'error' })
  }
}
