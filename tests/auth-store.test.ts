import { describe, expect, it } from 'vitest'
import { decrypt } from '@/lib/auth/crypto'
import {
  clearTokens,
  createSession,
  hasOtherActiveSession,
  loadSession,
  revokeAllSessions,
  revokeSession,
  saveTokens,
  upsertUser,
} from '@/lib/auth/store'
import { FakeDb } from './support/fake-db'

const KEY = Buffer.alloc(32, 5).toString('base64')
const NOW = new Date('2026-07-25T12:00:00Z')

describe('upsertUser', () => {
  it('creates a user on first sign-in, lowercasing the email', async () => {
    const db = new FakeDb()
    const { id } = await upsertUser(
      db.client,
      {
        zohoUserId: '917530087',
        email: '  Nuno@Stelic.COM ',
        displayName: 'Nuno Barreto',
        zohoProjectsUserId: '917530087',
      },
      NOW,
    )

    const row = db.users.find((u) => u.id === id)!
    expect(row.email).toBe('nuno@stelic.com')
    expect(row.zohoProjectsUserId).toBe('917530087')
    expect(row.lastSeenAt).toEqual(NOW)
  })

  it('updates the existing row when the email changed in Zoho, rather than forking history', async () => {
    const db = new FakeDb()
    const seeded = db.seedUser({ email: 'old@stelic.com' })

    const { id } = await upsertUser(
      db.client,
      {
        zohoUserId: seeded.zohoUserId!,
        email: 'new@stelic.com',
        zohoProjectsUserId: '917530087',
      },
      NOW,
    )

    expect(id).toBe(seeded.id)
    expect(db.users).toHaveLength(1)
    expect(db.users[0]!.email).toBe('new@stelic.com')
  })

  it('does not wipe a stored display name when Zoho returns none', async () => {
    const db = new FakeDb()
    const seeded = db.seedUser({ displayName: 'Nuno Barreto' })
    await upsertUser(
      db.client,
      {
        zohoUserId: seeded.zohoUserId!,
        email: seeded.email,
        zohoProjectsUserId: '917530087',
      },
      NOW,
    )
    expect(db.users[0]!.displayName).toBe('Nuno Barreto')
  })

  it('reactivates a previously deactivated user who signs in again', async () => {
    const db = new FakeDb()
    const seeded = db.seedUser({ isActive: false })
    await upsertUser(
      db.client,
      {
        zohoUserId: seeded.zohoUserId!,
        email: seeded.email,
        zohoProjectsUserId: '917530087',
      },
      NOW,
    )
    expect(db.users[0]!.isActive).toBe(true)
  })
})

// AUTH-2: Tokens at rest
describe('saveTokens', () => {
  it('writes ciphertext, never the token', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    await saveTokens(
      db.client,
      user.id,
      { accessToken: 'at-plain', refreshToken: 'rt-plain', expiresAt: NOW },
      KEY,
    )

    const row = db.tokens[0]!
    expect(row.refreshTokenEncrypted).not.toContain('rt-plain')
    expect(row.accessTokenEncrypted).not.toContain('at-plain')
    expect(decrypt(row.refreshTokenEncrypted, KEY)).toBe('rt-plain')
    expect(decrypt(row.accessTokenEncrypted!, KEY)).toBe('at-plain')
  })

  it('keeps the existing refresh token when a refresh returns none', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    await saveTokens(
      db.client,
      user.id,
      { accessToken: 'at1', refreshToken: 'rt-original', expiresAt: NOW },
      KEY,
    )
    await saveTokens(db.client, user.id, { accessToken: 'at2', expiresAt: NOW }, KEY)

    expect(decrypt(db.tokens[0]!.refreshTokenEncrypted, KEY)).toBe('rt-original')
    expect(decrypt(db.tokens[0]!.accessTokenEncrypted!, KEY)).toBe('at2')
  })
})

