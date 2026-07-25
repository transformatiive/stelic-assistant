import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { readWeek } from '@/lib/entries/week'
import { listWeekLogs, parseZohoHours } from '@/lib/zoho/timelogs'
import { formatIso, parseIso, startOfWeek } from '@/lib/resolve/civil-date'

/**
 * The fixture is the live response shape, trimmed — captured from the portal on 2026-07-25
 * once the contract was found. Inventing this shape is how a parser ends up matching nothing.
 */
const LIVE_WEEK = {
  timelogs: {
    date: [
      {
        date: '07-19-2026',
        display_format: '07-19-2026 12:00:00 AM',
        date_long: 1784444400000,
        total_hours: '8:00',
        tasklogs: [
          {
            id: 2620762000000819000,
            id_string: '2620762000000819001',
            notes: 'Structural review',
            owner_id: '917530087',
            owner_name: 'Nuno Barreto',
            project: {
              name: 'Transformatiive — End to end Demo to Partners',
              id_string: '2620762000000775008',
              id: 2620762000000775000,
            },
            task: { name: 'Weekly Project Update', id_string: '2620762000000776090' },
            hours: 1,
            minutes: 0,
            total_minutes: 60,
            hours_display: '01:00',
            bill_status: 'Billable',
            approval_status: 'Approved',
          },
          {
            id_string: '2620762000000819021',
            notes: 'Punch list walkthrough',
            owner_id: '917530087',
            project: { name: 'Clayco: MS Data Center', id_string: '2620762000000790022' },
            task: { name: 'Engineering', id_string: '2620762000000790055' },
            total_minutes: 420,
            bill_status: 'Non Billable',
          },
        ],
      },
      {
        date: '07-21-2026',
        total_hours: '6:30',
        tasklogs: [
          {
            id_string: '2620762000000819045',
            notes: 'Commissioning support',
            owner_id: '917530087',
            project: { name: 'Clayco: MS Data Center', id_string: '2620762000000790022' },
            task: { name: 'Engineering', id_string: '2620762000000790055' },
            total_minutes: 390,
          },
        ],
      },
    ],
  },
}

