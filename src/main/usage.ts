/**
 * Claude Code's own usage limits, read from the account that Claude Code is
 * already signed in as.
 *
 * The numbers are not on disk anywhere — Claude Code renders `/usage` from live
 * API responses and keeps nothing — so this asks the same endpoint, using the
 * OAuth token already sitting in `~/.claude/.credentials.json`. Nothing is
 * stored, nothing is sent anywhere else, and the token never leaves the machine
 * except to Anthropic, which issued it.
 *
 * Failure is always soft. A monitor that cannot reach the network, or is signed
 * out, or is on a plan with no metering, should show that it does not know —
 * never a plausible number.
 */
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
  let token: string
  try {
    const raw = await readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth ?? parsed
    token = oauth?.accessToken
    if (!token) return { status: 'signed-out', buckets: [] }
    // Expiry is checked here rather than left to a 401, so "your login has
    // aged out" reads differently from "the request failed".
    if (oauth.expiresAt && Number(oauth.expiresAt) < Date.now()) {
      return { status: 'expired', buckets: [] }
    }
  } catch {
    return { status: 'signed-out', buckets: [] }
  }

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