describe('loadSession', () => {
  it('returns the user and slides a session that has drifted', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    // Last used six days ago, signed in eight days ago — AUTH-5, "Return after a week".
    const session = db.seedSession({
      userId: user.id,
      expiresAt: new Date('2026-08-18T12:00:00Z'),
    })

    const result = await loadSession(db.client, session.id, { now: NOW })

    expect(result.status).toBe('valid')
    expect(result.status === 'valid' && result.user.email).toBe('nuno@stelic.com')
    expect(db.sessions[0]!.lastUsedAt).toEqual(NOW)
    expect(db.sessions[0]!.expiresAt).toEqual(new Date('2026-08-24T12:00:00Z'))
  })

  it('does not write when the deadline has barely moved', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const expiresAt = new Date(NOW.getTime() + 30 * 86_400_000 - 1000)
    const session = db.seedSession({ userId: user.id, expiresAt })

    await loadSession(db.client, session.id, { now: NOW })
    expect(db.sessions[0]!.expiresAt).toEqual(expiresAt)
  })

  // AUTH-5: Session past its expiry / AUTH-7: forged id
  it.each([
    ['an unknown id', 'sess_does_not_exist'],
    ['no cookie', undefined],
  ])('treats %s as unauthenticated', async (_label, id) => {
    const db = new FakeDb()
    expect(await loadSession(db.client, id, { now: NOW })).toEqual({ status: 'invalid' })
  })

  it('refuses an expired session', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const session = db.seedSession({
      userId: user.id,
      expiresAt: new Date('2026-07-24T12:00:00Z'),
    })
    expect(await loadSession(db.client, session.id, { now: NOW })).toEqual({
      status: 'invalid',
    })
  })

  it('refuses a revoked session even before its expiry', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const session = db.seedSession({ userId: user.id, revokedAt: NOW })
    expect(await loadSession(db.client, session.id, { now: NOW })).toEqual({
      status: 'invalid',
    })
  })

  it('refuses a session whose user has been deactivated', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ isActive: false })
    const session = db.seedSession({ userId: user.id })
    expect(await loadSession(db.client, session.id, { now: NOW })).toEqual({
      status: 'invalid',
    })
  })
})

// AUTH-5: Multiple devices
describe('sign-out is per device', () => {
  it('revokes only the session that signed out', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const phone = db.seedSession({ userId: user.id })
    const desktop = db.seedSession({ userId: user.id })

    await revokeSession(db.client, phone.id, NOW)

    expect((await loadSession(db.client, phone.id, { now: NOW })).status).toBe('invalid')
    expect((await loadSession(db.client, desktop.id, { now: NOW })).status).toBe('valid')
  })

  it('reports the other device as still active, so the grant is kept', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const phone = db.seedSession({ userId: user.id })
    db.seedSession({ userId: user.id })

    expect(await hasOtherActiveSession(db.client, user.id, phone.id, NOW)).toBe(true)
  })

  it('reports no other device once the last one signs out', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const only = db.seedSession({ userId: user.id })
    const expired = db.seedSession({
      userId: user.id,
      expiresAt: new Date('2026-01-01T00:00:00Z'),
    })
    await revokeSession(db.client, only.id, NOW)

    expect(await hasOtherActiveSession(db.client, user.id, only.id, NOW)).toBe(false)
    expect(expired.expiresAt < NOW).toBe(true)
  })
})

describe('revokeAllSessions and clearTokens', () => {
  it('shuts every device out and drops the grant', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const a = db.seedSession({ userId: user.id })
    const b = db.seedSession({ userId: user.id })
    db.seedToken({ userId: user.id, refreshTokenEncrypted: 'x' })

    await revokeAllSessions(db.client, user.id, NOW)
    await clearTokens(db.client, user.id)

    expect((await loadSession(db.client, a.id, { now: NOW })).status).toBe('invalid')
    expect((await loadSession(db.client, b.id, { now: NOW })).status).toBe('invalid')
    expect(db.tokens).toHaveLength(0)
  })
})

describe('createSession', () => {
  it('stores a hashed IP, never the address itself', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    await createSession(
      db.client,
      { userId: user.id, ip: '203.0.113.9', ipSalt: 'salt', userAgent: 'Safari' },
      NOW,
    )

    const row = db.sessions[0]!
    expect(row.ipHash).not.toContain('203')
    expect(row.ipHash).toBeTruthy()
    expect(row.expiresAt).toEqual(new Date('2026-08-24T12:00:00Z'))
  })

  it('issues an opaque id that is not the user id', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const { id } = await createSession(db.client, { userId: user.id, ipSalt: 's' }, NOW)
    expect(id).not.toContain(user.id)
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/)
  })
})