function zoho(responder: () => Response): {
  client: ZohoClient
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responder())
  return {
    fetchImpl,
    client: new ZohoClient({
      baseUrl: 'https://projectsapi.zoho.com/restapi/portal/911636649/',
      tokens: {
        mode: 'user',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
      maxRateLimitRetries: 0,
    }),
  }
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('the call itself', () => {
  it('has no trailing slash, which is the entire contract', async () => {
    // `logs/` answers 6891 "Given URL is wrong"; `logs` answers 200. Every documented
    // parameter shape was tried against the trailing-slash form and all of them failed.
    const { client, fetchImpl } = zoho(() => json(LIVE_WEEK))
    await listWeekLogs(client, { zuid: '917530087', date: '2026-07-19' })

    const url = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(url.pathname).toBe('/restapi/portal/911636649/logs')
    expect(url.pathname.endsWith('/')).toBe(false)
  })

  it('sends the zuid, the required parameters and a US-format date', async () => {
    const { client, fetchImpl } = zoho(() => json(LIVE_WEEK))
    await listWeekLogs(client, { zuid: '917530087', date: '2026-07-19' })

    const url = new URL(String(fetchImpl.mock.calls[0]![0]))
    // A zpuid here returns 204 — an empty week rather than an error, so the wrong id would
    // read as "you logged nothing" and be very hard to notice.
    expect(url.searchParams.get('users_list')).toBe('917530087')
    expect(url.searchParams.get('view_type')).toBe('week')
    expect(url.searchParams.get('date')).toBe('07-19-2026')
    // Omitting either of these gives 6831 "Input Parameter Missing".
    expect(url.searchParams.get('component_type')).toBe('task')
    expect(url.searchParams.get('users_list')).not.toBeNull()
  })

  it('reads an empty 204 week as no logs rather than an error', async () => {
    const { client } = zoho(() => new Response(null, { status: 204 }))
    await expect(
      listWeekLogs(client, { zuid: '917530087', date: '2026-07-26' }),
    ).resolves.toEqual([])
  })
})

describe('parsing the live shape', () => {
  it('takes the day from the group, not from the log', async () => {
    // A log carries only the day it was *created*, which for a backdated entry is a
    // different day entirely.
    const { client } = zoho(() => json(LIVE_WEEK))
    const days = await listWeekLogs(client, { zuid: '917530087', date: '2026-07-19' })
    expect(days.map((d) => d.date)).toEqual(['2026-07-19', '2026-07-21'])
    expect(days[0]!.logs.every((l) => l.date === '2026-07-19')).toBe(true)
  })

  it('reads Zoho’s own hh:mm day total', () => {
    expect(parseZohoHours('8:00')).toBe(8)
    expect(parseZohoHours('6:30')).toBe(6.5)
    expect(parseZohoHours('nonsense')).toBe(0)
  })

  it('carries the project and task names a person needs to recognise the entry', async () => {
    const { client } = zoho(() => json(LIVE_WEEK))
    const days = await listWeekLogs(client, { zuid: '917530087', date: '2026-07-19' })
    expect(days[0]!.logs[0]).toMatchObject({
      id: '2620762000000819001',
      projectName: 'Transformatiive — End to end Demo to Partners',
      taskName: 'Weekly Project Update',
      hours: 1,
      billable: true,
    })
    expect(days[0]!.logs[1]).toMatchObject({ billable: false, hours: 7 })
  })
})

describe('the week view', () => {
  it('runs Sunday to Saturday, because the portal does', async () => {
    const { client } = zoho(() => json(LIVE_WEEK))
    const week = await readWeek(client, {
      zuid: '917530087',
      timezone: 'America/New_York',
      date: '2026-07-22',
    })
    // 2026-07-19 is a Sunday.
    expect(week.weekStart).toBe('2026-07-19')
    expect(week.weekEnd).toBe('2026-07-25')
    expect(week.days[0]!.weekday).toBe(7)
    expect(week.days[1]!.weekday).toBe(1)
  })

  it('shows all seven days, including the empty ones', async () => {
    // A week that silently omits Thursday reads as "nothing to see"; a Thursday showing 0h
    // reads as "you logged nothing on Thursday", which is the question being asked.
    const { client } = zoho(() => json(LIVE_WEEK))
    const week = await readWeek(client, {
      zuid: '917530087',
      timezone: 'America/New_York',
      date: '2026-07-19',
    })

    expect(week.days).toHaveLength(7)
    expect(week.days.map((d) => d.hours)).toEqual([8, 0, 6.5, 0, 0, 0, 0])
    expect(week.days[1]!.entries).toEqual([])
  })

  it('totals the week from Zoho’s own per-day figures', async () => {
    const { client } = zoho(() => json(LIVE_WEEK))
    const week = await readWeek(client, {
      zuid: '917530087',
      timezone: 'America/New_York',
      date: '2026-07-19',
    })
    expect(week.totalHours).toBe(14.5)
  })

  it('defaults to the week containing today where the person is', async () => {
    const { client, fetchImpl } = zoho(() => new Response(null, { status: 204 }))
    // 03:30 UTC on the 26th: still the 25th in New York, already the 26th in Lisbon — and
    // the 26th is a Sunday, so the two people are in different weeks.
    const now = new Date('2026-07-26T03:30:00Z')

    await readWeek(client, { zuid: '1', timezone: 'America/New_York', now })
    await readWeek(client, { zuid: '1', timezone: 'Europe/Lisbon', now })

    const dates = fetchImpl.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get('date'),
    )
    expect(dates).toEqual(['07-19-2026', '07-26-2026'])
  })

  it('falls back to today rather than refusing a malformed date', async () => {
    const { client, fetchImpl } = zoho(() => new Response(null, { status: 204 }))
    await readWeek(client, {
      zuid: '1',
      timezone: 'America/New_York',
      date: 'last tuesday',
      now: new Date('2026-07-22T16:00:00Z'),
    })
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('date')).toBe(
      '07-19-2026',
    )
  })
})

describe('startOfWeek', () => {
  const sundayOf = (iso: string) => formatIso(startOfWeek(parseIso(iso)!))

  it('lands on the Sunday on or before the date', () => {
    expect(sundayOf('2026-07-19')).toBe('2026-07-19') // a Sunday, unchanged
    expect(sundayOf('2026-07-20')).toBe('2026-07-19') // Monday
    expect(sundayOf('2026-07-25')).toBe('2026-07-19') // Saturday
    expect(sundayOf('2026-07-26')).toBe('2026-07-26') // the next Sunday
  })

  it('crosses a month and a year boundary', () => {
    expect(sundayOf('2026-08-01')).toBe('2026-07-26')
    expect(sundayOf('2027-01-01')).toBe('2026-12-27')
  })
})
