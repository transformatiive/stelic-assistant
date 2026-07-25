import { describe, expect, it } from 'vitest'
import type { ExtractedEntry } from '@/lib/extract/schema'
import type { ChargeCode } from '@/lib/index/build'
import {
  resolveEntries,
  resolveEntry,
  resolveTask,
  type ResolveContext,
} from '@/lib/resolve/entry'
import {
  blockedReason,
  entryState,
  isDraftReady,
  nextQuestion,
  readyEntries,
  SLOT_ORDER,
} from '@/lib/resolve/slots'
import { applyAnswer } from '@/lib/resolve/draft'

const TODAY = '2026-07-25' // a Saturday

const INDEX = [
  {
    projectId: 'p-clayco',
    projectName: '1066 - 1066 - Clayco EKI Data Center',
    accountName: 'Clayco Construction Company Inc',
    aliases: ['Clayco Construction Company Inc', 'Clayco', 'Clayco EKI Data Center'],
  },
  {
    projectId: 'p-google',
    projectName: 'Google LLC — 1080 - Google: Capital Projects Dashboard',
    accountName: 'Google LLC',
    aliases: ['Google LLC', 'Google', 'Capital Projects Dashboard'],
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
  ['p-google', [{ taskId: 't-only', taskName: 'Delivery', completed: false }]],
])

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    index: INDEX,
    chargeCodes: CHARGE_CODES,
    timezone: 'UTC',
    now: new Date(`${TODAY}T12:00:00Z`),
    defaultBillable: true,
    ...overrides,
  }
}

function extracted(over: Partial<ExtractedEntry> = {}): ExtractedEntry {
  return {
    project_query: 'clayco',
    date_expression: 'yesterday',
    hours: 8,
    description: 'schedule updates and progress meeting',
    billable: null,
    charge_code_hint: null,
    ...over,
  }
}

describe('resolveEntry', () => {
  it('resolves everything a complete sentence gives it', () => {
    const entry = resolveEntry(extracted({ charge_code_hint: 'scheduler' }), context())

    expect(entry.project).toMatchObject({ status: 'resolved', projectId: 'p-clayco' })
    expect(entry.task).toMatchObject({ status: 'resolved', taskId: 't-sched' })
    expect(entry.date).toEqual({ status: 'resolved', date: '2026-07-24' })
    expect(entry.hours).toEqual({ status: 'resolved', hours: 8 })
    expect(entry.description.status).toBe('resolved')
    expect(entryState(entry)).toBe('ready')
  })

  it('explains the project match in words a person can check', () => {
    const entry = resolveEntry(extracted(), context())
    if (entry.project.status !== 'resolved') throw new Error('expected resolved')
    // "matched the client name (Clayco…)" — not just an assertion that it is right.
    expect(entry.project.why).toMatch(/matched/)
    expect(entry.project.why).toMatch(/clayco/i)
  })

  it('keeps the user’s own words, so the bot asks about the right thing', () => {
    const entry = resolveEntry(extracted({ project_query: 'the clacyo job' }), context())
    expect(entry.said.project).toBe('the clacyo job')
  })

  it('applies the configured default when billable was not stated', () => {
    expect(resolveEntry(extracted({ billable: null }), context()).billable).toBe(true)
    expect(
      resolveEntry(extracted({ billable: null }), context({ defaultBillable: false }))
        .billable,
    ).toBe(false)
  })

  it('lets an explicit statement beat the default', () => {
    expect(resolveEntry(extracted({ billable: false }), context()).billable).toBe(false)
  })

  it('resolves slots independently, so one gap does not hide another', () => {
    // No description and no hours: both must surface, not one at a time.
    const entry = resolveEntry(extracted({ hours: null, description: null }), context())
    expect(entry.project.status).toBe('resolved')
    expect(entry.hours).toEqual({ status: 'unresolved', reason: 'missing' })
    expect(entry.description).toEqual({ status: 'unresolved', reason: 'missing' })
  })

  it('blocks a future date rather than asking about it', () => {
    // There is no answer that makes tomorrow acceptable, so it is not a question.
    const entry = resolveEntry(extracted({ date_expression: '2026-08-01' }), context())
    expect(entry.date).toMatchObject({ status: 'blocked', reason: 'future' })
    expect(entryState(entry)).toBe('blocked')
    expect(blockedReason(entry)).toMatch(/future/)
  })

  it('gives each entry of a multi-entry turn its own id', () => {
    const entries = resolveEntries(
      [
        extracted({ date_expression: 'Monday' }),
        extracted({ date_expression: 'Tuesday' }),
      ],
      context(),
    )
    expect(entries.map((e) => e.id)).toEqual(['e1', 'e2'])
    expect(entries[0]!.date).not.toEqual(entries[1]!.date)
  })
})

