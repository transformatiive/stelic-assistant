import {
  type CivilDate,
  type Weekday,
  addDays,
  compare,
  formatIso,
  parseIso,
  todayIn,
  weekdayOf,
} from './civil-date'

/**
 * Turns the user's verbatim date wording into a calendar date (task 5.1).
 *
 * The model never resolves a date — it copies the words out and this decides what they mean,
 * in the user's own timezone. See `specs/timesheet-chat/spec.md` CHAT-5.
 */

export type DateResolution =
  | { status: 'resolved'; date: string }
  | { status: 'unresolved'; reason: 'missing' | 'unrecognised' }
  | { status: 'blocked'; reason: 'future'; date: string }

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
}

const WEEKDAYS: Record<string, Weekday> = {
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
  sunday: 7,
  sun: 7,
}

/**
 * Numeric dates are read **US-first** (`MM/DD`, `MM-DD`), which deviates from `design.md`
 * §4.2's `dd/mm`. Stelic is a US firm, the app's default timezone is `America/New_York`, and
 * Zoho itself takes `MM-DD-YYYY` — reading `07/08` as 8 July here would silently bill the
 * wrong day. Where the US reading is impossible (a first number above 12) the day/month
 * reading is used instead, so `25/07` still works for anyone who types it that way.
 */
function parseNumeric(a: number, b: number, today: CivilDate): CivilDate | null {
  const candidates: CivilDate[] = []
  if (a >= 1 && a <= 12 && b >= 1 && b <= 31)
    candidates.push({ year: today.year, month: a, day: b })
  if (b >= 1 && b <= 12 && a >= 1 && a <= 31)
    candidates.push({ year: today.year, month: b, day: a })

  for (const candidate of candidates) {
    const valid = parseIso(formatIso(candidate))
    if (!valid) continue
    // A bare day/month with no year means the most recent such date, so a January entry
    // typed in December belongs to the year just gone, not eleven months in the future.
    if (compare(valid, today) > 0) {
      const lastYear = parseIso(formatIso({ ...valid, year: valid.year - 1 }))
      if (lastYear) return lastYear
    }
    return valid
  }
  return null
}

/** Most recent occurrence of a weekday, counting today. */
function mostRecentWeekday(target: Weekday, today: CivilDate): CivilDate {
  const delta = (weekdayOf(today) - target + 7) % 7
  return addDays(today, -delta)
}

/**
 * A month name plus a day, with no year stated — "July 25th", "25 July".
 *
 * Mirrors `parseNumeric`'s own convention for a year-less date: the most recent occurrence,
 * stepping back a year rather than landing eleven months in the future. "July 25th" said in
 * January means last July, not a date that gets blocked as upcoming.
 */
function mostRecentMonthDay(
  month: number,
  day: number,
  today: CivilDate,
): CivilDate | null {
  const thisYear = parseIso(formatIso({ year: today.year, month, day } as CivilDate))
  if (!thisYear) return null
  if (compare(thisYear, today) <= 0) return thisYear
  return parseIso(formatIso({ ...thisYear, year: thisYear.year - 1 }))
}

const ORDINAL = '(?:st|nd|rd|th)?'
// "july 25th", "jul 25", "july 25th, 2026" — month first.
const MONTH_THEN_DAY = new RegExp(
  `^([a-z]+)\\.?\\s+(\\d{1,2})${ORDINAL}(?:,?\\s+(\\d{4}))?$`,
)
// "25th of july", "25 july", "25th july 2026" — day first.
const DAY_THEN_MONTH = new RegExp(
  `^(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?([a-z]+)\\.?(?:,?\\s+(\\d{4}))?$`,
)

/**
 * Drop a weekday that is only naming the same day the rest of the phrase already gives.
 *
 * People answer "which day?" the way they'd say it out loud — "sat jul 25th", "saturday july
 * 25th" — and the weekday is context, not the answer. Left in place the phrase matches
 * neither form: the weekday branch wants a bare weekday, and the month-and-day branch wants
 * to start at the month.
 *
 * Only stripped when what follows is itself a date, so "last friday" and a bare "friday" are
 * untouched. Where the two disagree — "monday july 25th", and the 25th is a Saturday — the
 * explicit date wins, because a wrong weekday is a slip and a stated date is a decision.
 */
function stripLeadingWeekday(text: string): string {
  const match = /^([a-z]+)\.?,?\s+(.+)$/.exec(text)
  if (!match || !WEEKDAYS[match[1]!]) return text
  const rest = match[2]!
  const firstWord = rest.split(' ')[0]!
  return /\d/.test(rest) || MONTHS[firstWord.replace(/\.$/, '')] ? rest : text
}

