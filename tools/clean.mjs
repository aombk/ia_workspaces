import { rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Clears the intermediate and artifact folders.
 *
 * This used to spare `out/rust` — cargo's target directory, redirected there by
 * `src-tauri/.cargo/config.toml` — because wiping it threw away the compiled
 * form of a thousand crates to fix a stale bundle. Dropping the Tauri runtime
 * left that cache with nothing to rebuild for, so the exception went with it and
 * `out/` is once again a folder that can be deleted whole.
 */
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

for (const dir of ['out', 'build']) {
  rmSync(path.join(root, dir), { recursive: true, force: true })
}

console.log('[clean] removed out, build')
