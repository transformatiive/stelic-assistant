import { describe, expect, it } from 'vitest'
import {
  addDays,
  formatIso,
  formatZoho,
  parseIso,
  todayIn,
  weekdayOf,
} from '@/lib/resolve/civil-date'
import { resolveDate } from '@/lib/resolve/date'

const NY = 'America/New_York'
/** Wednesday 22 July 2026, mid-afternoon in New York. */
const WED = new Date('2026-07-22T18:00:00Z')

function on(expression: string, now: Date = WED, timeZone = NY) {
  return resolveDate(expression, { timeZone, now })
}

describe('civil date arithmetic', () => {
  it('round-trips through epoch days', () => {
    for (const iso of ['1970-01-01', '2000-02-29', '2026-07-22', '2100-12-31']) {
      const date = parseIso(iso)!
      expect(formatIso(date)).toBe(iso)
    }
  })

  it('rejects impossible calendar dates', () => {
    expect(parseIso('2026-02-30')).toBeNull()
    expect(parseIso('2026-13-01')).toBeNull()
    expect(parseIso('2025-02-29')).toBeNull()
    expect(parseIso('2024-02-29')).not.toBeNull()
  })

  it('knows the weekday', () => {
    expect(weekdayOf(parseIso('2026-07-22')!)).toBe(3)
    expect(weekdayOf(parseIso('1970-01-01')!)).toBe(4)
  })

  it('formats for Zoho as MM-DD-YYYY', () => {
    expect(formatZoho(parseIso('2026-07-05')!)).toBe('07-05-2026')
  })

  it('crosses month and year boundaries', () => {
    expect(formatIso(addDays(parseIso('2026-01-01')!, -1))).toBe('2025-12-31')
    expect(formatIso(addDays(parseIso('2026-02-28')!, 1))).toBe('2026-03-01')
    expect(formatIso(addDays(parseIso('2024-02-28')!, 1))).toBe('2024-02-29')
  })
})

describe('todayIn', () => {
  it('uses the timezone, not the server clock', () => {
    // 02:00 UTC on the 23rd is still the 22nd in New York.
    const instant = new Date('2026-07-23T02:00:00Z')
    expect(formatIso(todayIn(NY, instant))).toBe('2026-07-22')
    expect(formatIso(todayIn('UTC', instant))).toBe('2026-07-23')
  })
})

