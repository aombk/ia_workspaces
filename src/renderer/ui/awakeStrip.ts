/**
 * Whether an agent is holding this machine awake, said out loud.
 *
 * The feature it reports on is invisible by nature, and that is the whole
 * reason this exists. A wake lock that is working looks exactly like a wake
 * lock that is not: the machine simply carries on, which is also what it does
 * when nothing is holding it. The first time it matters is the morning you
 * find a job that stopped at midnight, or a battery that emptied overnight —
 * and by then the thing you needed to know was hours ago.
 *
 * So the rule here is **say the surprising things and stay quiet otherwise**.
 * Nothing running is not news. Being held awake is. Being *allowed to sleep
 * for a reason the user did not choose* — on battery under mains-only, or a
 * host that cannot block at all — is the most important news of the lot,
 * because that is the case where somebody has switched the feature on and is
 * expecting it to be doing something.
 */
import { backend } from '../../backend'
import type { PowerLockState } from '../../shared/powerLock'

/**
 * How often the verdict is asked for.
 *
 * Five seconds. It changes when an agent starts or stops and almost never
 * otherwise, so this is about how quickly the line agrees with reality rather
 * than about tracking anything. Cheap enough not to think about: one IPC round
 * trip returning four fields.
 */
const POLL_MS = 5000

const el = () => document.getElementById('sidebar-awake') as HTMLElement | null

/** What to say, or null to say nothing at all. */
function describe(state: PowerLockState): { text: string; title: string; warn: boolean } | null {
  if (!state.supported) {
    return {
      text: 'cannot hold this machine awake',
      title:
        'This host has no way to stop the machine suspending — on Linux that means no session ' +
        'manager to ask. The setting is on, but nothing is holding anything.',
      warn: true,
    }
  }

  if (state.hold) {
    const n = state.holding.length
    return {
      text: `holding awake — ${n === 1 ? 'one agent' : `${n} agents`} working`,
      title:
        'The machine will not suspend while this lasts. The screen still sleeps as usual — only ' +
        'the machine is kept up, and the hold goes the moment the work does.',
      warn: false,
    }
  }

  switch (state.reason) {
    case 'battery':
      // The case that sends people to the power logs. Somebody set this to
      // "only on mains", unplugged, and is still expecting to be held awake.
      return {
        text: 'not holding — on battery',
        title:
          'Keep-awake is set to mains only, and this machine is on battery, so it may sleep. ' +
          'Set it to Always if a job should survive being unplugged.',
        warn: true,
      }
    case 'stale':
      // Not "idle". A pane still claims to be working and has said nothing for
      // five minutes, which usually means an agent died without saying so.
      return {
        text: 'not holding — an agent went quiet',
        title:
          'A pane still says it is working but has not reported for five minutes, so it has ' +
          'stopped counting. That is usually an agent that ended without saying so.',
        warn: true,
      }
    // Switched off, or simply nothing running. Neither is news.
    default:
      return null
  }
}

async function sync(): Promise<void> {
  const host = el()
  if (!host) return
  let state: PowerLockState
  try {
    state = await backend().powerLock()
  } catch {
    // A host with no such call at all. Silence is the right answer — this line
    // is an explanation, and it has nothing to explain.
    host.hidden = true
    return
  }

  const said = describe(state)
  if (!said) {
    host.hidden = true
    host.textContent = ''
    return
  }
  host.hidden = false
  host.className = said.warn ? 'sidebar-awake warn' : 'sidebar-awake'
  host.textContent = said.text
  host.title = said.title
}

export function initAwakeStrip(): void {
  void sync()
  const timer = setInterval(() => void sync(), POLL_MS)
  // Never the reason the app stays up, and never a reason a reload leaks one.
  window.addEventListener('beforeunload', () => clearInterval(timer))
}
