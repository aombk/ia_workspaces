/**
 * Encrypting what goes into the shared folder, for the one payload that needs it.
 *
 * Relay's state records are counts, branch names and the paths of files git
 * already tracks — awkward to leak, not dangerous. Command lines are a
 * different thing entirely:
 *
 *     curl -H "Authorization: Bearer sk-…"
 *     psql postgres://user:hunter2@host/db
 *
 * Those go into somebody's cloud storage, and into that provider's version
 * history, and cannot be taken back. So commands are never written in the clear.
 *
 * **A passphrase, not the machine's keychain.** Electron's `safeStorage` uses
 * DPAPI on Windows and the Keychain on macOS, and both are *per machine* — a
 * file encrypted on the desktop would be undecryptable on the laptop, which is
 * the entire point of putting it in a shared folder. Sharing needs a shared
 * secret, and the only one a person can carry to three machines is something
 * they type. `safeStorage` still earns its place: it protects the passphrase
 * where it rests on each machine, which is a different job.
 *
 * **AES-256-GCM.** Authenticated, so a file altered in the folder fails to
 * decrypt rather than decrypting into something else. `scrypt` derives the key,
 * with a per-file random salt and nonce.
 *
 * What this does not protect, stated plainly because a half-understood
 * guarantee is worse than none:
 *
 * - **Metadata.** File sizes, timestamps, machine ids and project keys are all
 *   in the clear. The project key is a hash of your remote URL — not reversible,
 *   but a stable identifier that says two machines work on the same thing.
 * - **Your own machines.** The plaintext is still in `command-history.json`
 *   locally. This is about the folder, not the disk.
 * - **Anything already published.** Turning this on does not retract what went
 *   out before it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, scryptSync } from 'node:crypto'

/** Marks a file as ours and says which format it is, so a future one can differ. */
const MAGIC = 'iaw1'

const SALT_BYTES = 16
const NONCE_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16

/**
 * scrypt cost. The default N=16384 with r=8 is a few tens of milliseconds.
 *
 * Deliberately not tuned higher. This runs once per file written or read, and
 * the threat it defends against — somebody with the folder guessing the
 * passphrase — is answered far better by a passphrase worth having than by
 * making our own writes slow.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/**
 * Keys already derived, by salt and passphrase.
 *
 * Every machine's file keeps its salt until that machine rewrites it, and the
 * relay sweep reads every file every minute — so without this the same
 * derivation, tens of milliseconds of deliberately expensive work, ran again
 * for the same inputs on every pass. Keyed on a hash of the passphrase rather
 * than the passphrase itself only so the map's keys are not a second copy of
 * it; the value is the derived key either way. Small and bounded: one entry
 * per file in the share is the whole working set.
 */
const KEY_CACHE_MAX = 256
const keyCache = new Map<string, Buffer>()
let derivations = 0

function cacheKey(passphrase: string, salt: Buffer): string {
  return `${salt.toString('hex')}:${createHash('sha256').update(passphrase).digest('hex')}`
}

function remember(id: string, key: Buffer): Buffer {
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value as string)
  keyCache.set(id, key)
  return key
}

function deriveSync(passphrase: string, salt: Buffer): Buffer {
  const id = cacheKey(passphrase, salt)
  const hit = keyCache.get(id)
  if (hit) return hit
  derivations++
  return remember(id, scryptSync(passphrase, salt, KEY_BYTES, SCRYPT))
}

/** The same, on the thread pool rather than the main thread. */
function derive(passphrase: string, salt: Buffer): Promise<Buffer> {
  const id = cacheKey(passphrase, salt)
  const hit = keyCache.get(id)
  if (hit) return Promise.resolve(hit)
  derivations++
  return new Promise((resolve, reject) =>
    scrypt(passphrase, salt, KEY_BYTES, SCRYPT, (err, key) => (err ? reject(err) : resolve(remember(id, key))))
  )
}

/** How many scrypt derivations have actually run. For tests. */
export function keyDerivations(): number {
  return derivations
}