describe('resolveDate', () => {
  it('resolves today and yesterday', () => {
    expect(on('today')).toEqual({ status: 'resolved', date: '2026-07-22' })
    expect(on('yesterday')).toEqual({ status: 'resolved', date: '2026-07-21' })
  })

  it('treats a missing expression as an unresolved slot, not an error', () => {
    expect(resolveDate(null, { timeZone: NY, now: WED })).toEqual({
      status: 'unresolved',
      reason: 'missing',
    })
    expect(on('   ')).toEqual({ status: 'unresolved', reason: 'missing' })
  })

  it('resolves a bare weekday backwards, never forwards', () => {
    // Today is Wednesday; "Monday" is two days ago, not next week.
    expect(on('Monday')).toEqual({ status: 'resolved', date: '2026-07-20' })
    expect(on('friday')).toEqual({ status: 'resolved', date: '2026-07-17' })
    expect(on('on Tuesday')).toEqual({ status: 'resolved', date: '2026-07-21' })
  })

  it('resolves a bare weekday naming today as today', () => {
    expect(on('wednesday')).toEqual({ status: 'resolved', date: '2026-07-22' })
  })

  it('reads "last <weekday>" as the previous one when today is that weekday', () => {
    expect(on('last wednesday')).toEqual({ status: 'resolved', date: '2026-07-15' })
    // On any other day it means the most recent one, same as the bare form.
    expect(on('last friday')).toEqual({ status: 'resolved', date: '2026-07-17' })
  })

  it('accepts weekday abbreviations', () => {
    expect(on('mon')).toEqual({ status: 'resolved', date: '2026-07-20' })
    expect(on('thurs')).toEqual({ status: 'resolved', date: '2026-07-16' })
  })

  it('accepts ISO dates', () => {
    expect(on('2026-07-01')).toEqual({ status: 'resolved', date: '2026-07-01' })
  })

  it('reads bare numeric dates US-first', () => {
    // 07/08 is 8 July for a US firm, not 7 August.
    expect(on('07/08')).toEqual({ status: 'resolved', date: '2026-07-08' })
    expect(on('7-8')).toEqual({ status: 'resolved', date: '2026-07-08' })
  })

  it('falls back to day/month when the US reading is impossible', () => {
    expect(on('21/07')).toEqual({ status: 'resolved', date: '2026-07-21' })
  })

  it('reads a bare day/month in the past, not eleven months ahead', () => {
    // Said in July, "12/25" means last Christmas, not this year's.
    expect(on('12/25')).toEqual({ status: 'resolved', date: '2025-12-25' })
  })

  it('accepts full dates with a year', () => {
    expect(on('07-04-2026')).toEqual({ status: 'resolved', date: '2026-07-04' })
    expect(on('07/04/26')).toEqual({ status: 'resolved', date: '2026-07-04' })
  })

  describe('month names', () => {
    // A separate "today", matching the live field report exactly: Saturday 25 July 2026 —
    // three days after the suite's usual Wednesday fixture. Using WED for these would make
    // "July 25th" a few days *ahead* of today and trigger the year-rollback convention below,
    // which is correct behaviour but not what this section is testing.
    const SAT = new Date('2026-07-25T18:00:00Z')
    const onSat = (expression: string) =>
      resolveDate(expression, { timeZone: NY, now: SAT })

    it('accepts a month name and a day, in either order', () => {
      // The live bug: "July 25th" was never recognised at all — there was no month-name
      // parsing, only numeric MM/DD forms, weekday names and relative wording. It fell
      // through to "unrecognised", and the bot asked a question with no way to answer it
      // that didn't hit the same gap again.
      expect(onSat('July 25th')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('july 25')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('Jul 25')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('25 July')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('25th of July')).toEqual({ status: 'resolved', date: '2026-07-25' })
    })

    it('resolves the same day the resolver considers today, as today', () => {
      // The exact case from the field report: asked on 25 July about 25 July.
      expect(onSat('July 25')).toEqual({ status: 'resolved', date: '2026-07-25' })
    })

    it('accepts an explicit year with a month name', () => {
      expect(onSat('July 25th, 2026')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('25 July 2026')).toEqual({ status: 'resolved', date: '2026-07-25' })
    })

    it('reads a year-less month name in the past, not eleven months ahead', () => {
      // Mirrors the bare-numeric convention (12/25 above): no year stated means the most
      // recent occurrence, not a date that gets blocked as upcoming. Using WED (22 July) here
      // deliberately, since December is unambiguously in the past either way.
      expect(on('December 25th')).toEqual({ status: 'resolved', date: '2025-12-25' })
    })

    it('rolls a near date back a year too, same as the bare-numeric form does', () => {
      // "07/25" said on 22 July already rolls back a year (tested above); a month name is
      // the same convention, not a special case for month names specifically.
      expect(on('July 25')).toEqual({ status: 'resolved', date: '2025-07-25' })
    })

    it('still blocks a month-and-day date when an explicit year makes it genuinely future', () => {
      expect(onSat('July 25th, 2027')).toEqual({
        status: 'blocked',
        reason: 'future',
        date: '2027-07-25',
      })
    })

    it('rejects a day that does not exist in that month', () => {
      expect(onSat('February 30th')).toEqual({
        status: 'unresolved',
        reason: 'unrecognised',
      })
    })

    it('does not mistake a plain weekday name for a month', () => {
      expect(onSat('friday')).toEqual({ status: 'resolved', date: '2026-07-24' })
    })

    it('accepts the weekday said alongside the date, which is how people answer out loud', () => {
      // The live field report: asked "which day?", the user answered "on sat jul 25th" and
      // then "saturday july 25th". Both were unrecognised — the weekday made the phrase match
      // neither the bare-weekday form nor the month-and-day form.
      for (const said of [
        'on sat jul 25th',
        'saturday july 25th',
        'sat jul 25',
        'sat, jul 25',
        'Saturday, July 25th, 2026',
      ]) {
        expect(onSat(said), said).toEqual({ status: 'resolved', date: '2026-07-25' })
      }
    })

    it('lets the stated date win when the weekday beside it is wrong', () => {
      // 25 July 2026 is a Saturday. Naming Monday is a slip; the explicit date is a decision.
      expect(onSat('monday july 25th')).toEqual({
        status: 'resolved',
        date: '2026-07-25',
      })
    })

    it('still reads a bare weekday as a weekday, with or without "on" or "last"', () => {
      expect(onSat('on friday')).toEqual({ status: 'resolved', date: '2026-07-24' })
      expect(onSat('last friday')).toEqual({ status: 'resolved', date: '2026-07-24' })
      expect(onSat('sat')).toEqual({ status: 'resolved', date: '2026-07-25' })
    })

    it('drops a leading "on" for every date form, not only weekdays', () => {
      expect(onSat('on 25 july')).toEqual({ status: 'resolved', date: '2026-07-25' })
      expect(onSat('on 07/24')).toEqual({ status: 'resolved', date: '2026-07-24' })
    })
  })

  it('resolves relative day and week counts', () => {
    expect(on('3 days ago')).toEqual({ status: 'resolved', date: '2026-07-19' })
    expect(on('2 weeks ago')).toEqual({ status: 'resolved', date: '2026-07-08' })
  })

  it('blocks future dates rather than silently accepting them', () => {
    expect(on('tomorrow')).toEqual({
      status: 'blocked',
      reason: 'future',
      date: '2026-07-23',
    })
    expect(on('2026-08-01')).toEqual({
      status: 'blocked',
      reason: 'future',
      date: '2026-08-01',
    })
  })

  it('leaves vague wording unresolved so the bot asks', () => {
    for (const vague of [
      'the other day',
      'recently',
      'a while back',
      'sometime last month',
    ]) {
      expect(on(vague)).toEqual({ status: 'unresolved', reason: 'unrecognised' })
    }
  })

  describe('DST boundaries', () => {
    // US DST ended 2026-11-01. A UTC-subtraction implementation gets these wrong.
    const dayAfterFallBack = new Date('2026-11-02T15:00:00Z')
    const dayAfterSpringForward = new Date('2026-03-09T15:00:00Z')

    it('gets "yesterday" right the day after the clocks go back', () => {
      expect(resolveDate('yesterday', { timeZone: NY, now: dayAfterFallBack })).toEqual({
        status: 'resolved',
        date: '2026-11-01',
      })
    })

    it('gets "yesterday" right the day after the clocks go forward', () => {
      expect(
        resolveDate('yesterday', { timeZone: NY, now: dayAfterSpringForward }),
      ).toEqual({
        status: 'resolved',
        date: '2026-03-08',
      })
    })

    it('counts whole days across a DST change', () => {
      // 2026-11-02 minus 7 days is 2026-10-26, even though one of those days had 25 hours.
      expect(resolveDate('7 days ago', { timeZone: NY, now: dayAfterFallBack })).toEqual({
        status: 'resolved',
        date: '2026-10-26',
      })
    })
  })

  it('honours a non-default timezone', () => {
    // 23:30 UTC on the 22nd is already the 23rd in Lisbon (UTC+1 in summer).
    const lateEvening = new Date('2026-07-22T23:30:00Z')
    expect(resolveDate('today', { timeZone: 'Europe/Lisbon', now: lateEvening })).toEqual(
      {
        status: 'resolved',
        date: '2026-07-23',
      },
    )
    expect(resolveDate('today', { timeZone: NY, now: lateEvening })).toEqual({
      status: 'resolved',
      date: '2026-07-22',
    })
  })
})