describe('resolveTask', () => {
  const resolvedProject = {
    status: 'resolved' as const,
    projectId: 'p-google',
    projectName: 'Google',
    why: '',
  }

  it('resolves silently when the project has exactly one task', () => {
    const task = resolveTask(resolvedProject, null, context())
    expect(task).toMatchObject({ status: 'resolved', taskId: 't-only' })
  })

  it('offers chips when several tasks are possible', () => {
    const task = resolveTask(
      { ...resolvedProject, projectId: 'p-clayco' },
      null,
      context(),
    )
    expect(task.status).toBe('unresolved')
    if (task.status !== 'unresolved') return
    expect(task.reason).toBe('ambiguous')
    expect(task.candidates.map((c) => c.taskId)).toEqual(['t-sched', 't-pm'])
  })

  it('narrows on a hint the user actually said', () => {
    const task = resolveTask(
      { ...resolvedProject, projectId: 'p-clayco' },
      'scheduler',
      context(),
    )
    expect(task).toMatchObject({ status: 'resolved', taskId: 't-sched' })
    if (task.status === 'resolved') expect(task.why).toContain('scheduler')
  })

  it('falls back to the full list when the hint matches nothing', () => {
    // Better to ask than to silently drop every option because a hint was unusable.
    const task = resolveTask(
      { ...resolvedProject, projectId: 'p-clayco' },
      'welding',
      context(),
    )
    expect(task.status).toBe('unresolved')
    if (task.status === 'unresolved') expect(task.candidates).toHaveLength(2)
  })

  it('cannot resolve a task before the project is known', () => {
    const task = resolveTask(
      { status: 'unresolved', reason: 'no_match', candidates: [] },
      null,
      context(),
    )
    expect(task).toMatchObject({ status: 'unresolved', reason: 'unknown_project' })
  })

  it('reports a project with no tasks as such', () => {
    const task = resolveTask(
      { ...resolvedProject, projectId: 'p-empty' },
      null,
      context({ chargeCodes: new Map() }),
    )
    expect(task).toMatchObject({ status: 'unresolved', reason: 'none_available' })
  })
})

describe('nextQuestion', () => {
  it('asks about the project before anything that depends on it', () => {
    expect(SLOT_ORDER.indexOf('project')).toBeLessThan(SLOT_ORDER.indexOf('task'))

    const entry = resolveEntry(
      extracted({
        project_query: 'zzz nothing like this',
        hours: null,
        description: null,
      }),
      context(),
    )
    expect(nextQuestion([entry])).toMatchObject({ entryId: entry.id, slot: 'project' })
  })

  it('offers the candidates as chips, hinted by client name', () => {
    const ambiguous = resolveEntry(extracted({ project_query: 'google' }), context())
    // "google" resolves cleanly here, so construct the ambiguous case directly.
    const entry = {
      ...ambiguous,
      project: {
        status: 'unresolved' as const,
        reason: 'ambiguous' as const,
        candidates: [
          {
            projectId: 'p-clayco',
            projectName: 'Clayco EKI',
            accountName: 'Clayco Construction Company Inc',
            matchedText: 'clayco',
          },
        ],
      },
    }
    const question = nextQuestion([entry])
    expect(question?.chips).toEqual([
      {
        value: 'p-clayco',
        label: 'Clayco EKI',
        hint: 'Clayco Construction Company Inc',
      },
    ])
  })

  it('never puts a rate on a chip, only the tasklist', () => {
    const entry = resolveEntry(extracted({ project_query: 'clayco' }), context())
    const question = nextQuestion([entry])
    expect(question?.slot).toBe('task')
    expect(question?.chips).toEqual([
      { value: 't-sched', label: 'Scheduler', hint: 'Controls' },
      { value: 't-pm', label: 'Project Manager', hint: 'Controls' },
    ])
    expect(JSON.stringify(question?.chips)).not.toMatch(/rate|\$|usd/i)
  })

  it('offers no chips where there is no finite candidate set', () => {
    const entry = resolveEntry(
      extracted({ charge_code_hint: 'scheduler', hours: null }),
      context(),
    )
    expect(nextQuestion([entry])).toMatchObject({ slot: 'hours', chips: [] })
  })

  it('finishes one entry before moving to the next', () => {
    const entries = resolveEntries(
      [
        extracted({ charge_code_hint: 'scheduler', hours: null, description: null }),
        extracted({ charge_code_hint: 'scheduler', date_expression: null }),
      ],
      context(),
    )
    // Entry 1 needs hours and a description; entry 2 needs a date. Ask entry 1 first.
    expect(nextQuestion(entries)).toMatchObject({ entryId: 'e1', slot: 'hours' })
  })

  it('skips a blocked entry rather than asking an unanswerable question', () => {
    const entries = resolveEntries(
      [
        extracted({ date_expression: '2026-12-01' }),
        extracted({ charge_code_hint: 'scheduler', hours: null }),
      ],
      context(),
    )
    expect(entryState(entries[0]!)).toBe('blocked')
    expect(nextQuestion(entries)).toMatchObject({ entryId: 'e2', slot: 'hours' })
  })

  it('returns nothing when the draft is ready', () => {
    const entries = resolveEntries(
      [extracted({ charge_code_hint: 'scheduler' })],
      context(),
    )
    expect(nextQuestion(entries)).toBeNull()
    expect(isDraftReady(entries)).toBe(true)
  })

  it('does not call an empty draft ready', () => {
    expect(isDraftReady([])).toBe(false)
  })

  it('a blocked entry keeps the draft from being ready but does not stop the others', () => {
    const entries = resolveEntries(
      [
        extracted({ date_expression: '2026-12-01', charge_code_hint: 'scheduler' }),
        extracted({ charge_code_hint: 'scheduler' }),
      ],
      context(),
    )
    expect(isDraftReady(entries)).toBe(false)
    expect(readyEntries(entries).map((e) => e.id)).toEqual(['e2'])
  })
})

