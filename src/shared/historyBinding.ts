/**
 * Which shells can walk our command history themselves, and which need helping.
 *
 * Recalling a command means replacing whatever is on the prompt, and there are
 * only two ways to do that. The line editor inside the shell — PSReadLine,
 * readline, ZLE — owns the line and can replace it exactly. Everything outside
 * the shell can only write bytes that look like typing, and must first send
 * whatever keystroke that particular editor reads as "clear this line", which
 * differs per shell, per edit mode, and is ambiguous in the case of Escape.
 *
 * So the shells we already inject an integration script into bind the arrows
 * themselves and do it properly; the rest fall back to the keystroke route in
 * `paneHistory.ts`, which is fragile but is the only thing available there.
 *
 * The list is the one in `resources/shells.json` with a non-`none` integration,
 * repeated here because the renderer decides whether to intercept a keypress
 * and cannot read that file. Both must change together; there are four entries
 * and they change roughly never.
 */
import type { ShellKind } from './types'

const BINDS: readonly ShellKind[] = ['powershell', 'pwsh', 'bash', 'zsh']

/**
 * Whether this pane's shell will handle the arrows on its own.
 *
 * False also when integration is switched off, because the script that does the
 * binding is the same script that never gets sourced — and a pane with no
 * integration has no recorded commands to walk anyway, since `133;E` is what
 * records them.
 */
export function shellBindsHistory(shell: ShellKind, integrationOn: boolean): boolean {
  return integrationOn && BINDS.includes(shell)
}
