import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import {
  _internal,
  createTimeLog,
  deleteTimeLog,
  formatZohoDate,
  formatZohoHours,
  listTaskLogs,
  parseZohoDate,
  readTimeLog,
} from '@/lib/zoho/timelogs'

function client(responder: (url: string, init?: RequestInit) => Response): {
  client: ZohoClient
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input, init) => responder(String(input), init))
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
    }),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('date format at the API boundary', () => {
  // The two formats are indistinguishable for the first twelve days of a month, and getting
  // it wrong books the wrong day with no error at all.
  it('sends MM-DD-YYYY, not the ISO date', () => {
    expect(formatZohoDate('2026-07-08')).toBe('07-08-2026')
    expect(formatZohoDate('2026-12-31')).toBe('12-31-2026')
  })

  it('refuses anything that is not an ISO date rather than guessing', () => {
    expect(() => formatZohoDate('07/08/2026')).toThrow(RangeError)
    expect(() => formatZohoDate('2026-7-8')).toThrow(RangeError)
  })

  it('reads Zoho’s own format back to ISO', () => {
    expect(parseZohoDate('07-08-2026')).toBe('2026-07-08')
    expect(parseZohoDate('nonsense')).toBeNull()
  })

  it('round-trips a date that would be ambiguous the other way round', () => {
    expect(parseZohoDate(formatZohoDate('2026-07-08'))).toBe('2026-07-08')
  })
})

describe('hours as hh:mm', () => {
  it('converts the quarter-hour steps people actually type', () => {
    expect(formatZohoHours(0.25)).toBe('00:15')
    expect(formatZohoHours(1.5)).toBe('01:30')
    expect(formatZohoHours(8)).toBe('08:00')
    expect(formatZohoHours(24)).toBe('24:00')
  })

  it('rounds to the nearest minute, which is the resolution Zoho stores', () => {
    // A third of an hour is twenty minutes, not 0.333 of one.
    expect(formatZohoHours(1 / 3)).toBe('00:20')
    expect(formatZohoHours(2.51)).toBe('02:31')
  })

  it('refuses negative or non-finite hours', () => {
    expect(() => formatZohoHours(-1)).toThrow(RangeError)
    expect(() => formatZohoHours(Number.NaN)).toThrow(RangeError)
  })
})

describe('reading a log back', () => {
  const raw = {
    id: 2620762000000790000,
    id_string: '2620762000000790022',
    log_date: '07-24-2026',
    hours: '1',
    minutes: '30',
    total_minutes: '90',
    bill_status: 'Billable',
    notes: 'Structural review',
    owner_id: '917530087',
    owner_name: 'Nuno Barreto',
    added_via: 'api',
    approval_status: 'Approved',
    task: { id_string: '2620762000000790055', name: 'Engineering' },
  }

  it('takes id_string, never the corrupted numeric id', () => {
    expect(readTimeLog(raw)?.id).toBe('2620762000000790022')
  })

  it('refuses a log with no id_string rather than addressing the wrong record', () => {
    expect(readTimeLog({ ...raw, id_string: undefined })).toBeNull()
  })

  it('reads hours, date, owner and origin', () => {
    const log = readTimeLog(raw)!
    expect(log.hours).toBe(1.5)
    expect(log.date).toBe('2026-07-24')
    expect(log.ownerZuid).toBe('917530087')
    expect(log.addedVia).toBe('api')
    expect(log.billable).toBe(true)
  })

  it('treats only “Non Billable” as non-billable', () => {
    expect(readTimeLog({ ...raw, bill_status: 'Non Billable' })?.billable).toBe(false)
    expect(readTimeLog({ ...raw, bill_status: undefined })?.billable).toBe(true)
  })
})

