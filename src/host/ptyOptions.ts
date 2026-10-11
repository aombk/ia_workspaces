/**
 * Which pseudoconsole a Windows shell gets.
 *
 * The one built into Windows 10 is years behind the one Windows Terminal ships,
 * and a full-screen TUI finds every gap: it drops the faint attribute (so dim
 * text arrives at full brightness), swallows mouse reports (so a program that
 * scrolls itself never hears the wheel), and repaints from its own copy of the
 * screen, which leaves stray cells behind when a program redraws only what it
 * believes changed. node-pty carries the newer `conpty.dll` and `OpenConsole.exe`
 * in its prebuilds, and this is the switch that uses them.
 *
 * `IAW_SYSTEM_CONPTY=1` goes back to the inbox one, for the day the bundled copy
 * is the thing misbehaving. Kept out of `hostEntry.ts` so it can be tested
 * without loading the native module.
 *
 * Every other platform has a real pty and nothing to choose, so this is false
 * there whatever the environment says.
 */
export function useBundledConpty(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== 'win32') return false
  return env.IAW_SYSTEM_CONPTY !== '1'
}
