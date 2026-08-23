/**
 * Coin prices, for the one block that is not about this machine or the sky.
 *
 * Same bargain as the weather: a panel you leave open beside your work is the
 * right place for the handful of things you would otherwise open a browser tab
 * to check. This is that, for anyone holding any.
 *
 * **CoinGecko, and no key.** Their `simple/price` endpoint answers an anonymous
 * caller, which is the whole reason it is the one used — a block that needs a
 * signup is a block most people never switch on. The rate limit for a caller
 * with no key is generous next to one request every few minutes, and the cache
 * below keeps it there however often the panel redraws.
 *
 * **Nothing is requested until the block is switched on.** Like the weather,
 * this talks to a third party, and it should not be possible to do so by
 * accident: the panel asks only while its crypto block is drawn.
 */
import type { CoinPrice, CryptoReading } from '../shared/types'

/**
 * How long an answer is kept.
 *
 * Two minutes. A price moves continuously and a panel is glanced at, so the
 * question is not "how fresh can this be" but "how often is it worth asking
 * somebody else's server" — and the difference between a two-minute-old price
 * and a live one is not a difference anybody watching a sidebar can act on.
 */
const TTL_MS = 2 * 60_000

/** Long enough for a slow connection, short enough that a dead one is not felt. */
const TIMEOUT_MS = 6000

/**
 * What CoinGecko calls the coins, since its ids are not their tickers.
 *
 * The ticker is what goes on screen and the id is what goes in the URL. Keeping
 * both here means the setting can be written the way people talk — `btc, eth` —
 * rather than the way an API wants it.
 */
const KNOWN: Record<string, { id: string; symbol: string }> = {
  btc: { id: 'bitcoin', symbol: 'BTC' },
  bitcoin: { id: 'bitcoin', symbol: 'BTC' },
  eth: { id: 'ethereum', symbol: 'ETH' },
  ethereum: { id: 'ethereum', symbol: 'ETH' },
  ltc: { id: 'litecoin', symbol: 'LTC' },
  litecoin: { id: 'litecoin', symbol: 'LTC' },
  xmr: { id: 'monero', symbol: 'XMR' },
  monero: { id: 'monero', symbol: 'XMR' },
  sol: { id: 'solana', symbol: 'SOL' },
  solana: { id: 'solana', symbol: 'SOL' },
  ada: { id: 'cardano', symbol: 'ADA' },
  cardano: { id: 'cardano', symbol: 'ADA' },
  doge: { id: 'dogecoin', symbol: 'DOGE' },
  dogecoin: { id: 'dogecoin', symbol: 'DOGE' },
}

let cache: { at: number; signature: string; value: CryptoReading } | null = null
let inFlight: Promise<CryptoReading> | null = null

/**
 * Turns what the user typed into what the API wants.
 *
 * Anything not in `KNOWN` is passed through as an id, so a coin nobody thought
 * to list still works if you know what CoinGecko calls it — and its ticker is
 * then the id in capitals, which is right far more often than it is wrong.
 */
export function parseCoins(list: string): Array<{ id: string; symbol: string }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; symbol: string }> = []
  for (const raw of list.split(/[,\s]+/)) {
    const name = raw.trim().toLowerCase()
    if (!name) continue
    const known = KNOWN[name] ?? { id: name, symbol: name.toUpperCase() }
    if (seen.has(known.id)) continue
    seen.add(known.id)
    out.push(known)
  }
  return out
}

/**
 * Every coin in one request, cached.
 *
 * One request rather than one per coin: `simple/price` takes a list, and asking
 * three times for three numbers is three times the rate limit for no gain. The
 * signature is the coins and the currency, so editing the setting refreshes at
 * once rather than at the end of the cache.
 */
export async function readCrypto(request: {
  coins: string
  currency: string
}): Promise<CryptoReading> {
  const now = Date.now()
  const coins = parseCoins(request.coins)
  const currency = (request.currency || 'usd').trim().toLowerCase()
  const signature = `${coins.map((c) => c.id).join(',')}|${currency}`

  if (!coins.length) return { coins: [], currency, at: now, error: 'no-coins' }
  if (cache && cache.signature === signature && now - cache.at < TTL_MS) return cache.value
  if (inFlight) return inFlight

  const url =
    'https://api.coingecko.com/api/v3/simple/price' +
    `?ids=${coins.map((c) => encodeURIComponent(c.id)).join(',')}` +
    `&vs_currencies=${encodeURIComponent(currency)}` +
    '&include_24hr_change=true'

  inFlight = fetchPrices(url, coins, currency)
    .then((value) => {
      cache = { at: Date.now(), signature, value }
      return value
    })
    .catch((err: unknown) => {
      // A failed lookup keeps the last good prices on screen rather than
      // blanking the block, the same way the weather does. A stale price is
      // still roughly the price; an empty row says the block is broken.
      const message = err instanceof Error ? err.message : String(err)
      if (cache?.signature === signature) return { ...cache.value, error: message }
      return { coins: [], currency, at: Date.now(), error: message }
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

async function fetchPrices(
  url: string,
  coins: Array<{ id: string; symbol: string }>,
  currency: string
): Promise<CryptoReading> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  // 429 is the one worth naming: it is what an anonymous caller gets for asking
  // too often, and it is fixed by waiting rather than by changing anything.
  if (response.status === 429) throw new Error('asked too often — CoinGecko is rate limiting')
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  const body = (await response.json()) as Record<string, Record<string, number>>

  const out: CoinPrice[] = []
  for (const coin of coins) {
    const entry = body[coin.id]
    if (!entry) continue
    const price = entry[currency]
    if (typeof price !== 'number') continue
    const change = entry[`${currency}_24h_change`]
    out.push({
      id: coin.id,
      symbol: coin.symbol,
      price,
      // Absent rather than zero when the field is missing: zero means the price
      // has not moved, which is a different thing from not being told.
      change24h: typeof change === 'number' ? change : null,
    })
  }
  return { coins: out, currency, at: Date.now() }
}
