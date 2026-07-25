import { describe, expect, it } from 'vitest'
import type { DraftEntry } from '@/lib/resolve/entry'
import {
  DUPLICATE_SIMILARITY,
  findDuplicate,
  warningsFor,
  warningsForDraft,
  type ExistingLog,
} from '@/lib/resolve/warnings'

const TODAY = '2026-07-25'

function entry(over: Partial<DraftEntry> = {}): DraftEntry {
  return {
    id: 'e1',
    said: { project: 'clayco', date: 'yesterday' },
    project: { status: 'resolved', projectId: 'p1', projectName: 'Clayco', why: '' },
    task: { status: 'resolved', taskId: 't1', taskName: 'Scheduler', why: '' },
    date: { status: 'resolved', date: '2026-07-24' },
    hours: { status: 'resolved', hours: 8 },
    description: {
      status: 'resolved',
      description: 'schedule updates and progress meeting',
    },
    billable: true,
    ...over,
  }
}

const EXISTING: ExistingLog[] = [
  {
    projectId: 'p1',
    taskId: 't1',
    date: '2026-07-24',
    description: 'schedule updates and progress meeting',
    logId: 'log-1',
  },
]

const OPTIONS = { today: TODAY, backdateWarnDays: 14, existingLogs: EXISTING }

describe('duplicate detection', () => {
  it('flags the same work logged twice on the same task and day', () => {
    expect(findDuplicate(entry(), EXISTING)?.logId).toBe('log-1')
  })

  it('flags a reworded version of the same work', () => {
    const reworded = entry({
      description: {
        status: 'resolved',
        description: 'schedule updates and a progress meeting',
      },
    })
    expect(findDuplicate(reworded, EXISTING)).not.toBeNull()
  })

  it('does not flag genuinely different work on the same task and day', () => {
    // Two honest entries: drafting in the morning, a site visit in the afternoon.
    const different = entry({
      description: { status: 'resolved', description: 'site visit and rebar inspection' },
    })
    expect(findDuplicate(different, EXISTING)).toBeNull()
  })

  it('does not flag the same description on a different day', () => {
    const otherDay = entry({ date: { status: 'resolved', date: '2026-07-23' } })
    expect(findDuplicate(otherDay, EXISTING)).toBeNull()
  })

  it('does not flag the same description on a different task or project', () => {
    expect(
      findDuplicate(
        entry({ task: { status: 'resolved', taskId: 't2', taskName: 'PM', why: '' } }),
        EXISTING,
      ),
    ).toBeNull()
    expect(
      findDuplicate(
        entry({
          project: { status: 'resolved', projectId: 'p2', projectName: 'Other', why: '' },
        }),
        EXISTING,
      ),
    ).toBeNull()
  })

  it('cannot judge an entry that is not fully resolved yet', () => {
    expect(
      findDuplicate(
        entry({ hours: { status: 'unresolved', reason: 'missing' } }),
        EXISTING,
      ),
    ).not.toBeNull() // hours are irrelevant to duplication
    expect(
      findDuplicate(
        entry({ description: { status: 'unresolved', reason: 'missing' } }),
        EXISTING,
      ),
    ).toBeNull()
    expect(
      findDuplicate(
        entry({ date: { status: 'unresolved', reason: 'missing' } }),
        EXISTING,
      ),
    ).toBeNull()
  })

  it('finds nothing when there is nothing to compare against', () => {
    expect(findDuplicate(entry(), [])).toBeNull()
  })

  it('uses a threshold high enough that similar-sounding work is not conflated', () => {
    expect(DUPLICATE_SIMILARITY).toBeGreaterThanOrEqual(0.8)
  })
})

describe('backdating', () => {
  it('says nothing about yesterday', () => {
    expect(warningsFor(entry(), { ...OPTIONS, existingLogs: [] })).toEqual([])
  })

  it('warns past the configured window, and says how far back', () => {
    const old = entry({ date: { status: 'resolved', date: '2026-06-20' } })
    const [warning] = warningsFor(old, { ...OPTIONS, existingLogs: [] })
    expect(warning).toMatchObject({ kind: 'backdated', days: 35 })
    expect(warning?.message).toContain('35 days ago')
  })

  it('does not warn exactly at the window', () => {
    const boundary = entry({ date: { status: 'resolved', date: '2026-07-11' } }) // 14 days
    expect(warningsFor(boundary, { ...OPTIONS, existingLogs: [] })).toEqual([])
  })

  it('warns one day past the window', () => {
    const past = entry({ date: { status: 'resolved', date: '2026-07-10' } }) // 15 days
    expect(warningsFor(past, { ...OPTIONS, existingLogs: [] })).toHaveLength(1)
  })

  it('honours a different configured window', () => {
    const old = entry({ date: { status: 'resolved', date: '2026-07-10' } })
    expect(
      warningsFor(old, { ...OPTIONS, existingLogs: [], backdateWarnDays: 30 }),
    ).toEqual([])
  })
})

describe('warnings are warnings, not rules', () => {
  it('never warns on a daily total, because the cap was abandoned', () => {
    // Open question 4: the daily cap is not policy. Reintroducing it as a "helpful" warning
    // would resurrect an abandoned rule through the back door.
    const heavy = [
      entry({ id: 'e1', hours: { status: 'resolved', hours: 12 } }),
      entry({
        id: 'e2',
        hours: { status: 'resolved', hours: 11 },
        description: { status: 'resolved', description: 'entirely different work here' },
      }),
    ]
    const warnings = warningsForDraft(heavy, { ...OPTIONS, existingLogs: [] })
    expect(warnings.size).toBe(0)
    expect(JSON.stringify([...warnings])).not.toMatch(/cap|total|daily|too much/i)
  })

  it('reports both a duplicate and backdating on one entry', () => {
    const both = entry({ date: { status: 'resolved', date: '2026-06-20' } })
    const existing: ExistingLog[] = [{ ...EXISTING[0]!, date: '2026-06-20' }]
    const warnings = warningsFor(both, { ...OPTIONS, existingLogs: existing })
    expect(warnings.map((w) => w.kind).sort()).toEqual([
      'backdated',
      'possible_duplicate',
    ])
  })

  it('keys warnings by entry, and omits entries with none', () => {
    const entries = [
      entry({ id: 'e1', date: { status: 'resolved', date: '2026-06-01' } }),
      entry({ id: 'e2' }),
    ]
    const warnings = warningsForDraft(entries, { ...OPTIONS, existingLogs: [] })
    expect([...warnings.keys()]).toEqual(['e1'])
  })
})
