/**
 * How hours and dates read on screen (task 8.7, PWA-5).
 *
 * Pure, and in `lib` rather than in a component, because these are the strings a person
 * checks their timesheet against — they are worth testing directly rather than through a
 * rendered tree.
 */

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

/**
 * `7.5` → `7h 30m`, `8` → `8h`, `0.25` → `15m`.
 *
 * Not `7.5 hours`: a timesheet is read at a glance and quarter-hours are the unit people
 * actually think in. The trailing `0m` is dropped because "8h 0m" reads like a placeholder.
 */
export function formatHours(hours: number): string {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

/**
 * `2026-07-21` → `Tue 21 Jul`, and `Yesterday` / `Today` where that is what it is.
 *
 * The relative label wins because it is what the user said and what they will check. The
 * absolute date stays available separately — `dateDetail` — so a card can show both and
 * nobody has to trust a relative word alone when the entry is about to be billed.
 */
export function formatDate(iso: string, today?: string): string {
  const relative = relativeLabel(iso, today)
  return relative ?? dateDetail(iso)
}

export function dateDetail(iso: string): string {
  const parsed = parse(iso)
  if (!parsed) return iso
  const { year, month, day } = parsed
  return `${WEEKDAYS[weekdayOf(parsed)]!.slice(0, 3)} ${day} ${MONTHS[month - 1]} ${year}`
}

/** `Today` or `Yesterday`, or null when it is neither. */
export function relativeLabel(iso: string, today?: string): string | null {
  if (!today) return null
  if (iso === today) return 'Today'

  const a = parse(iso)
  const b = parse(today)
  if (!a || !b) return null
  if (epochDay(b) - epochDay(a) === 1) return 'Yesterday'
  return null
}

/** The full weekday name, for the week screen's day headings. */
export function weekdayName(iso: string): string {
  const parsed = parse(iso)
  return parsed ? WEEKDAYS[weekdayOf(parsed)]! : iso
}

/** `2026-07-19` and `2026-07-25` → `19–25 Jul 2026`, collapsing what the two dates share. */
export function formatRange(startIso: string, endIso: string): string {
  const start = parse(startIso)
  const end = parse(endIso)
  if (!start || !end) return `${startIso} – ${endIso}`

  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${end.day} ${MONTHS[start.month - 1]} ${start.year}`
  }
  if (start.year === end.year) {
    return `${start.day} ${MONTHS[start.month - 1]} – ${end.day} ${MONTHS[end.month - 1]} ${start.year}`
  }
  return `${dateDetail(startIso)} – ${dateDetail(endIso)}`
}

type Civil = { year: number; month: number; day: number }

function parse(iso: string): Civil | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) }
}

/**
 * Days since the epoch, by arithmetic rather than by `Date`.
 *
 * The same reason the resolver does it this way: `new Date('2026-07-21')` is an instant, and
 * an instant in the wrong zone is the wrong day. Nothing here needs a clock.
 */
function epochDay({ year, month, day }: Civil): number {
  const y = year - (month <= 2 ? 1 : 0)
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

/** 0 = Sunday … 6 = Saturday, matching the portal's Sunday-first week. */
function weekdayOf(date: Civil): number {
  return (((epochDay(date) + 4) % 7) + 7) % 7
}
