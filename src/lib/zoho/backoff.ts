export const BACKOFF_BASE_MS = 500
export const BACKOFF_CAP_MS = 8_000

/**
 * Full-jitter exponential backoff: a uniform draw from [0, min(cap, base * 2^attempt)].
 *
 * Full jitter rather than fixed delay because every user of this app hits the same Zoho
 * tenant — synchronised retries are what turn one 429 into a thundering herd.
 *
 * @param attempt zero-based retry number
 * @param random   injectable source of [0, 1) for deterministic tests
 */
export function backoffDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
  return Math.floor(random() * ceiling)
}

/** Honour `Retry-After` when Zoho sends one; seconds or an HTTP date. */
export function retryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | null {
  const value = header?.trim()
  if (!value) return null

  // Numeric forms are delay-seconds. Handle them exclusively: `Date.parse('-5')` happens to
  // succeed, so falling through would silently reinterpret a negative delay as a date.
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return seconds >= 0 ? Math.floor(seconds * 1000) : null
  }

  const date = Date.parse(value)
  if (Number.isNaN(date)) return null
  return Math.max(0, date - now)
}
