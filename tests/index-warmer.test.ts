import { describe, expect, it } from 'vitest'
import { shouldWarm } from '@/app/index-warmer'

/**
 * The live bug: a returning user saw "Loading your projects from Zoho…" on almost every visit,
 * because the index's one-hour TTL means it is "stale" far more often than the schedule (task
 * 3.4, four times a day) actually rebuilds it — and the browser was treating ordinary
 * staleness the same as a first-run empty index. Only an index with nothing in it is this
 * component's problem to solve; the schedule owns the rest.
 */
describe('shouldWarm', () => {
  it('warms a genuinely empty index', () => {
    expect(shouldWarm({ stale: true, projects: 0 })).toBe(true)
  })

  it('does not warm an index that is merely stale by an hour', () => {
    expect(shouldWarm({ stale: true, projects: 42 })).toBe(false)
  })

  it('does not warm a fresh index', () => {
    expect(shouldWarm({ stale: false, projects: 42 })).toBe(false)
  })

  it('does not warm a fresh, empty index — nothing to find yet, not this component’s job', () => {
    expect(shouldWarm({ stale: false, projects: 0 })).toBe(false)
  })
})
