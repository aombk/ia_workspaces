/**
 * Which folders in a project are its tools' to put back.
 *
 * A project folder is mostly not the project. `node_modules`, a Rust `target`,
 * a CMake `build`, a Python `.venv` — each is the output of one command the
 * project already knows how to run, and together they are routinely nine
 * tenths of what the folder takes on disk. Deleting them loses nothing but the
 * time to run that command again.
 *
 * **A name alone is never enough.** A folder called `build` in a project with
 * no build system is somebody's notes about building; a `target` with no
 * `Cargo.toml` beside it is just a folder. Every rule names the file that has to
 * be next to it (or, for a virtualenv, inside it), and a folder that matches the
 * name without the marker is left alone.
 *
 * Pure, so both the measuring and the deleting can ask the same question —
 * the main process re-checks every path it is asked to delete against these
 * rules rather than taking the renderer's word that it is safe.
 */

export interface RegenerableRule {
  /** Matched against the folder's own name. */
  name: string | RegExp
  /** Files or folders one of which must sit beside it. Glob-free: exact names, or a `.ext` suffix. */
  beside?: readonly string[]
  /** A file that must be inside it. */
  inside?: string
  label: string
  suggested: boolean
}

const NODE = ['package.json']
const CMAKE = ['CMakeLists.txt']
const GRADLE = ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']
const XCODE = ['.xcodeproj', '.xcworkspace']

export const REGENERABLE_RULES: readonly RegenerableRule[] = [
  { name: 'node_modules', beside: NODE, label: 'npm install', suggested: true },
  { name: '.venv', inside: 'pyvenv.cfg', label: 'a new virtualenv', suggested: true },
  { name: 'venv', inside: 'pyvenv.cfg', label: 'a new virtualenv', suggested: true },
  { name: 'target', beside: ['Cargo.toml'], label: 'cargo build', suggested: true },
  { name: '.build', beside: ['Package.swift'], label: 'swift build', suggested: true },
  { name: 'build', beside: [...CMAKE, ...GRADLE, ...XCODE], label: 'a rebuild', suggested: true },
  { name: /^cmake-build-/, beside: CMAKE, label: 'a rebuild', suggested: true },
  { name: '.gradle', beside: GRADLE, label: 'gradle', suggested: true },
  { name: 'DerivedData', label: 'an Xcode build', suggested: true },
  { name: 'Pods', beside: ['Podfile'], label: 'pod install', suggested: true },
  { name: '.next', beside: NODE, label: 'a rebuild', suggested: true },
  { name: '.turbo', beside: NODE, label: 'a rebuild', suggested: true },
  { name: '.parcel-cache', beside: NODE, label: 'a rebuild', suggested: true },
  { name: '.svelte-kit', beside: NODE, label: 'a rebuild', suggested: true },
  // Output a web project builds, which is also where a packaged release ends
  // up. Offered, never ticked: the last installer you shipped may be the one
  // copy of it you have.
  { name: 'build', beside: NODE, label: 'a rebuild — may hold a release', suggested: false },
  { name: 'dist', beside: [...NODE, ...CMAKE, 'pyproject.toml', 'setup.py'], label: 'a rebuild — may hold a release', suggested: false },
  { name: 'out', beside: [...NODE, ...CMAKE], label: 'a rebuild — may hold a release', suggested: false },
]

/**
 * The rule a folder matches, or null.
 *
 * `siblings` are the names in the folder that contains it; `contents` is asked
 * for only when a rule needs to look inside, since reading every directory's
 * listing twice would double the cost of measuring a large project.
 */
export function matchRegenerable(
  name: string,
  siblings: readonly string[],
  hasInside: (file: string) => boolean
): RegenerableRule | null {
  for (const rule of REGENERABLE_RULES) {
    if (typeof rule.name === 'string' ? rule.name !== name : !rule.name.test(name)) continue
    if (rule.beside && !rule.beside.some((marker) => siblings.some((s) => markerMatches(marker, s)))) continue
    if (rule.inside && !hasInside(rule.inside)) continue
    return rule
  }
  return null
}

function markerMatches(marker: string, sibling: string): boolean {
  return marker.startsWith('.') && !marker.includes('.', 1) ? sibling.endsWith(marker) : sibling === marker
}

/**
 * The paths a project's `.devpark` file says to keep.
 *
 * One relative path per line; `#` starts a comment. The escape hatch for the
 * folder that matches a rule and must not go anyway — the `node_modules` some
 * other tool runs out of, the `dist` that is the release.
 */
export function parseKeepList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map(normRel)
}

/** Forward slashes, no leading `./`, no trailing slash. */
export function normRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/** Whether a relative path is listed, or sits inside something that is. */
export function isKept(rel: string, keep: readonly string[]): boolean {
  const at = normRel(rel)
  return keep.some((k) => at === k || at.startsWith(`${k}/`))
}

/**
 * How many commits a "keep the last N" may keep.
 *
 * Each kept commit is one `git commit-tree`, so the bound is on time rather
 * than on anything git cares about. Past it, "compact" is the right tool.
 */
export const MAX_KEPT_COMMITS = 5000
