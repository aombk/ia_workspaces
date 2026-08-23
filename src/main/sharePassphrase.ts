/**
 * The passphrase that encrypts commands for the shared folder, where it rests.
 *
 * Kept in this machine's own data folder and never in the shared one, which
 * would defeat the entire exercise. Never in `workspace.json` either: that file
 * is a document people copy between machines, paste into issues, and hand to
 * anyone debugging a layout problem.
 *
 * Encrypted at rest with Electron's `safeStorage` — DPAPI on Windows, the
 * Keychain on macOS — where it is available. That protects it from anything
 * reading the disk without being this user on this machine. It is not what
 * makes sharing work: `safeStorage` keys are per machine, so what is written
 * here can only be read back here, which is precisely why the passphrase itself
 * has to be typed on each machine rather than synced.
 *
 * Falls back to plain text on a system with no usable keychain — a headless
 * Linux box, typically. Written down in the file itself, so anybody looking at
 * it can see which it is rather than assuming the better one.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { safeStorage } from 'electron'

const FILE = 'share-passphrase.json'

interface Stored {
  /** `safe` means `safeStorage`; `plain` means this machine had no keychain. */
  how: 'safe' | 'plain'
  value: string
}

function file(dataDir: string): string {
  return path.join(dataDir, FILE)
}

/**
 * Stores a passphrase, or clears it when given nothing.
 *
 * Clearing removes the file rather than writing an empty one, because "no
 * passphrase" and "a passphrase that is the empty string" must not be the same
 * state — the first switches the feature off, and the second would encrypt
 * everything under a key anybody could derive.
 */
export function setSharePassphrase(dataDir: string, passphrase: string): boolean {
  const target = file(dataDir)
  try {
    if (!passphrase) {
      if (existsSync(target)) unlinkSync(target)
      return true
    }

    let stored: Stored
    if (safeStorage.isEncryptionAvailable()) {
      stored = { how: 'safe', value: safeStorage.encryptString(passphrase).toString('base64') }
    } else {
      stored = { how: 'plain', value: passphrase }
    }
    writeFileSync(target, JSON.stringify(stored), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * The passphrase, or empty when there is none.
 *
 * Empty is the answer for every failure too — an unreadable file, a keychain
 * that has forgotten the key after a password reset. Every caller treats empty
 * as "the feature is off", which is the safe direction: nothing gets published
 * unencrypted because the key could not be read.
 */
export function sharePassphrase(dataDir: string): string {
  try {
    const target = file(dataDir)
    if (!existsSync(target)) return ''
    const stored = JSON.parse(readFileSync(target, 'utf8')) as Stored
    if (!stored?.value) return ''
    if (stored.how === 'plain') return stored.value
    return safeStorage.decryptString(Buffer.from(stored.value, 'base64'))
  } catch {
    return ''
  }
}

/** Whether one is set, for a settings panel that must never show the thing itself. */
export function hasSharePassphrase(dataDir: string): boolean {
  return sharePassphrase(dataDir).length > 0
}