/**
 * Encrypts a string, salt and nonce included, as one base64 blob.
 *
 * Everything needed to decrypt except the passphrase travels with the
 * ciphertext, because the alternative is a second file to keep beside the first
 * and a way for the two to be separated.
 */
export function seal(plaintext: string, passphrase: string): string {
  const salt = randomBytes(SALT_BYTES)
  const nonce = randomBytes(NONCE_BYTES)
  // A fresh salt is never in the cache, so this is always a real derivation;
  // it goes through the cache anyway so reading our own file back is free.
  const key = deriveSync(passphrase, salt)

  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  return `${MAGIC}.${Buffer.concat([salt, nonce, tag, body]).toString('base64')}`
}

/**
 * Decrypts what `seal` produced, or answers null.
 *
 * Null covers every way this can fail and they are all ordinary: a machine
 * whose passphrase does not match, a file half-written by a sync client, a
 * format from a future version. None of them is exceptional and none should
 * cost the caller its other files, so this never throws.
 */
export function unseal(blob: string, passphrase: string): string | null {
  const parts = split(blob)
  if (!parts) return null
  try {
    return open(parts, deriveSync(passphrase, parts.salt))
  } catch {
    return null
  }
}

/**
 * `unseal`, with the key derived off the main thread.
 *
 * For the relay sweep, which reads every machine's file in Electron's main
 * process: tens of milliseconds of scrypt each, synchronously, is a frozen
 * window for as long as the share has files.
 */
export async function unsealAsync(blob: string, passphrase: string): Promise<string | null> {
  const parts = split(blob)
  if (!parts) return null
  try {
    return open(parts, await derive(passphrase, parts.salt))
  } catch {
    return null
  }
}

interface Sealed {
  salt: Buffer
  nonce: Buffer
  tag: Buffer
  body: Buffer
}

function split(blob: string): Sealed | null {
  if (!blob.startsWith(`${MAGIC}.`)) return null
  const raw = Buffer.from(blob.slice(MAGIC.length + 1), 'base64')
  if (raw.length <= SALT_BYTES + NONCE_BYTES + TAG_BYTES) return null
  let at = 0
  const salt = raw.subarray(at, (at += SALT_BYTES))
  const nonce = raw.subarray(at, (at += NONCE_BYTES))
  const tag = raw.subarray(at, (at += TAG_BYTES))
  return { salt, nonce, tag, body: raw.subarray(at) }
}

function open(parts: Sealed, key: Buffer): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, parts.nonce)
    decipher.setAuthTag(parts.tag)
    return Buffer.concat([decipher.update(parts.body), decipher.final()]).toString('utf8')
  } catch {
    // A wrong passphrase fails here, as an authentication-tag mismatch, which
    // is exactly the same outcome as a corrupted file and is meant to be.
    return null
  }
}

/**
 * Removes the secrets people put on command lines, before one is published.
 *
 * Best-effort and said so everywhere it is offered. This catches the shapes
 * that recur — a bearer token, a password in a connection string, an obvious
 * `--token=` flag — and it cannot catch a secret that looks like an ordinary
 * argument, because nothing can. It is a second line of defence behind the
 * encryption, not a reason to trust the folder.
 *
 * Replaced rather than dropped: a command with `--token=…` still tells you what
 * to run, and a command with the flag removed tells you something that would
 * fail.
 */
export function redact(command: string): string {
  return (
    command
      // user:password@host, in any URL-ish argument.
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, '$1:•••@')
      // Authorization headers and bearer tokens, quoted or not.
      .replace(/\b(bearer|token|apikey|api[-_]?key)\s+[^\s'"]+/gi, '$1 •••')
      // --token=…, --password …, -p…, and the rest of that family.
      .replace(
        /(--?(?:token|password|passwd|pass|secret|api[-_]?key|auth)[= ])(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
        '$1•••'
      )
      // Anything that is unmistakably a key by its own shape.
      .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,})\b/g, '•••')
      // An environment assignment of something named like a secret.
      .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY)[A-Z0-9_]*)=(\S+)/g, '$1=•••')
  )
}
