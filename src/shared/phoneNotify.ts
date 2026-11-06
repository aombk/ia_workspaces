/**
 * Breaks on your phone — and from there on a watch or band paired with it —
 * through ntfy (https://ntfy.sh), an open-source push service: one HTTP POST
 * to a topic, and every phone subscribed to it in the ntfy app gets a
 * notification. A band that mirrors phone notifications buzzes with it.
 *
 * The setting is a bare topic name, which goes to the public ntfy.sh server,
 * or a whole address, for your own server. Anyone who knows a topic on the
 * public server can read it, so it should be long and random — what is sent
 * is only "get up" and "break over", but still.
 *
 * Pure, apart from `sendNtfy`, which only needs `fetch`.
 */

/** A topic as ntfy accepts one. */
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/

/** The address to post to, or null when the setting is blank or not usable. */
export function ntfyUrl(setting: string): string | null {
  const value = setting.trim()
  if (!value) return null
  if (TOPIC.test(value)) return `https://ntfy.sh/${value}`
  try {
    // `ntfy.sh/topic`, as the app shows a subscription, means https.
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (!TOPIC.test(url.pathname.replace(/^\/+|\/+$/g, ''))) return null
    return url.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

export interface NtfyMessage {
  title: string
  body: string
  /** ntfy's tags; known emoji names show as an icon on the phone. */
  tags?: string[]
}

/** Posts one message. Resolves to null when it was accepted, or a sentence saying why not. */
export async function sendNtfy(setting: string, message: NtfyMessage): Promise<string | null> {
  const url = ntfyUrl(setting)
  if (!url) return 'Not a topic name or an ntfy address.'
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: message.body,
      headers: {
        // Headers are ASCII only; the body carries anything else.
        Title: message.title.replace(/[^\x20-\x7e]/g, ''),
        // High: a heads-up notification, which is what a band buzzes for.
        Priority: '4',
        ...(message.tags?.length ? { Tags: message.tags.join(',') } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? null : `The server said ${res.status} ${res.statusText}.`
  } catch (err) {
    return `Could not reach it: ${(err as Error).message}`
  }
}
