/**
 * Turns however the user said a duration into decimal hours (task 5.2).
 *
 * Accepts `7.5`, `7,5`, `7:30`, `7h30`, `7h`, `90m`, `1h 30m`, `7 hours`. Rounds to the
 * nearest quarter hour and rejects anything outside 0.25–24 (CHAT-6).
 */

export const MIN_HOURS = 0.25
export const MAX_HOURS = 24
export const QUARTER = 0.25

export type HoursResolution =
  | { status: 'resolved'; hours: number }
  | { status: 'unresolved'; reason: 'missing' | 'unrecognised' }
  | { status: 'blocked'; reason: 'too_small' | 'too_large'; hours: number }

/** Round half away from zero, so 2h20 (2.333) → 2.25 and 2h23 (2.383) → 2.5. */
export function roundToQuarter(hours: number): number {
  return Math.round(hours / QUARTER) * QUARTER
}

function bound(hours: number): HoursResolution {
  const rounded = roundToQuarter(hours)
  if (rounded < MIN_HOURS)
    return { status: 'blocked', reason: 'too_small', hours: rounded }
  if (rounded > MAX_HOURS)
    return { status: 'blocked', reason: 'too_large', hours: rounded }
  // Kill float drift: 7.499999999 must serialise as 7.5.
  return { status: 'resolved', hours: Number(rounded.toFixed(2)) }
}

export function parseHours(input: string | number | null | undefined): HoursResolution {
  if (input === null || input === undefined || input === '') {
    return { status: 'unresolved', reason: 'missing' }
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { status: 'unresolved', reason: 'unrecognised' }
    return bound(input)
  }

  const text = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (text === '') return { status: 'unresolved', reason: 'missing' }

  // 7:30
  const colon = /^(\d{1,2}):([0-5]\d)$/.exec(text)
  if (colon) return bound(Number(colon[1]) + Number(colon[2]) / 60)

  // 7h30, 7h 30m, 7 hrs 30 mins, 7h
  const hm =
    /^(\d{1,2})\s*(?:h|hr|hrs|hour|hours)\s*(\d{1,2})?\s*(?:m|min|mins|minutes)?$/.exec(
      text,
    )
  if (hm) {
    const minutes = hm[2] === undefined ? 0 : Number(hm[2])
    if (minutes > 59) return { status: 'unresolved', reason: 'unrecognised' }
    return bound(Number(hm[1]) + minutes / 60)
  }

  // 90m, 45 mins
  const minutesOnly = /^(\d{1,4})\s*(?:m|min|mins|minute|minutes)$/.exec(text)
  if (minutesOnly) return bound(Number(minutesOnly[1]) / 60)

  // 7.5, 7,5, 7.5 hours
  const decimal = /^(\d{1,2})(?:[.,](\d{1,2}))?\s*(?:h|hr|hrs|hour|hours)?$/.exec(text)
  if (decimal) {
    const value = Number(`${decimal[1]}.${decimal[2] ?? '0'}`)
    if (!Number.isFinite(value)) return { status: 'unresolved', reason: 'unrecognised' }
    return bound(value)
  }

  return { status: 'unresolved', reason: 'unrecognised' }
}

/** Zoho Projects takes `hh:mm` on the write, and only there. */
export function toZohoHours(hours: number): string {
  const totalMinutes = Math.round(hours * 60)
  const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0')
  const mm = String(totalMinutes % 60).padStart(2, '0')
  return `${hh}:${mm}`
}
