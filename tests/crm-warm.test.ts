import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { warmCrmUserId } from '@/lib/auth/crm-warm'
import { FakeDb } from './support/fake-db'

/** Minimal Zoho CRM client backed by a controlled fetch implementation. */
function crmClient(responder: (url: string) => Response): ZohoClient {
  return new ZohoClient({
    baseUrl: 'https://www.zohoapis.com/crm/v8/',
    tokens: {
      mode: 'service',
      getAccessToken: async () => 'at',
      refreshAccessToken: async () => 'at',
    },
    fetchImpl: vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => responder(String(input))),
    maxRateLimitRetries: 0,
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Trimmed from the live CRM users response, captured 2026-07-25. */
const USERS = {
  users: [
    {
      id: '7217638000000587001',
      zuid: '903491881',
      email: 'aviana@stelic.com',
      full_name: 'Alex Viana',
    },
    {
      id: '7217638000002090001',
      zuid: '917530087',
      email: 'nbarreto@stelic.com',
      full_name: 'Nuno Barreto',
    },
  ],
}

describe('warmCrmUserId', () => {
  it('resolves and stores the CRM id when none is cached', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const crm = crmClient(() => json(USERS))

    await warmCrmUserId(db.client, crm, user)

    expect(db.users[0]!.crmUserId).toBe('7217638000002090001')
  })

  it('skips the CRM call when the id is already cached', async () => {
    const db = new FakeDb()
    const user = db.seedUser({
      zohoUserId: '917530087',
      crmUserId: '7217638000002090001',
    })
    const fetch = vi.fn<typeof fetch>()
    const crm = new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl: fetch,
      maxRateLimitRetries: 0,
    })

    await warmCrmUserId(db.client, crm, user)

    // Short-circuits: the CRM is never called when the id is already known.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tolerates a CRM failure without throwing — warming is best-effort', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const crm = crmClient(() => new Response('{}', { status: 500 }))

    // Must not throw; the user can still use the chat.
    await expect(warmCrmUserId(db.client, crm, user)).resolves.toBeUndefined()
  })

  it('tolerates a network failure without throwing', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const crm = new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')),
      maxRateLimitRetries: 0,
    })

    await expect(warmCrmUserId(db.client, crm, user)).resolves.toBeUndefined()
    // Row is left unchanged — a failed warming is a gap in the cache, not corruption.
    expect(db.users[0]!.crmUserId).toBeNull()
  })

  it('leaves the row unchanged when the user has no CRM record', async () => {
    // Not an error: someone can have a Zoho Projects account and no CRM record. The
    // billing-role stamper handles null gracefully.
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: 'nobody', crmUserId: null })
    const crm = crmClient(() => json(USERS))

    await warmCrmUserId(db.client, crm, user)

    expect(db.users[0]!.crmUserId).toBeNull()
  })
})
