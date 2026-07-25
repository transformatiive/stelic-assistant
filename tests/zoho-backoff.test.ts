import { describe, expect, it } from 'vitest'
import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffDelayMs,
  retryAfterMs,
} from '@/lib/zoho/backoff'

describe('backoffDelayMs', () => {
  it('grows exponentially at the ceiling', () => {
    const atCeiling = () => 0.999999
    expect(backoffDelayMs(0, atCeiling)).toBe(BACKOFF_BASE_MS - 1)
    expect(backoffDelayMs(1, atCeiling)).toBe(BACKOFF_BASE_MS * 2 - 1)
    expect(backoffDelayMs(2, atCeiling)).toBe(BACKOFF_BASE_MS * 4 - 1)
  })

  it('applies full jitter, so the floor is zero', () => {
    expect(backoffDelayMs(5, () => 0)).toBe(0)
  })

  it('never exceeds the cap however many attempts', () => {
    for (const attempt of [4, 8, 20, 100]) {
      expect(backoffDelayMs(attempt, () => 0.999999)).toBeLessThanOrEqual(BACKOFF_CAP_MS)
    }
  })

  it('stays within the ceiling for arbitrary jitter draws', () => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)
      for (const draw of [0, 0.25, 0.5, 0.75, 0.9999]) {
        const delay = backoffDelayMs(attempt, () => draw)
        expect(delay).toBeGreaterThanOrEqual(0)
        expect(delay).toBeLessThan(ceiling + 1)
      }
    }
  })
})

describe('retryAfterMs', () => {
  it('returns null when the header is absent', () => {
    expect(retryAfterMs(null)).toBeNull()
  })

  it('reads a delay in seconds', () => {
    expect(retryAfterMs('2')).toBe(2000)
    expect(retryAfterMs('0')).toBe(0)
  })

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-07-25T12:00:00Z')
    expect(retryAfterMs('Sat, 25 Jul 2026 12:00:05 GMT', now)).toBe(5000)
  })

  it('clamps a date already in the past to zero', () => {
    const now = Date.parse('2026-07-25T12:00:10Z')
    expect(retryAfterMs('Sat, 25 Jul 2026 12:00:00 GMT', now)).toBe(0)
  })

  it('returns null for an unparseable header', () => {
    expect(retryAfterMs('soon')).toBeNull()
  })

  it('ignores a negative delay', () => {
    expect(retryAfterMs('-5')).toBeNull()
  })
})
