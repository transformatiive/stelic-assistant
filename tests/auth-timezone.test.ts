import { describe, expect, it } from 'vitest'
import { isUsableTimeZone, shouldUpdateTimeZone } from '@/lib/auth/timezone'
import { todayIn } from '@/lib/resolve/civil-date'
import { formatIso } from '@/lib/resolve/civil-date'
import { resolveDate } from '@/lib/resolve/date'

describe('isUsableTimeZone', () => {
  it('accepts IANA names the runtime knows', () => {
    for (const zone of [
      'America/New_York',
      'America/Los_Angeles',
      'Europe/Lisbon',
      'Asia/Kolkata',
      'America/Argentina/Buenos_Aires',
    ]) {
      expect(isUsableTimeZone(zone)).toBe(true)
    }
  })

  it('rejects a UTC offset, which is wrong twice a year', () => {
    // An offset cannot express DST, which is the whole class of bug this area exists to avoid.
    expect(isUsableTimeZone('+05:30')).toBe(false)
    expect(isUsableTimeZone('UTC+2')).toBe(false)
    expect(isUsableTimeZone('GMT')).toBe(false)
  })

  it('rejects a name the runtime does not recognise', () => {
    expect(isUsableTimeZone('Mars/Olympus_Mons')).toBe(false)
    expect(isUsableTimeZone('Not/AZone')).toBe(false)
  })

  it('rejects anything that is not a string', () => {
    for (const bad of [null, undefined, 42, {}, [], '']) {
      expect(isUsableTimeZone(bad)).toBe(false)
    }
  })
})

describe('shouldUpdateTimeZone', () => {
  it('updates when someone moves', () => {
    expect(shouldUpdateTimeZone('America/New_York', 'Europe/Lisbon')).toBe(true)
  })

  it('does nothing when it has not changed', () => {
    expect(shouldUpdateTimeZone('Europe/Lisbon', 'Europe/Lisbon')).toBe(false)
    expect(shouldUpdateTimeZone('Europe/Lisbon', '  Europe/Lisbon  ')).toBe(false)
  })

  it('refuses a value the date resolver could not use', () => {
    expect(shouldUpdateTimeZone('America/New_York', '+00:00')).toBe(false)
    expect(shouldUpdateTimeZone('America/New_York', null)).toBe(false)
  })
})

describe('why this matters: the day, not the instant', () => {
  // Stelic's people are in dispersed timezones and a timesheet records a day. The same
  // moment is two different days depending on where you are sitting.
  const lateEvening = new Date('2026-07-25T23:30:00-04:00') // 25 Jul in New York

  it('is already the next day in Lisbon', () => {
    expect(formatIso(todayIn('America/New_York', lateEvening))).toBe('2026-07-25')
    expect(formatIso(todayIn('Europe/Lisbon', lateEvening))).toBe('2026-07-26')
  })

  it('resolves "yesterday" differently for two people at the same moment', () => {
    const inNewYork = resolveDate('yesterday', {
      timeZone: 'America/New_York',
      now: lateEvening,
    })
    const inLisbon = resolveDate('yesterday', {
      timeZone: 'Europe/Lisbon',
      now: lateEvening,
    })

    expect(inNewYork).toEqual({ status: 'resolved', date: '2026-07-24' })
    expect(inLisbon).toEqual({ status: 'resolved', date: '2026-07-25' })
  })

  it('does not block a date that is future in one zone but not the other', () => {
    // 26 Jul is tomorrow in New York and today in Lisbon at this instant.
    expect(
      resolveDate('2026-07-26', { timeZone: 'America/New_York', now: lateEvening }),
    ).toMatchObject({ status: 'blocked', reason: 'future' })
    expect(
      resolveDate('2026-07-26', { timeZone: 'Europe/Lisbon', now: lateEvening }),
    ).toMatchObject({ status: 'resolved' })
  })
})
