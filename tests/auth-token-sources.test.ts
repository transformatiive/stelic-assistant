import { describe, expect, it, vi } from 'vitest'
import { decrypt, encrypt } from '@/lib/auth/crypto'
import {
  ServiceCredentialUnavailable,
  UserReauthRequired,
  createServiceTokenSource,
  createUserTokenSource,
} from '@/lib/auth/token-sources'
import { loadSession } from '@/lib/auth/store'
import { FakeDb } from './support/fake-db'

const KEY = Buffer.alloc(32, 11).toString('base64')
const NOW = new Date('2026-07-25T12:00:00Z')

const OAUTH = {
  clientId: '1000.ABC',
  clientSecret: 'secret',
  redirectUri: 'https://stelic-assistant-production.up.railway.app/api/auth/callback',
  accountsDomain: 'https://accounts.zoho.com',
}

function tokenResponse(body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    }),
  )
}

describe('user token source', () => {
  function setup(
    tokenOverrides: Partial<{ access: string | null; expiresAt: Date | null }>,
  ) {
    const db = new FakeDb()
    const user = db.seedUser()
    db.seedToken({
      userId: user.id,
      refreshTokenEncrypted: encrypt('rt-stored', KEY),
      accessTokenEncrypted:
        tokenOverrides.access === null
          ? null
          : encrypt(tokenOverrides.access ?? 'at', KEY),
      accessTokenExpiresAt: tokenOverrides.expiresAt ?? null,
    })
    return { db, user }
  }

  it('uses the cached access token while it is still good', async () => {
    const { db, user } = setup({
      access: 'at-cached',
      expiresAt: new Date(NOW.getTime() + 600_000),
    })
    const fetchImpl = tokenResponse({
      access_token: 'should-not-be-used',
      expires_in: 3600,
    })

    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl,
    })

    expect(await source.getAccessToken()).toBe('at-cached')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // AUTH-6: Expired access token
  it('refreshes transparently when the cached token has lapsed', async () => {
    const { db, user } = setup({
      access: 'at-old',
      expiresAt: new Date(NOW.getTime() - 600_000),
    })
    const fetchImpl = tokenResponse({ access_token: 'at-fresh', expires_in: 3600 })

    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl,
    })

    expect(await source.getAccessToken()).toBe('at-fresh')
    // And the new one is persisted, so the next request does not refresh again.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(await source.getAccessToken()).toBe('at-fresh')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('declares itself a user credential, so a write cannot run on the service one', async () => {
    const { db, user } = setup({ access: null, expiresAt: null })
    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl: tokenResponse({ access_token: 'at', expires_in: 3600 }),
    })
    expect(source.mode).toBe('user')
  })

  // AUTH-6: Consent revoked in Zoho
  it('revokes every session and clears the grant when the refresh is rejected', async () => {
    const { db, user } = setup({ access: null, expiresAt: null })
    const a = db.seedSession({ userId: user.id })
    const b = db.seedSession({ userId: user.id })

    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl: tokenResponse({ error: 'invalid_grant' }),
    })

    await expect(source.getAccessToken()).rejects.toBeInstanceOf(UserReauthRequired)

    expect((await loadSession(db.client, a.id, { now: NOW })).status).toBe('invalid')
    expect((await loadSession(db.client, b.id, { now: NOW })).status).toBe('invalid')
    expect(db.tokens).toHaveLength(0)
  })

  it('demands re-authentication when there is no stored grant at all', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
    })
    await expect(source.getAccessToken()).rejects.toBeInstanceOf(UserReauthRequired)
  })

  it('recovers from an unreadable cached access token by refreshing', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    db.seedToken({
      userId: user.id,
      refreshTokenEncrypted: encrypt('rt-stored', KEY),
      // Encrypted under a key we no longer hold.
      accessTokenEncrypted: encrypt('at', Buffer.alloc(32, 99).toString('base64')),
      accessTokenExpiresAt: new Date(NOW.getTime() + 600_000),
    })

    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl: tokenResponse({ access_token: 'at-fresh', expires_in: 3600 }),
    })

    expect(await source.getAccessToken()).toBe('at-fresh')
  })

  it('forces re-authentication when the refresh token itself cannot be decrypted', async () => {
    const db = new FakeDb()
    const user = db.seedUser()
    db.seedSession({ userId: user.id })
    db.seedToken({
      userId: user.id,
      refreshTokenEncrypted: encrypt('rt', Buffer.alloc(32, 99).toString('base64')),
    })

    const source = createUserTokenSource({
      db: db.client,
      userId: user.id,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
    })

    await expect(source.getAccessToken()).rejects.toBeInstanceOf(UserReauthRequired)
    expect(db.tokens).toHaveLength(0)
  })
})

