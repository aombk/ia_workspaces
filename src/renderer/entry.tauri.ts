// The same app, started against the Rust host.
//
// Identical to `entry.electron.ts` but for the adapter it injects, which is the
// whole design: `src/backend/index.ts` is set once here and nothing downstream
// knows or asks which runtime it got.
import { setBackend } from '../backend'
import { createTauriBackend } from '../backend/tauri'
import { start } from './app'

setBackend(createTauriBackend())
void start()
