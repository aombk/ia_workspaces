import type { SoundName } from '../shared/types'

/**
 * Notification sounds are synthesised with Web Audio rather than shipped as
 * audio files: no assets to bundle, no codec questions, and identical output
 * in the packaged app as well as in a dev run.
 */

let ctx: AudioContext | null = null

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext()
  // Autoplay policy can leave the context suspended until a user gesture.
  if (ctx.state === 'suspended') void ctx.resume()
  return ctx
}

interface Tone {
  freq: number
  /** Seconds from the start of the sound. */
  at: number
  duration: number
  gain: number
  type?: OscillatorType
}

const VOICES: Record<SoundName, Tone[]> = {
  // Soft two-note bell — the default; reads as "done" without being sharp.
  chime: [
    { freq: 880, at: 0, duration: 0.5, gain: 1 },
    { freq: 1318.5, at: 0.11, duration: 0.6, gain: 0.85 },
  ],
  // Single short blip for people who find two notes fussy.
  ping: [{ freq: 1046.5, at: 0, duration: 0.35, gain: 1 }],
  // Low muted double-tap; carries under music without piercing.
  knock: [
    { freq: 320, at: 0, duration: 0.22, gain: 1, type: 'triangle' },
    { freq: 300, at: 0.14, duration: 0.26, gain: 0.9, type: 'triangle' },
  ],
  // Rising three-note figure for "needs your attention".
  rise: [
    { freq: 659.3, at: 0, duration: 0.3, gain: 0.9 },
    { freq: 880, at: 0.1, duration: 0.32, gain: 0.9 },
    { freq: 1174.7, at: 0.2, duration: 0.45, gain: 0.85 },
  ],
}

export function playSound(name: SoundName, volume: number): void {
  const tones = VOICES[name] ?? VOICES.chime
  const vol = Math.max(0, Math.min(1, volume))
  if (vol === 0) return

  try {
    const ac = audio()
    const now = ac.currentTime
    const master = ac.createGain()
    master.gain.value = vol * 0.35
    master.connect(ac.destination)

    for (const tone of tones) {
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = tone.type ?? 'sine'
      osc.frequency.value = tone.freq

      const start = now + tone.at
      const end = start + tone.duration
      // Percussive envelope: fast attack, exponential decay. Ramping to a tiny
      // value rather than 0 because exponential ramps can't reach zero.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(tone.gain, start + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, end)

      osc.connect(gain)
      gain.connect(master)
      osc.start(start)
      osc.stop(end + 0.02)
    }
  } catch {
    /* audio is a nicety — never let it break the terminal */
  }
}

export const SOUND_OPTIONS: { value: SoundName; label: string }[] = [
  { value: 'chime', label: 'Chime' },
  { value: 'ping', label: 'Ping' },
  { value: 'knock', label: 'Knock' },
  { value: 'rise', label: 'Rise' },
]
