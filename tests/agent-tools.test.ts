import { describe, expect, it } from 'vitest'
import type { ChargeCode } from '@/lib/index/build'
import {
  buildEntries,
  listChargeCodes,
  searchProjects,
  type ProposedEntry,
} from '@/lib/chat/agent-tools'
import type { ResolveContext } from '@/lib/resolve/entry'

const TODAY = '2026-07-25' // a Saturday

const INDEX = [
  {
    projectId: 'p-clayco',
    projectName: '1066 - Clayco EKI Data Center',
    accountName: 'Clayco Construction Company Inc',
    aliases: ['Clayco', 'Clayco EKI Data Center'],
  },
  {
    projectId: 'p-google',
    projectName: 'Google LLC — 1080 - Capital Projects Dashboard',
    accountName: 'Google LLC',
    aliases: ['Google'],
  },
]

const CHARGE_CODES = new Map<string, ChargeCode[]>([
  [
    'p-clayco',
    [
      {
        taskId: 't-sched',
        taskName: 'Scheduler',
        tasklist: 'Controls',
        completed: false,
      },
      {
        taskId: 't-pm',
        taskName: 'Project Manager',
        tasklist: 'Controls',
        completed: false,
      },
    ],
  ],
])

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    index: INDEX,
    chargeCodes: CHARGE_CODES,
    timezone: 'America/New_York',
    now: new Date(`${TODAY}T16:00:00Z`),
    defaultBillable: true,
    ...overrides,
  }
}

const proposed = (over: Partial<ProposedEntry> = {}): ProposedEntry => ({
  project_id: 'p-clayco',
  task_id: 't-sched',
  new_task_name: null,
  date: 'yesterday',
  hours: 8,
  description: 'schedule updates and progress meeting',
  billable: null,
  ...over,
})

describe('search_projects', () => {
  it('hands back real ids the model could not have invented', () => {
    const hits = searchProjects('clayco', context())
    expect(hits[0]).toMatchObject({
      project_id: 'p-clayco',
      name: '1066 - Clayco EKI Data Center',
      client: 'Clayco Construction Company Inc',
    })
  })

  it('returns every plausible option when the wording is ambiguous, for the agent to ask about', () => {
    const twoClaycos = [
      ...INDEX,
      {
        projectId: 'p-clayco-2',
        projectName: 'Clayco — Warehouse 4',
        accountName: 'Clayco',
      },
    ]
    const hits = searchProjects('clayco', context({ index: twoClaycos }))
    expect(hits.length).toBeGreaterThan(1)
  })

  it('returns nothing rather than the nearest thing, so the agent asks', () => {
    expect(searchProjects('bechtel', context())).toEqual([])
  })

  it('carries no rate, and no field that could hold one', () => {
    const json = JSON.stringify(searchProjects('clayco', context()))
    expect(json).not.toMatch(/rate|budget|cost|\$/i)
  })
})

describe('list_charge_codes', () => {
  it('names the tasklist but never a rate', () => {
    const codes = listChargeCodes('p-clayco', context())
    expect(codes).toEqual([
      { task_id: 't-sched', name: 'Scheduler', tasklist: 'Controls' },
      { task_id: 't-pm', name: 'Project Manager', tasklist: 'Controls' },
    ])
  })

  it('is empty for a project with none, rather than an error', () => {
    expect(listChargeCodes('p-google', context())).toEqual([])
  })
})

describe('propose_entries: what the model may not decide', () => {
  it('refuses a project id that is not in the index', () => {
    const result = buildEntries([proposed({ project_id: 'p-invented' })], context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]).toMatch(/not a real project/i)
  })

  it('refuses a task id that is not on that project', () => {
    const result = buildEntries([proposed({ task_id: 't-belongs-elsewhere' })], context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]).toMatch(/not a charge code/i)
  })

  it('resolves the date from the user’s words, in their timezone', () => {
    const result = buildEntries([proposed({ date: 'sat jul 25th' })], context())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries[0]!.date).toEqual({ status: 'resolved', date: '2026-07-25' })
  })

  it('hands a future date back as a problem instead of a card nobody reads', () => {
    // The old design put "Blocked: in the future" on the card and left the user to notice.
    const result = buildEntries([proposed({ date: 'tomorrow' })], context())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]).toMatch(/future/i)
    expect(result.problems[0]).toMatch(/ask/i)
  })

  it('hands back an unreadable date rather than logging a guess', () => {
    const result = buildEntries([proposed({ date: 'sometime last month' })], context())
    expect(result.ok).toBe(false)
  })

  it('rounds hours to the quarter, and refuses a day that is not one', () => {
    const ok = buildEntries([proposed({ hours: 2.4 })], context())
    expect(ok.ok && ok.entries[0]!.hours).toEqual({ status: 'resolved', hours: 2.5 })

    const tooLong = buildEntries([proposed({ hours: 30 })], context())
    expect(tooLong.ok).toBe(false)
    if (tooLong.ok) return
    expect(tooLong.problems[0]).toMatch(/more than a day/i)
  })

  it('refuses a description that would embarrass someone on an invoice', () => {
    // All filler, however many words — this is the one piece of user text a client reads.
    const filler = buildEntries(
      [proposed({ description: 'misc general stuff' })],
      context(),
    )
    expect(filler.ok).toBe(false)
    if (filler.ok) return
    expect(filler.problems[0]).toMatch(/invoice/i)

    // And too short to say anything at all, which is a different question to ask.
    const short = buildEntries([proposed({ description: 'x' })], context())
    expect(short.ok).toBe(false)
    if (short.ok) return
    expect(short.problems[0]).toMatch(/too short/i)
  })

  it('accepts a task the project does not have yet, to be created on confirm', () => {
    const result = buildEntries(
      [proposed({ task_id: null, new_task_name: 'i created an app' })],
      context(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries[0]!.task).toMatchObject({
      status: 'resolved',
      taskId: null,
      taskName: 'i created an app',
    })
  })

  it('refuses an entry with no task at all', () => {
    const result = buildEntries(
      [proposed({ task_id: null, new_task_name: null })],
      context(),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems[0]).toMatch(/no task/i)
  })

  it('builds several entries from one proposal, numbering the problems it reports', () => {
    const result = buildEntries(
      [
        proposed(),
        proposed({ project_id: 'p-google', task_id: null, new_task_name: 'x y z' }),
      ],
      context(),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries.map((e) => e.id)).toEqual(['e1', 'e2'])

    const bad = buildEntries([proposed(), proposed({ hours: 99 })], context())
    expect(bad.ok).toBe(false)
    if (bad.ok) return
    expect(bad.problems[0]).toContain('entry 2')
  })

  it('applies the configured default when billable was not stated', () => {
    const on = buildEntries([proposed({ billable: null })], context())
    expect(on.ok && on.entries[0]!.billable).toBe(true)

    const off = buildEntries(
      [proposed({ billable: null })],
      context({ defaultBillable: false }),
    )
    expect(off.ok && off.entries[0]!.billable).toBe(false)
  })
})
