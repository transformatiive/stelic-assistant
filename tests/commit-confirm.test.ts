import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { cancelDraft, confirmDraft } from '@/lib/commit/confirm'
import type { DraftEntry } from '@/lib/resolve/entry'
import { FakeDb } from './support/fake-db'

function readyEntry(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    id: 'e1',
    said: { project: 'Clayco', date: 'yesterday' },
    project: {
      status: 'resolved',
      projectId: '2620762000000790022',
      projectName: 'STE-100013 - Clayco: MS Data Center',
      accountName: 'Clayco Construction Company Inc',
      why: 'matched the client name (Clayco)',
    },
    task: {
      status: 'resolved',
      taskId: '2620762000000790055',
      taskName: 'Engineering',
      why: 'the only charge code on the project',
    },
    date: { status: 'resolved', date: '2026-07-24' },
    hours: { status: 'resolved', hours: 8 },
    description: { status: 'resolved', description: 'Structural review' },
    billable: true,
    ...overrides,
  }
}

const needsAnswer = (id: string): DraftEntry =>
  readyEntry({
    id,
    description: { status: 'unresolved', reason: 'missing' },
  })

const blocked = (id: string): DraftEntry =>
  readyEntry({
    id,
    date: { status: 'blocked', reason: 'future', date: '2026-07-30' },
  })

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

function setup(
  entries: DraftEntry[],
  overrides: Parameters<FakeDb['seedDraft']>[0] = { userId: 'user_1' },
) {
  const db = new FakeDb()
  db.seedMessage({ id: 'msg_1' })
  const draft = db.seedDraft({ entries, ...overrides })
  return { db, draft }
}

const at = new Date('2026-07-25T12:30:00Z')

describe('confirming a draft', () => {
  it('commits every ready entry and closes the draft', async () => {
    const { db, draft } = setup([
      readyEntry({ id: 'a' }),
      readyEntry({
        id: 'b',
        description: { status: 'resolved', description: 'Punch list' },
      }),
    ])
    let n = 0
    const { client } = zoho(() => created(String(++n)))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.created).toBe(2)
    expect(result.ok && result.draftStatus).toBe('confirmed')
    expect(db.drafts[0]!.status).toBe('confirmed')
  })

  it('links the audit trail to what the person actually typed', async () => {
    const { db, draft } = setup([readyEntry()])
    const { client } = zoho(() => created('1'))
    await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })
    expect(db.commitLogs[0]!.sourceMessageId).toBe('msg_1')
  })

  it('sends the person’s own zuid as the log owner', async () => {
    const { db, draft } = setup([readyEntry()])
    const { client, fetchImpl } = zoho(() => created('1'))
    await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      zohoUserId: '917530087',
      now: at,
    })
    const form = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body))
    expect(form.get('owner')).toBe('917530087')
  })
})

describe('a draft that is only partly answerable', () => {
  // CHAT-3: a project with no charge code must not stop the rest of the day being logged.
  it('logs the ready entries and leaves the draft open', async () => {
    const { db, draft } = setup([readyEntry({ id: 'a' }), needsAnswer('b')])
    const { client, fetchImpl } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(result.ok && result.created).toBe(1)
    expect(result.ok && result.draftStatus).toBe('pending')
    expect(result.ok && result.notCommitted).toEqual([
      { entryId: 'b', state: 'needs_answer', reason: null },
    ])
    expect(db.drafts[0]!.status).toBe('pending')
  })

  it('explains a blocked entry rather than silently dropping it', async () => {
    const { db, draft } = setup([readyEntry({ id: 'a' }), blocked('b')])
    const { client } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(result.ok && result.notCommitted[0]).toMatchObject({
      entryId: 'b',
      state: 'blocked',
    })
    expect(result.ok && result.notCommitted[0]?.reason).toContain('future')
  })

  it('refuses when nothing at all can be logged', async () => {
    const { db, draft } = setup([needsAnswer('a'), blocked('b')])
    const { client, fetchImpl } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(result).toEqual({ ok: false, refusal: 'nothing_ready' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('confirming twice', () => {
  it('creates no second Zoho log and returns the original result', async () => {
    const { db, draft } = setup([readyEntry()])
    const { client, fetchImpl } = zoho(() => created('99'))

    await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })
    const second = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(second.ok && second.duplicates).toBe(1)
    expect(second.ok && second.outcomes[0]).toMatchObject({
      status: 'duplicate',
      zohoLogId: '99',
    })
  })

  it('lets a failed entry be retried on the same draft', async () => {
    const { db, draft } = setup([readyEntry()])
    let attempt = 0
    const { client } = zoho(() =>
      ++attempt === 1 ? new Response('boom', { status: 500 }) : created('99'),
    )

    const first = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })
    // Still open, which is what makes "Retry failed" possible at all.
    expect(first.ok && first.draftStatus).toBe('pending')
    expect(db.drafts[0]!.status).toBe('pending')

    const second = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })
    expect(second.ok && second.created).toBe(1)
    expect(db.drafts[0]!.status).toBe('confirmed')
  })
})