describe('envelope handling', () => {
  const log = { id_string: '1', log_date: '07-24-2026' }

  it('finds the log in each shape Zoho might wrap it in', () => {
    expect(_internal.extractLogs({ timelogs: { tasklogs: [log] } })).toHaveLength(1)
    expect(_internal.extractLogs({ timelogs: [log] })).toHaveLength(1)
    expect(_internal.extractLogs({ tasklogs: [log] })).toHaveLength(1)
    expect(_internal.extractLogs(log)).toHaveLength(1)
  })

  it('gives up rather than inventing an id from an unknown shape', () => {
    expect(_internal.extractLogs({ surprise: { nested: log } })).toEqual([])
    // A 204 reaches here as undefined, which is an empty list and not an error.
    expect(_internal.extractLogs(undefined)).toEqual([])
  })
})

describe('createTimeLog', () => {
  it('posts a form with the converted date, hours and bill status', async () => {
    const { client: zoho, fetchImpl } = client(() =>
      json(
        { timelogs: { tasklogs: [{ id_string: '99', log_date: '07-24-2026' }] } },
        201,
      ),
    )

    const result = await createTimeLog(zoho, {
      projectId: 'p1',
      taskId: 't1',
      date: '2026-07-24',
      hours: 1.5,
      billable: false,
      notes: 'Structural review',
      ownerZuid: '917530087',
    })

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('projects/p1/tasks/t1/logs/')
    expect(init?.method).toBe('POST')

    const form = new URLSearchParams(String(init?.body))
    expect(form.get('date')).toBe('07-24-2026')
    expect(form.get('hours')).toBe('01:30')
    expect(form.get('bill_status')).toBe('Non Billable')
    expect(form.get('notes')).toBe('Structural review')
    expect(form.get('owner')).toBe('917530087')

    expect(result.log?.id).toBe('99')
  })

  it('omits owner when we do not know the zuid, leaving the credential to decide', async () => {
    const { client: zoho, fetchImpl } = client(() =>
      json({ tasklogs: [{ id_string: '1' }] }),
    )
    await createTimeLog(zoho, {
      projectId: 'p1',
      taskId: 't1',
      date: '2026-07-24',
      hours: 1,
      billable: true,
      notes: 'x',
      ownerZuid: null,
    })
    const form = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body))
    expect(form.has('owner')).toBe(false)
  })

  it('reports an unreadable success as a success with no id', async () => {
    // Zoho took the write. Calling this a failure would invite a retry that double-books,
    // which is the one outcome a timesheet must never produce.
    const { client: zoho } = client(() => json({ response: 'ok' }, 201))
    const result = await createTimeLog(zoho, {
      projectId: 'p1',
      taskId: 't1',
      date: '2026-07-24',
      hours: 1,
      billable: true,
      notes: 'x',
    })
    expect(result.log).toBeNull()
    expect(result.raw).toEqual({ response: 'ok' })
  })
})

describe('deleteTimeLog and listTaskLogs', () => {
  it('deletes by log id', async () => {
    const { client: zoho, fetchImpl } = client(
      () =>
        new Response(JSON.stringify({ response: 'Timesheet log Deleted Successfully' })),
    )
    await deleteTimeLog(zoho, { projectId: 'p1', taskId: 't1', logId: 'l1' })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('projects/p1/tasks/t1/logs/l1/')
    expect(init?.method).toBe('DELETE')
  })

  it('reads an empty 204 as no logs rather than an error', async () => {
    const { client: zoho } = client(() => new Response(null, { status: 204 }))
    await expect(listTaskLogs(zoho, { projectId: 'p1', taskId: 't1' })).resolves.toEqual(
      [],
    )
  })

  it('drops rows it cannot identify instead of failing the page', async () => {
    const { client: zoho } = client(() =>
      json({ timelogs: { tasklogs: [{ id_string: '1' }, { notes: 'no id' }] } }),
    )
    const logs = await listTaskLogs(zoho, { projectId: 'p1', taskId: 't1' })
    expect(logs.map((l) => l.id)).toEqual(['1'])
  })
})
