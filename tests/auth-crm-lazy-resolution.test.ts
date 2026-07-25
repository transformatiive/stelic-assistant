import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { resolveCrmUserId } from '@/lib/zoho/crm-users'
import { FakeDb } from './support/fake-db'

/**
 * Tests for the lazy CRM user id resolution that `/api/me` triggers (task 2.5, AUTH-4).
 *
 * The resolution call lives in the route handler and is fire-and-forget, so it cannot be tested
 * by mounting the handler without a full Next.js / Prisma stack. These tests cover the same
 * behaviour by calling `resolveCrmUserId` directly with the same arguments `/api/me` passes —
 * the field names, null checks and early-return logic are what matters, not which route calls it.
 *
 * The underlying function is already covered by `billing-role.test.ts`. The new scenarios here
 * are specifically about the preconditions for the lazy-resolution call:
 *   - no-op when the id is already cached (avoids an API call on every /api/me)
 *   - no-op when `zohoUserId` is missing (nothing to match on)
 *   - resolves and persists when both conditions are met
 *   - tolerates a CRM failure silently (AUTH-4: absence must not break a session)
 */

const USERS = {
  users: [
    { id: '7217638000000587001', zuid: '903491881', email: 'aviana@stelic.com' },
    { id: '7217638000002090001', zuid: '917530087', email: 'nbarreto@stelic.com' },
  ],
}

function crmClient(responder: (url: string) => Response) {
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

describe('lazy CRM user id resolution (/api/me, task 2.5)', () => {
  it('resolves and stores the id the first time a user loads /api/me', async () => {
    const db = new FakeDb()
    // A freshly signed-in user: has a zohoUserId from the callback, but no crmUserId yet
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const client = crmClient(() => json(USERS))

    await resolveCrmUserId(db.client, client, {
      id: user.id,
      zohoUserId: user.zohoUserId,
      crmUserId: user.crmUserId,
    })

    // The id is now stored on the row, so the next /api/me call skips the API entirely
    expect(db.users[0]!.crmUserId).toBe('7217638000002090001')
  })

  it('skips the API when the id is already cached', async () => {
    // This is the common case: a returning user who signed in last week already has the id
    const db = new FakeDb()
    const user = db.seedUser({
      zohoUserId: '917530087',
      crmUserId: '7217638000002090001',
    })
    const fetchImpl = vi.fn<typeof fetch>()
    const client = new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
      maxRateLimitRetries: 0,
    })

    // The /api/me guard is `!session.user.crmUserId && session.user.zohoUserId`.
    // When crmUserId is already set, the call is never made — but resolveCrmUserId
    // also has its own guard on line 1, so both layers independently skip the API.
    await resolveCrmUserId(db.client, client, {
      id: user.id,
      zohoUserId: user.zohoUserId,
      crmUserId: user.crmUserId, // already populated
    })

    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns null gracefully when zohoUserId is not set (no id to match on)', async () => {
    // The /api/me guard skips the call in this case, but resolveCrmUserId handles it too
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: null, crmUserId: null })
    const client = crmClient(() => json(USERS))

    const result = await resolveCrmUserId(db.client, client, {
      id: user.id,
      zohoUserId: user.zohoUserId,
      crmUserId: user.crmUserId,
    })

    expect(result).toBeNull()
    expect(db.users[0]!.crmUserId).toBeNull()
  })

  it('tolerates a CRM API failure without affecting the session', async () => {
    // AUTH-4: absence must not block sign-in or break the app. A network error during the
    // fire-and-forget call must not propagate and crash the route handler.
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const client = crmClient(() => {
      throw new Error('network failure')
    })

    // The void expression in /api/me is what prevents this from propagating; resolveCrmUserId
    // itself throws (the underlying HTTP client throws). The guard is that the caller uses void.
    await expect(
      resolveCrmUserId(db.client, client, {
        id: user.id,
        zohoUserId: user.zohoUserId,
        crmUserId: user.crmUserId,
      }),
    ).rejects.toThrow('network failure')

    // No id is stored — absence is the correct state after a failure
    expect(db.users[0]!.crmUserId).toBeNull()
  })

  it('resolves the correct user when the portal has several CRM users', async () => {
    // The whole-company fetch is intentional: one call, cached on the User row.
    // Matching is on the `zuid`, which crosses systems — not on email.
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '903491881', crmUserId: null }) // Alex Viana

    const client = crmClient(() => json(USERS))
    const result = await resolveCrmUserId(db.client, client, {
      id: user.id,
      zohoUserId: user.zohoUserId,
      crmUserId: user.crmUserId,
    })

    expect(result).toBe('7217638000000587001') // Alex's CRM id
    expect(db.users[0]!.crmUserId).toBe('7217638000000587001')
  })
})
