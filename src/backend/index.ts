import type { Backend } from './types'

/**
 * The active adapter is injected by the per-runtime entry point
 * (`entry.electron.ts`) rather than selected here, so a future entry point
 * bundle only ever pulls in the adapter it actually uses — the Electron build
 * pulls in only the host it belongs to.
 */
let instance: Backend | null = null

export function setBackend(b: Backend): void {
  instance = b
}

export function backend(): Backend {
  if (!instance) throw new Error('backend used before it was set')
  return instance
}

export type { Backend }
