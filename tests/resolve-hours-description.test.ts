import { describe, expect, it } from 'vitest'
import {
  MAX_HOURS,
  MIN_HOURS,
  parseHours,
  roundToQuarter,
  toZohoHours,
} from '@/lib/resolve/hours'
import { validateDescription } from '@/lib/resolve/description'

describe('parseHours', () => {
  it('reads the three documented formats identically', () => {
    for (const input of ['7.5', '7:30', '7h30', '7h 30m', '7 hours 30 mins']) {
      expect(parseHours(input)).toEqual({ status: 'resolved', hours: 7.5 })
    }
  })

  it('reads whole hours', () => {
    expect(parseHours('8')).toEqual({ status: 'resolved', hours: 8 })
    expect(parseHours('8h')).toEqual({ status: 'resolved', hours: 8 })
    expect(parseHours('8 hours')).toEqual({ status: 'resolved', hours: 8 })
    expect(parseHours(8)).toEqual({ status: 'resolved', hours: 8 })
  })

  it('reads a comma decimal', () => {
    expect(parseHours('7,5')).toEqual({ status: 'resolved', hours: 7.5 })
  })

  it('reads minutes on their own', () => {
    expect(parseHours('90m')).toEqual({ status: 'resolved', hours: 1.5 })
    expect(parseHours('45 mins')).toEqual({ status: 'resolved', hours: 0.75 })
  })

  it('rounds to the nearest quarter hour', () => {
    expect(parseHours('2h20')).toEqual({ status: 'resolved', hours: 2.25 })
    expect(parseHours('2h23')).toEqual({ status: 'resolved', hours: 2.5 })
    expect(parseHours('0:50')).toEqual({ status: 'resolved', hours: 0.75 })
  })

  it('does not leak floating-point drift into the committed value', () => {
    const result = parseHours('7h20')
    expect(result).toEqual({ status: 'resolved', hours: 7.25 })
    if (result.status === 'resolved') {
      expect(Number.isInteger(result.hours * 4)).toBe(true)
    }
  })

  it('treats absence as an unresolved slot', () => {
    expect(parseHours(null)).toEqual({ status: 'unresolved', reason: 'missing' })
    expect(parseHours('')).toEqual({ status: 'unresolved', reason: 'missing' })
    expect(parseHours('  ')).toEqual({ status: 'unresolved', reason: 'missing' })
  })

  it('blocks anything outside the bounds', () => {
    expect(parseHours('30')).toEqual({
      status: 'blocked',
      reason: 'too_large',
      hours: 30,
    })
    expect(parseHours('0')).toEqual({ status: 'blocked', reason: 'too_small', hours: 0 })
    expect(parseHours('5m')).toEqual({ status: 'blocked', reason: 'too_small', hours: 0 })
  })

  it('accepts exactly the boundary values', () => {
    expect(parseHours('0.25')).toEqual({ status: 'resolved', hours: MIN_HOURS })
    expect(parseHours('24')).toEqual({ status: 'resolved', hours: MAX_HOURS })
  })

  it('rejects nonsense rather than guessing', () => {
    for (const input of ['lots', 'all day', '7:75', 'abc', '--']) {
      expect(parseHours(input).status).not.toBe('resolved')
    }
  })

  it('rounds half away from zero', () => {
    expect(roundToQuarter(0.125)).toBeCloseTo(0.25)
    expect(roundToQuarter(0.124)).toBeCloseTo(0.0)
  })

  it('formats for Zoho as hh:mm', () => {
    expect(toZohoHours(7.5)).toBe('07:30')
    expect(toZohoHours(0.25)).toBe('00:15')
    expect(toZohoHours(24)).toBe('24:00')
    expect(toZohoHours(8)).toBe('08:00')
  })
})

describe('validateDescription', () => {
  it('accepts a real description', () => {
    expect(validateDescription('schedule updates and progress meeting')).toEqual({
      status: 'resolved',
      description: 'schedule updates and progress meeting',
    })
  })

  it('normalises whitespace', () => {
    expect(validateDescription('  punch list   walkthrough \n')).toEqual({
      status: 'resolved',
      description: 'punch list walkthrough',
    })
  })

  it('treats absence as missing', () => {
    expect(validateDescription(null)).toEqual({ status: 'unresolved', reason: 'missing' })
    expect(validateDescription('   ')).toEqual({
      status: 'unresolved',
      reason: 'missing',
    })
  })

  it('rejects anything too short to mean something', () => {
    expect(validateDescription('mtg')).toEqual({
      status: 'unresolved',
      reason: 'too_short',
    })
  })

  it('rejects a single filler word', () => {
    for (const filler of ['work', 'stuff', 'misc', 'n/a', 'nothing', 'various']) {
      expect(validateDescription(filler).status).toBe('unresolved')
    }
  })

  it('rejects filler words strung together, which the length check alone would pass', () => {
    for (const filler of [
      'general work',
      'misc stuff and things',
      'worked on some stuff',
    ]) {
      expect(validateDescription(filler)).toEqual({
        status: 'unresolved',
        reason: 'filler',
      })
    }
  })

  it('rejects punctuation posing as a description', () => {
    expect(validateDescription('.....')).toEqual({
      status: 'unresolved',
      reason: 'filler',
    })
    expect(validateDescription('-----')).toEqual({
      status: 'unresolved',
      reason: 'filler',
    })
  })

  it('accepts a description that merely contains a filler word', () => {
    expect(validateDescription('rebar inspection and misc punch list').status).toBe(
      'resolved',
    )
    expect(validateDescription('admin handover to Brook').status).toBe('resolved')
  })
})