describe('service token source', () => {
  it('caches the access token in Postgres so replicas do not each refresh', async () => {
    const db = new FakeDb()
    const fetchImpl = tokenResponse({ access_token: 'svc-at', expires_in: 3600 })

    const first = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'svc-rt',
      now: () => NOW,
      fetchImpl,
    })
    expect(await first.getAccessToken()).toBe('svc-at')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // A second replica, its own instance, shares the row rather than refreshing again.
    const second = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'svc-rt',
      now: () => NOW,
      fetchImpl,
    })
    expect(await second.getAccessToken()).toBe('svc-at')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('stores the cached token encrypted', async () => {
    const db = new FakeDb()
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'svc-rt',
      now: () => NOW,
      fetchImpl: tokenResponse({ access_token: 'svc-at', expires_in: 3600 }),
    })
    await source.getAccessToken()
    expect(db.serviceTokens[0]!.accessTokenEncrypted).not.toContain('svc-at')
  })

  it('refreshes once the cached token is close to lapsing', async () => {
    const db = new FakeDb()
    db.serviceTokens.push({
      id: 'service',
      accessTokenEncrypted: encrypt('svc-old', KEY),
      expiresAt: new Date(NOW.getTime() + 10_000),
    })
    const fetchImpl = tokenResponse({ access_token: 'svc-new', expires_in: 3600 })

    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'svc-rt',
      now: () => NOW,
      fetchImpl,
    })

    expect(await source.getAccessToken()).toBe('svc-new')
  })

  it('surfaces a dead service credential as an operational fault, not a user one', async () => {
    const db = new FakeDb()
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'revoked',
      now: () => NOW,
      fetchImpl: tokenResponse({ error: 'invalid_grant' }),
    })
    await expect(source.getAccessToken()).rejects.toBeInstanceOf(
      ServiceCredentialUnavailable,
    )
  })

  it('declares itself a service credential', () => {
    const db = new FakeDb()
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'svc-rt',
      now: () => NOW,
    })
    expect(source.mode).toBe('service')
  })
})

// The failure this exists to prevent: a refresh token from a different OAuth client answers
// `invalid_code`, no matter how carefully it was copied into an environment variable.
describe('service credential precedence', () => {
  it('prefers a credential connected through the app over the environment one', async () => {
    const db = new FakeDb()
    db.serviceTokens.push({
      id: 'service',
      accessTokenEncrypted: null,
      expiresAt: null,
      refreshTokenEncrypted: encrypt('rt-connected', KEY),
    })
    const fetchImpl = tokenResponse({ access_token: 'at', expires_in: 3600 })

    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'rt-from-env',
      now: () => NOW,
      fetchImpl,
    })
    await source.getAccessToken()

    const body = String(fetchImpl.mock.calls[0]![1]!.body)
    expect(body).toContain('refresh_token=rt-connected')
    expect(body).not.toContain('rt-from-env')
  })

  it('falls back to the environment when nothing has been connected', async () => {
    const db = new FakeDb()
    const fetchImpl = tokenResponse({ access_token: 'at', expires_in: 3600 })
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'rt-from-env',
      now: () => NOW,
      fetchImpl,
    })
    await source.getAccessToken()
    expect(String(fetchImpl.mock.calls[0]![1]!.body)).toContain(
      'refresh_token=rt-from-env',
    )
  })

  it('falls back to the environment when the stored token cannot be decrypted', async () => {
    // Key rotation should degrade, not break: the environment token may still work.
    const db = new FakeDb()
    db.serviceTokens.push({
      id: 'service',
      accessTokenEncrypted: null,
      expiresAt: null,
      refreshTokenEncrypted: encrypt('rt', Buffer.alloc(32, 99).toString('base64')),
    })
    const fetchImpl = tokenResponse({ access_token: 'at', expires_in: 3600 })
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      refreshToken: 'rt-from-env',
      now: () => NOW,
      fetchImpl,
    })
    await source.getAccessToken()
    expect(String(fetchImpl.mock.calls[0]![1]!.body)).toContain(
      'refresh_token=rt-from-env',
    )
  })

  it('says it is not connected when there is neither, rather than calling Zoho', async () => {
    const db = new FakeDb()
    const fetchImpl = vi.fn<typeof fetch>()
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl,
    })
    const error = await source.getAccessToken().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServiceCredentialUnavailable)
    expect((error as Error).message).toContain('not connected')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('keeps a rotated refresh token when Zoho issues a new one', async () => {
    const db = new FakeDb()
    db.serviceTokens.push({
      id: 'service',
      accessTokenEncrypted: null,
      expiresAt: null,
      refreshTokenEncrypted: encrypt('rt-old', KEY),
    })
    const source = createServiceTokenSource({
      db: db.client,
      encryptionKey: KEY,
      oauth: OAUTH,
      now: () => NOW,
      fetchImpl: tokenResponse({
        access_token: 'at',
        refresh_token: 'rt-rotated',
        expires_in: 3600,
      }),
    })
    await source.getAccessToken()
    expect(decrypt(db.serviceTokens[0]!.refreshTokenEncrypted!, KEY)).toBe('rt-rotated')
  })
})
