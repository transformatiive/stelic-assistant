import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { undoEntry } from '@/lib/commit/undo'
import { FakeDb, type CommitLogRow } from './support/fake-db'

function zoho(responder: () => Response = () => new Response('{"response":"ok"}')): {
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

/** Committed at 09:00 New York on 25 July. */
const COMMITTED_AT = new Date('2026-07-25T13:00:00Z')

function seed(db: FakeDb, overrides: Partial<CommitLogRow> = {}): CommitLogRow {
  const row: CommitLogRow = {
    id: 'commit_1',
    userId: 'user_1',
    projectId: '2620762000000790022',
    taskId: '2620762000000790055',
    status: 'success',
    zohoLogId: '2620762000000790099',
    logDate: new Date('2026-07-24T00:00:00Z'),
    completedAt: COMMITTED_AT,
    createdAt: COMMITTED_AT,
    ...overrides,
  }
  db.commitLogs.push(row)
  return row
}

const base = {
  userId: 'user_1',
  commitLogId: 'commit_1',
  timezone: 'America/New_York',
}

describe('undoing what the app logged today', () => {
  it('deletes the log and marks the row undone', async () => {
    const db = new FakeDb()
    seed(db)
    const { client, fetchImpl } = zoho()

    const result = await undoEntry(db.client, client, {
      ...base,
      now: new Date('2026-07-25T19:00:00Z'), // 15:00 New York, same day
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toContain(
      'projects/2620762000000790022/tasks/2620762000000790055/logs/2620762000000790099/',
    )
    expect(init?.method).toBe('DELETE')
    expect(db.commitLogs[0]!.status).toBe('undone')
  })

  it('undoes a backdated entry, because the day that matters is the commit’s', async () => {
    // Logging yesterday's hours this morning is undoable this morning.
    const db = new FakeDb()
    seed(db, { logDate: new Date('2026-07-20T00:00:00Z') })
    const { client } = zoho()
    const result = await undoEntry(db.client, client, {
      ...base,
      now: new Date('2026-07-25T19:00:00Z'),
    })
    expect(result.ok).toBe(true)
  })

  it('is idempotent, because the failure mode of an undo button is a double tap', async () => {
    const db = new FakeDb()
    seed(db, { status: 'undone' })
    const { client, fetchImpl } = zoho()

    const result = await undoEntry(db.client, client, { ...base, now: COMMITTED_AT })

    expect(result).toMatchObject({ ok: true, alreadyUndone: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('what undo refuses', () => {
  it('refuses once the day has passed', async () => {
    const db = new FakeDb()
    seed(db)
    const { client, fetchImpl } = zoho()

    const result = await undoEntry(db.client, client, {
      ...base,
      now: new Date('2026-07-26T13:00:00Z'),
    })

    expect(result).toMatchObject({ ok: false, refusal: 'not_today' })
    expect(result.ok === false && result.message).toContain('Zoho Projects')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('decides “today” in the person’s own zone, not the server’s', async () => {
    // One instant, 04:30 on the 26th in Lisbon and 23:30 on the 25th in New York. A commit
    // made at 23:00 Lisbon on the 25th is yesterday's for them and still today's for a
    // colleague in New York, so the same row undoes for one and refuses for the other.
    const db = new FakeDb()
    seed(db, { completedAt: new Date('2026-07-26T03:00:00Z') })
    const { client } = zoho()
    const at = new Date('2026-07-26T03:30:00Z')

    await expect(
      undoEntry(db.client, client, { ...base, timezone: 'America/New_York', now: at }),
    ).resolves.toMatchObject({ ok: true })

    db.commitLogs[0]!.status = 'success'
    await expect(
      undoEntry(db.client, client, { ...base, timezone: 'Europe/Lisbon', now: at }),
    ).resolves.toMatchObject({ ok: true })

    // And a commit that was yesterday in Lisbon but today in New York.
    db.commitLogs[0]!.status = 'success'
    db.commitLogs[0]!.completedAt = new Date('2026-07-25T22:00:00Z')
    await expect(
      undoEntry(db.client, client, { ...base, timezone: 'Europe/Lisbon', now: at }),
    ).resolves.toMatchObject({ ok: false, refusal: 'not_today' })
  })

  it('refuses a log it has no record of creating', async () => {
    const db = new FakeDb()
    const { client, fetchImpl } = zoho()
    const result = await undoEntry(db.client, client, { ...base, now: COMMITTED_AT })
    expect(result).toMatchObject({ ok: false, refusal: 'not_found' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('treats another person’s log as one that does not exist', async () => {
    const db = new FakeDb()
    seed(db)
    const { client } = zoho()
    const result = await undoEntry(db.client, client, {
      ...base,
      userId: 'someone_else',
      now: COMMITTED_AT,
    })
    expect(result).toMatchObject({ ok: false, refusal: 'not_found' })
  })

  it('refuses an entry that never reached Zoho', async () => {
    const db = new FakeDb()
    seed(db, { status: 'failed' })
    const { client } = zoho()
    const result = await undoEntry(db.client, client, { ...base, now: COMMITTED_AT })
    expect(result).toMatchObject({ ok: false, refusal: 'never_created' })
  })

  it('refuses when Zoho never told us which log it made', async () => {
    // The write succeeded; only our handle on it is missing. Guessing would delete the
    // wrong log, so undo degrades instead.
    const db = new FakeDb()
    seed(db, { zohoLogId: null })
    const { client, fetchImpl } = zoho()
    const result = await undoEntry(db.client, client, { ...base, now: COMMITTED_AT })
    expect(result).toMatchObject({ ok: false, refusal: 'no_log_id' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('leaves the row alone when Zoho refuses the delete', async () => {
    const db = new FakeDb()
    seed(db)
    const { client } = zoho(() => new Response('nope', { status: 500 }))

    const result = await undoEntry(db.client, client, {
      ...base,
      now: new Date('2026-07-25T19:00:00Z'),
    })

    expect(result).toMatchObject({ ok: false, refusal: 'zoho_error' })
    // Still `success`, which is what it is — the log is in Zoho.
    expect(db.commitLogs[0]!.status).toBe('success')
  })
})

describe('an already-billed period', () => {
  it('refuses rather than orphaning a pointer in the billing ledger', async () => {
    const db = new FakeDb()
    seed(db, { logDate: new Date('2026-06-30T00:00:00Z') })
    const { client, fetchImpl } = zoho()

    const result = await undoEntry(db.client, client, {
      ...base,
      billingLockedThrough: '2026-06-30',
      now: new Date('2026-07-25T19:00:00Z'),
    })

    expect(result).toMatchObject({ ok: false, refusal: 'billed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows a log the day after the boundary', async () => {
    const db = new FakeDb()
    seed(db, { logDate: new Date('2026-07-01T00:00:00Z') })
    const { client } = zoho()
    const result = await undoEntry(db.client, client, {
      ...base,
      billingLockedThrough: '2026-06-30',
      now: new Date('2026-07-25T19:00:00Z'),
    })
    expect(result.ok).toBe(true)
  })

  it('does not block anything when no boundary is configured', async () => {
    const db = new FakeDb()
    seed(db, { logDate: new Date('2020-01-01T00:00:00Z') })
    const { client } = zoho()
    const result = await undoEntry(db.client, client, {
      ...base,
      now: new Date('2026-07-25T19:00:00Z'),
    })
    expect(result.ok).toBe(true)
  })
})

describe('approval status', () => {
  it('is not consulted at all', async () => {
    // Every API-created log comes back `Approved` with nobody approving anything (spike
    // 1.4, and the portal has approval disabled). Keying off it would disable undo entirely.
    const db = new FakeDb()
    seed(db)
    const { client, fetchImpl } = zoho()

    await undoEntry(db.client, client, { ...base, now: new Date('2026-07-25T19:00:00Z') })

    // One call: the delete. No read of the log to inspect its approval state.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![1]?.method)).toBe('DELETE')
  })
})