describe('drafts that cannot be confirmed', () => {
  it('treats another person’s draft as one that does not exist', async () => {
    const { db, draft } = setup([readyEntry()])
    const { client, fetchImpl } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'someone_else',
      draftId: draft.id,
      now: at,
    })

    expect(result).toEqual({ ok: false, refusal: 'not_found' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('expires a stale draft instead of logging time the user has forgotten', async () => {
    const { db, draft } = setup([readyEntry()], {
      userId: 'user_1',
      expiresAt: new Date('2026-07-25T12:00:00Z'),
    })
    const { client, fetchImpl } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(result).toEqual({ ok: false, refusal: 'expired' })
    expect(db.drafts[0]!.status).toBe('expired')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a cancelled draft', async () => {
    const { db, draft } = setup([readyEntry()], { userId: 'user_1', status: 'cancelled' })
    const { client } = zoho(() => created('1'))
    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })
    expect(result).toEqual({ ok: false, refusal: 'cancelled' })
  })

  it('refuses rather than logging with no message to attribute it to', async () => {
    const db = new FakeDb()
    const draft = db.seedDraft({ userId: 'user_1', entries: [readyEntry()] })
    const { client, fetchImpl } = zoho(() => created('1'))

    const result = await confirmDraft(db.client, client, {
      userId: 'user_1',
      draftId: draft.id,
      now: at,
    })

    expect(result).toEqual({ ok: false, refusal: 'no_source_message' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('cancelling', () => {
  it('cancels a pending draft', async () => {
    const { db, draft } = setup([readyEntry()])
    await expect(
      cancelDraft(db.client, { userId: 'user_1', draftId: draft.id }),
    ).resolves.toEqual({ ok: true, alreadyCancelled: false })
    expect(db.drafts[0]!.status).toBe('cancelled')
  })

  it('is idempotent, because the failure mode of a cancel button is a double tap', async () => {
    const { db, draft } = setup([readyEntry()])
    await cancelDraft(db.client, { userId: 'user_1', draftId: draft.id })
    await expect(
      cancelDraft(db.client, { userId: 'user_1', draftId: draft.id }),
    ).resolves.toEqual({ ok: true, alreadyCancelled: true })
  })

  it('refuses a confirmed draft, because cancelling does not undo anything', async () => {
    const { db, draft } = setup([readyEntry()], { userId: 'user_1', status: 'confirmed' })
    await expect(
      cancelDraft(db.client, { userId: 'user_1', draftId: draft.id }),
    ).resolves.toEqual({ ok: false, refusal: 'already_committed' })
    expect(db.drafts[0]!.status).toBe('confirmed')
  })

  it('treats another person’s draft as one that does not exist', async () => {
    const { db, draft } = setup([readyEntry()])
    await expect(
      cancelDraft(db.client, { userId: 'nope', draftId: draft.id }),
    ).resolves.toEqual({ ok: false, refusal: 'not_found' })
  })
})