describe('applyAnswer', () => {
  const ambiguous = () =>
    resolveEntries([extracted({ project_query: 'clayco', hours: null })], context())

  it('re-resolves the task when the project changes', () => {
    // The task list belongs to the project; keeping the old one would log to the wrong task.
    const entries = ambiguous()
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'project', value: 'p-google' },
      context(),
    )
    expect(updated[0]!.project).toMatchObject({ projectId: 'p-google' })
    // p-google has exactly one task, so the answer resolved the next slot for free.
    expect(updated[0]!.task).toMatchObject({ status: 'resolved', taskId: 't-only' })
  })

  it('does not turn an already-answered slot back into a question', () => {
    const entries = ambiguous()
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'hours', value: '7:30' },
      context(),
    )
    expect(updated[0]!.hours).toEqual({ status: 'resolved', hours: 7.5 })
    expect(updated[0]!.description.status).toBe('resolved')
    expect(updated[0]!.date).toEqual({ status: 'resolved', date: '2026-07-24' })
  })

  it('accepts a date in the user’s own words, not just an ISO string', () => {
    const entries = resolveEntries([extracted({ date_expression: null })], context())
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'date', value: 'last tuesday' },
      context(),
    )
    expect(updated[0]!.date).toMatchObject({ status: 'resolved' })
  })

  it('re-validates rather than trusting the answer', () => {
    const entries = ambiguous()
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'description', value: 'stuff' },
      context(),
    )
    expect(updated[0]!.description.status).toBe('unresolved')
  })

  it('re-matches a typed project answer, rather than requiring a chip’s literal id', () => {
    // The live bug: a chip posts an id from the index directly (`p-google` above), but typing
    // an answer instead — CHAT-7's free-text fallback — posts what was actually typed, and
    // that used to look up nothing, leave the entry untouched, and re-ask the identical
    // question forever. A typed name gets the same matcher a fresh mention would.
    const entries = resolveEntries(
      [extracted({ project_query: 'nothing that matches anything here' })],
      context(),
    )
    expect(entries[0]!.project.status).toBe('unresolved')

    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'project', value: 'google' },
      context(),
    )
    expect(updated[0]!.project).toMatchObject({
      status: 'resolved',
      projectId: 'p-google',
    })
  })

  it('updates what the person said, so a repeated question quotes the latest attempt', () => {
    const entries = ambiguous()
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'project', value: 'still not it' },
      context(),
    )
    expect(updated[0]!.said.project).toBe('still not it')
  })

  it('is honestly unresolved on a typed answer that matches nothing, not silently unchanged', () => {
    const entries = ambiguous()
    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'project', value: 'something nobody has heard of' },
      context(),
    )
    expect(updated[0]!.project).toEqual({
      status: 'unresolved',
      reason: 'no_match',
      candidates: [],
    })
  })

  it('re-matches a typed task answer against the project’s own charge codes', () => {
    const entries = resolveEntries(
      [extracted({ project_query: 'clayco', charge_code_hint: null })],
      context(),
    )
    expect(entries[0]!.task.status).toBe('unresolved')

    const updated = applyAnswer(
      entries,
      { entryId: 'e1', slot: 'task', value: 'scheduler' },
      context(),
    )
    expect(updated[0]!.task).toMatchObject({ status: 'resolved', taskId: 't-sched' })
  })

  it('touches only the entry it names', () => {
    const entries = resolveEntries(
      [extracted({ hours: null }), extracted({ hours: null })],
      context(),
    )
    const updated = applyAnswer(
      entries,
      { entryId: 'e2', slot: 'hours', value: '4' },
      context(),
    )
    expect(updated[0]!.hours.status).toBe('unresolved')
    expect(updated[1]!.hours).toEqual({ status: 'resolved', hours: 4 })
  })
})
