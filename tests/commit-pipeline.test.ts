import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { commitEntries, type CommittableEntry } from '@/lib/commit/commit'
import { idempotencyKey } from '@/lib/commit/idempotency'
import { FakeDb } from './support/fake-db'

function entry(overrides: Partial<CommittableEntry> = {}): CommittableEntry {
  return {
    entryId: 'e1',
    projectId: '2620762000000790022',
    projectName: 'STE-100013 - Clayco: MS Data Center',
    taskId: '2620762000000790055',
    taskName: 'Engineering',
    date: '2026-07-24',
    hours: 8,
    billable: true,
    description: 'Structural review',
    ...overrides,
  }
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

const created = (id: string) =>
  new Response(JSON.stringify({ timelogs: { tasklogs: [{ id_string: id }] } }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  })

const input = (entries: CommittableEntry[]) => ({
  userId: 'user_1',
  draftId: 'draft_1',
  sourceMessageId: 'msg_1',
  ownerZuid: '917530087',
  entries,
})

describe('the happy path', () => {
  it('writes the ledger row, calls Zoho, then records the log id', async () => {
    const db = new FakeDb()
    const { client } = zoho(() => created('99'))

    const result = await commitEntries(db.client, client, input([entry()]))

    expect(result.created).toBe(1)
    const row = db.commitLogs[0]!
    expect(row.status).toBe('success')
    expect(row.zohoLogId).toBe('99')
    expect(row.completedAt).not.toBeNull()
    expect(row.projectName).toBe('STE-100013 - Clayco: MS Data Center')
  })

  it('stores the log date as the civil day, not an instant shifted by a zone', async () => {
    const db = new FakeDb()
    const { client } = zoho(() => created('99'))
    await commitEntries(db.client, client, input([entry({ date: '2026-07-24' })]))
    expect(db.commitLogs[0]!.logDate.toISOString()).toBe('2026-07-24T00:00:00.000Z')
  })

  it('commits several entries in order', async () => {
    const db = new FakeDb()
    let n = 0
    const { client } = zoho(() => created(String(++n)))

    const result = await commitEntries(
      db.client,
      client,
      input([
        entry({ entryId: 'a', description: 'first' }),
        entry({ entryId: 'b', description: 'second' }),
      ]),
    )

    expect(result.created).toBe(2)
    expect(result.outcomes.map((o) => o.entryId)).toEqual(['a', 'b'])
  })
})

describe('double confirmation', () => {
  it('does not call Zoho a second time for the same booking', async () => {
    const db = new FakeDb()
    const { client, fetchImpl } = zoho(() => created('99'))

    await commitEntries(db.client, client, input([entry()]))
    const second = await commitEntries(db.client, client, input([entry()]))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.duplicates).toBe(1)
    expect(second.created).toBe(0)
    expect(db.commitLogs).toHaveLength(1)
    // The user still learns which log it was, so the card can show it as logged.
    expect(second.outcomes[0]).toMatchObject({ status: 'duplicate', zohoLogId: '99' })
  })

  it('treats 8 and 8.00 with stray spacing as the same booking', async () => {
    const db = new FakeDb()
    const { client, fetchImpl } = zoho(() => created('99'))

    await commitEntries(db.client, client, input([entry({ hours: 8 })]))
    await commitEntries(
      db.client,
      client,
      input([entry({ hours: 8.0, description: '  Structural   review ' })]),
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('refuses to race a call that is still in flight', async () => {
    const db = new FakeDb()
    const { client, fetchImpl } = zoho(() => created('99'))
    // A row left pending is a call that may already have reached Zoho. A second call could
    // double-book, and an orphan a human can delete is the better failure.
    db.commitLogs.push({
      id: 'commit_pending',
      userId: 'user_1',
      projectId: entry().projectId,
      status: 'pending',
      logDate: new Date('2026-07-24T00:00:00Z'),
      idempotencyKey: idempotencyKey({
        userId: 'user_1',
        projectId: entry().projectId,
        taskId: entry().taskId,
        logDate: '2026-07-24',
        hours: 8,
        description: 'Structural review',
      }),
    })

    const result = await commitEntries(db.client, client, input([entry()]))

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(result.outcomes[0]!).toMatchObject({ status: 'failed', reason: 'in_flight' })
  })

  it('lets a failed entry be retried on the same row', async () => {
    const db = new FakeDb()
    let attempt = 0
    const { client } = zoho(() =>
      ++attempt === 1 ? new Response('boom', { status: 500 }) : created('99'),
    )

    const first = await commitEntries(db.client, client, input([entry()]))
    expect(first.failed).toBe(1)

    const second = await commitEntries(db.client, client, input([entry()]))
    expect(second.created).toBe(1)
    expect(db.commitLogs).toHaveLength(1)
    expect(db.commitLogs[0]!.status).toBe('success')
    expect(db.commitLogs[0]!.errorMessage).toBeNull()
  })
})

describe('partial failure', () => {
  it('logs the entries it can and reports the one it cannot', async () => {
    const db = new FakeDb()
    let n = 0
    const { client } = zoho(() =>
      ++n === 2 ? new Response('{"code":6404}', { status: 400 }) : created(String(n)),
    )

    const result = await commitEntries(
      db.client,
      client,
      input([
        entry({ entryId: 'a', description: 'first' }),
        entry({ entryId: 'b', description: 'second' }),
        entry({ entryId: 'c', description: 'third' }),
      ]),
    )

    // Three entries where the second fails should log two, not stop at one.
    expect(result.created).toBe(2)
    expect(result.failed).toBe(1)
    expect(result.outcomes[1]!).toMatchObject({ entryId: 'b', reason: 'zoho_error' })
    expect(db.commitLogs.filter((r) => r.status === 'success')).toHaveLength(2)
  })

  it('never puts a Zoho error body in the message a person reads', async () => {
    const db = new FakeDb()
    const { client } = zoho(
      () =>
        new Response('{"message":"Clayco: MS Data Center is closed"}', { status: 400 }),
    )
    const result = await commitEntries(db.client, client, input([entry()]))
    const outcome = result.outcomes[0]!
    expect(outcome.status).toBe('failed')
    expect(outcome.status === 'failed' ? outcome.detail : '').not.toContain('Clayco')
    expect(db.commitLogs[0]!.errorMessage).not.toContain('Clayco')
  })
})

describe('failures that will repeat', () => {
  it('stops after a rate limit and marks the rest skipped', async () => {
    const db = new FakeDb()
    let n = 0
    const throttle = () =>
      new Response(
        JSON.stringify({
          error: { status_code: 400, title: 'URL_ROLLING_THROTTLES_LIMIT_EXCEEDED' },
        }),
        { status: 400 },
      )
    const { client, fetchImpl } = zoho(() => (++n === 1 ? created('1') : throttle()))

    const result = await commitEntries(
      db.client,
      client,
      input([
        entry({ entryId: 'a', description: 'first' }),
        entry({ entryId: 'b', description: 'second' }),
        entry({ entryId: 'c', description: 'third' }),
      ]),
    )

    expect(result.created).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.skipped).toBe(1)
    // The third was never attempted: a locked-out quota fails every call identically, and
    // each further call sustains the lockout.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.outcomes[2]!).toMatchObject({
      status: 'skipped',
      reason: 'rate_limited',
    })
  })

  it('stops after the credential expires', async () => {
    const db = new FakeDb()
    const { client } = zoho(() => new Response('nope', { status: 401 }))

    const result = await commitEntries(
      db.client,
      client,
      input([entry({ entryId: 'a' }), entry({ entryId: 'b', description: 'second' })]),
    )

    expect(result.outcomes[0]!).toMatchObject({ status: 'failed', reason: 'credential' })
    expect(result.outcomes[1]!).toMatchObject({ status: 'skipped', reason: 'credential' })
  })

  it('leaves a skipped entry with no ledger row to retry against', async () => {
    const db = new FakeDb()
    const { client } = zoho(() => new Response('nope', { status: 401 }))
    await commitEntries(
      db.client,
      client,
      input([entry({ entryId: 'a' }), entry({ entryId: 'b', description: 'second' })]),
    )
    // Only the attempted entry is in the ledger — the untried one was never claimed.
    expect(db.commitLogs).toHaveLength(1)
  })
})

describe('a success Zoho described badly', () => {
  it('records it as logged even when the response has no id', async () => {
    const db = new FakeDb()
    const warn = vi.fn()
    const { client } = zoho(
      () => new Response(JSON.stringify({ response: 'ok' }), { status: 201 }),
    )

    const result = await commitEntries(db.client, client, input([entry()]), {
      logger: { info: vi.fn(), warn },
    })

    expect(result.created).toBe(1)
    expect(db.commitLogs[0]!.status).toBe('success')
    // Undo will refuse for this one, so it is worth a log line — but the hours are logged.
    expect(db.commitLogs[0]!.zohoLogId).toBeNull()
    expect(warn).toHaveBeenCalledWith('commit.log_id_unreadable', expect.anything())
  })
})