export function resolveDate(
  expression: string | null | undefined,
  options: { timeZone: string; now?: Date } = { timeZone: 'America/New_York' },
): DateResolution {
  const today = todayIn(options.timeZone, options.now ?? new Date())

  if (expression === null || expression === undefined || expression.trim() === '') {
    return { status: 'unresolved', reason: 'missing' }
  }

  const raw = expression.trim().toLowerCase().replace(/\s+/g, ' ')
  let text = raw.replace(/^(on|last|this|the)\s+the\s+/, '$1 ')
  // A leading preposition is never part of the date — "on sat jul 25th" is the same answer
  // as "sat jul 25th". The weekday branch tolerated "on" already; nothing else did.
  text = text.replace(/^on\s+/, '')
  text = stripLeadingWeekday(text)

  const resolvedOrBlocked = (date: CivilDate): DateResolution =>
    compare(date, today) > 0
      ? { status: 'blocked', reason: 'future', date: formatIso(date) }
      : { status: 'resolved', date: formatIso(date) }

  if (/^(today|tod|this morning|this afternoon|tonight)$/.test(text)) {
    return { status: 'resolved', date: formatIso(today) }
  }
  if (/^(yesterday|yday|last night)$/.test(text)) {
    return { status: 'resolved', date: formatIso(addDays(today, -1)) }
  }
  if (/^(tomorrow|tmrw)$/.test(text)) {
    return { status: 'blocked', reason: 'future', date: formatIso(addDays(today, 1)) }
  }

  // "3 days ago", "2 weeks ago"
  const ago = /^(\d{1,3})\s*(day|days|week|weeks)\s+ago$/.exec(text)
  if (ago) {
    const n = Number(ago[1])
    const days = ago[2]!.startsWith('week') ? n * 7 : n
    return resolvedOrBlocked(addDays(today, -days))
  }

  // ISO, the unambiguous form
  const iso = parseIso(text)
  if (iso) return resolvedOrBlocked(iso)

  // Full numeric with a year: MM-DD-YYYY or DD/MM/YYYY etc.
  const withYear = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(text)
  if (withYear) {
    const year = Number(withYear[3]!.length === 2 ? `20${withYear[3]}` : withYear[3])
    const a = Number(withYear[1])
    const b = Number(withYear[2])
    const usFirst = parseIso(formatIso({ year, month: a, day: b } as CivilDate))
    const dayFirst = parseIso(formatIso({ year, month: b, day: a } as CivilDate))
    const picked = usFirst ?? dayFirst
    if (picked) return resolvedOrBlocked(picked)
    return { status: 'unresolved', reason: 'unrecognised' }
  }

  // Bare numeric day/month
  const bare = /^(\d{1,2})[/\-.](\d{1,2})$/.exec(text)
  if (bare) {
    const parsed = parseNumeric(Number(bare[1]), Number(bare[2]), today)
    return parsed
      ? resolvedOrBlocked(parsed)
      : { status: 'unresolved', reason: 'unrecognised' }
  }

  // A month name plus a day — "July 25th", "25 July 2026". Checked before weekday names, or
  // "july" would fall through to the weekday branch and fail to match there instead.
  const monthThenDay = MONTH_THEN_DAY.exec(text)
  const dayThenMonth = monthThenDay ? null : DAY_THEN_MONTH.exec(text)
  const monthDayMatch = monthThenDay
    ? { month: MONTHS[monthThenDay[1]!], day: monthThenDay[2], year: monthThenDay[3] }
    : dayThenMonth
      ? { month: MONTHS[dayThenMonth[2]!], day: dayThenMonth[1], year: dayThenMonth[3] }
      : null

  if (monthDayMatch?.month) {
    const { month, year: yearText } = monthDayMatch
    const day = Number(monthDayMatch.day)

    if (yearText) {
      const date = parseIso(
        formatIso({ year: Number(yearText), month, day } as CivilDate),
      )
      return date
        ? resolvedOrBlocked(date)
        : { status: 'unresolved', reason: 'unrecognised' }
    }
    // No year stated: the most recent occurrence, matching the bare-numeric convention —
    // "July 25th" said in January means last July, not a date blocked as eleven months out.
    const date = mostRecentMonthDay(month, day, today)
    return date
      ? resolvedOrBlocked(date)
      : { status: 'unresolved', reason: 'unrecognised' }
  }

  // Weekday names, with or without a "last"/"on" prefix
  const weekday = /^(?:on\s+)?(last\s+|this\s+past\s+|past\s+)?([a-z]+)$/.exec(text)
  if (weekday) {
    const target = WEEKDAYS[weekday[2]!]
    if (target) {
      const recent = mostRecentWeekday(target, today)
      const isToday = compare(recent, today) === 0
      // "last Friday" said on a Friday means the previous one, not this morning.
      const explicitlyLast = Boolean(weekday[1])
      return {
        status: 'resolved',
        date: formatIso(explicitlyLast && isToday ? addDays(recent, -7) : recent),
      }
    }
  }

  return { status: 'unresolved', reason: 'unrecognised' }
}
