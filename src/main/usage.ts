/**
 * Claude Code's own usage limits, read from the account that Claude Code is
 * already signed in as.
 *
 * The numbers are not on disk anywhere — Claude Code renders `/usage` from live
 * API responses and keeps nothing — so this asks the same endpoint, using the
 * OAuth token Claude Code is already signed in with. Nothing is stored, nothing
 * is sent anywhere else, and the token never leaves the machine except to
 * Anthropic, which issued it.
 *
 * Where that token lives depends on the platform, and getting this wrong is why
 * the panel reported every Mac as signed out no matter how signed in it was.
 * Linux and WSL keep it in `~/.claude/.credentials.json`. **macOS does not** —
 * it is in the login keychain, under the service `Claude Code-credentials`, and
 * the file the old code looked for was never going to exist there. See
 * `readKeychain`, and note that reading it is a thing the user has to allow
 * once, because the keychain item belongs to Claude Code and not to us.
 *
 * Failure is always soft. A monitor that cannot reach the network, or is signed
 * out, or is on a plan with no metering, should show that it does not know —
 * never a plausible number.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { UsageBucket, UsageReport } from '../shared/types'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** The header the OAuth-token flow requires; without it the call is refused. */
const OAUTH_BETA = 'oauth-2025-04-20'
const TIMEOUT_MS = 8000

/** Buckets we surface, in the order the panel shows them. */
const BUCKETS = [
  ['fiveHour', 'five_hour', '5-hour session'],
  ['sevenDay', 'seven_day', '7-day total'],
  ['sevenDayOpus', 'seven_day_opus', '7-day Opus'],
] as const

export async function readClaudeUsage(): Promise<UsageReport> {
  const credentials = await readCredentials()
  if (credentials.status !== 'ok') return { status: credentials.status, buckets: [] }
  const { token, expiresAt } = credentials
  // Expiry is checked here rather than left to a 401, so "your login has aged
  // out" reads differently from "the request failed".
  if (expiresAt && expiresAt < Date.now()) return { status: 'expired', buckets: [] }

  try {
    const response = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) {
      return { status: response.status === 401 ? 'expired' : 'error', buckets: [] }
    }
    const body = (await response.json()) as Record<string, unknown>

    const buckets: UsageBucket[] = []
    for (const [id, key, label] of BUCKETS) {
      const raw = body[key] as { utilization?: number; resets_at?: string } | null | undefined
      // A plan without this meter reports nothing for it. Absent is not zero,
      // so it is left out rather than drawn as an empty bar.
      if (!raw || typeof raw.utilization !== 'number') continue
      buckets.push({
        id,
        label,
        percent: Math.round(raw.utilization * 10) / 10,
        resetsAt: raw.resets_at ?? null,
      })
    }
    return { status: buckets.length ? 'ok' : 'unmetered', buckets }
  } catch {
    return { status: 'error', buckets: [] }
  }
}

/**
 * The keychain service Claude Code stores its login under, on macOS.
 *
 * It does not use `~/.claude/.credentials.json` there — that is the Linux and
 * WSL spelling — and reading only the file is why this reported every Mac as
 * signed out however logged in it was. Both are checked, in the order that
 * makes the common case free: the file needs one `stat`, the keychain needs a
 * process.
 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
/** Long enough for a keychain that has to ask, short enough not to wedge a poll. */
const KEYCHAIN_TIMEOUT_MS = 20_000

type Credentials =
  | { status: 'ok'; token: string; expiresAt: number | null }
  | { status: 'signed-out' | 'locked' }

/**
 * Whether the keychain has already refused, for this run of the app.
 *
 * The poll comes round every five minutes, and a permission dialog that comes
 * back every five minutes is not a monitor, it is a hostage situation. One
 * refusal is taken as an answer until the app is restarted — or until the user
 * asks again, which is what `forgetKeychainRefusal` is for.
 */
let keychainRefused = false

/** Called when the user explicitly asks to try the keychain again. */
export function forgetKeychainRefusal(): void {
  keychainRefused = false
}

async function readCredentials(): Promise<Credentials> {
  const fromFile = await readCredentialsFile()
  if (fromFile) return fromFile
  if (process.platform !== 'darwin') return { status: 'signed-out' }
  return readKeychain()
}

async function readCredentialsFile(): Promise<Credentials | null> {
  try {
    const raw = await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
    return parseCredentials(raw)
  } catch {
    // No file is not an answer on macOS, where there was never going to be one.
    return null
  }
}

/**
 * Claude Code's login out of the login keychain.
 *
 * Two calls rather than one, and the split is the whole point. Asking for the
 * *password* triggers a permission dialog, because the keychain item's access
 * list names Claude Code and this is not Claude Code. Asking for the item's
 * **attributes** does not — no `-w`, no secret, no prompt. So existence is
 * established silently first, which is what lets a machine that has simply
 * never had Claude Code installed report "signed out" without a dialog box
 * appearing to ask about a program that is not there.
 *
 * The dialog the second call raises is the one worth granting: "Always Allow"
 * answers it once and for good. Refusing is remembered — see `keychainRefused`.
 */
async function readKeychain(): Promise<Credentials> {
  if (keychainRefused) return { status: 'locked' }

  const present = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE])
  if (present === null) return { status: 'signed-out' }

  const secret = await security(['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])
  if (secret === null) {
    // Dismissed, or denied. Either way, stop asking.
    keychainRefused = true
    return { status: 'locked' }
  }

  return parseCredentials(secret) ?? { status: 'signed-out' }
}

/** `security`, answering with its stdout or null for any refusal at all. */
function security(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/security',
      args,
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/**
 * The credential blob, in either of the two places it is kept.
 *
 * One shape, because it is one shape: the keychain holds the same JSON the file
 * would have held. Nothing here is logged or returned beyond the token itself
 * and its expiry — the blob also carries a refresh token, which nothing in this
 * app has any business touching.
 */
function parseCredentials(raw: string): Credentials | null {
  try {
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth ?? parsed
    const token = oauth?.accessToken
    if (typeof token !== 'string' || !token) return null
    const expires = Number(oauth?.expiresAt)
    return { status: 'ok', token, expiresAt: Number.isFinite(expires) ? expires : null }
  } catch {
    return null
  }
}
