/**
 * Calendar arithmetic on `YYYY-MM-DD` strings, with no `Date` object in sight.
 *
 * Every date question this app asks — "what was yesterday", "which Monday did they mean" —
 * is a question about a calendar, not about elapsed time. Doing it by subtracting
 * milliseconds from a UTC instant is what produces off-by-one-day bugs twice a year, because
 * the day a DST boundary falls on is 23 or 25 hours long. Working in civil days sidesteps
 * that entirely: the arithmetic here cannot be wrong at a DST boundary because it never
 * consults a clock.
 */

export type CivilDate = { year: number; month: number; day: number }

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Days from 1970-01-01 for a civil date. Howard Hinnant's `days_from_civil`. */
export function toEpochDay({ year, month, day }: CivilDate): number {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const mp = (month + 9) % 12
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** Inverse of {@link toEpochDay}. */
export function fromEpochDay(epochDay: number): CivilDate {
  const z = epochDay + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) /
      365,
  )
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  return { year: month <= 2 ? y + 1 : y, month, day }
}

export function parseIso(iso: string): CivilDate | null {
  const m = ISO_DATE.exec(iso)
  if (!m) return null
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) return null
  // Round-trip catches impossible days like 2026-02-30, which the range check misses.
  const round = fromEpochDay(toEpochDay(date))
  if (round.year !== date.year || round.month !== date.month || round.day !== date.day) {
    return null
  }
  return date
}

export function formatIso(date: CivilDate): string {
  const mm = String(date.month).padStart(2, '0')
  const dd = String(date.day).padStart(2, '0')
  return `${date.year}-${mm}-${dd}`
}

/** Zoho Projects wants `MM-DD-YYYY` at the API boundary, and only there. */
export function formatZoho(date: CivilDate): string {
  const mm = String(date.month).padStart(2, '0')
  const dd = String(date.day).padStart(2, '0')
  return `${mm}-${dd}-${date.year}`
}

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromEpochDay(toEpochDay(date) + days)
}

export function weekdayOf(date: CivilDate): Weekday {
  // 1970-01-01 was a Thursday (ISO 4).
  const dow = ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1
  return dow as Weekday
}

/**
 * The Sunday on or before this date.
 *
 * **Sunday, not Monday.** The portal's `startday_of_week` is `sunday`, and a week view that
 * disagreed with the grid people check their hours against would be worse than no week view:
 * the same seven days would show two different totals.
 */
export function startOfWeek(date: CivilDate): CivilDate {
  // `weekdayOf` is ISO — 7 is Sunday, which is the day we want to land on.
  const iso = weekdayOf(date)
  return addDays(date, iso === 7 ? 0 : -iso)
}

export function compare(a: CivilDate, b: CivilDate): number {
  return toEpochDay(a) - toEpochDay(b)
}

export function daysBetween(from: CivilDate, to: CivilDate): number {
  return toEpochDay(to) - toEpochDay(from)
}

/**
 * Today's calendar date in an IANA timezone.
 *
 * `en-CA` is used because it formats as `YYYY-MM-DD`, which parses directly. The timezone
 * is applied by `Intl`, so this is correct on a DST changeover day without special cases.
 */
export function todayIn(timeZone: string, now: Date = new Date()): CivilDate {
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
  const parsed = parseIso(formatted)
  if (!parsed) throw new Error(`Could not read today's date in timezone ${timeZone}`)
  return parsed
}
