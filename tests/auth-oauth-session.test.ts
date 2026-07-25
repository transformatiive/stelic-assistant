import { describe, expect, it, vi } from 'vitest'
import {
  REQUIRED_SCOPES,
  ZohoOAuthError,
  buildAuthorizeUrl,
  exchangeCode,
  readIdentity,
  readProfile,
  refreshAccessToken,
} from '@/lib/auth/zoho-oauth'
import {
  checkSession,
  clearedCookieOptions,
  createSessionId,
  expiryFrom,
  hashIp,
  needsRefresh,
  sessionCookieOptions,
} from '@/lib/auth/session'

const CONFIG = {
  clientId: '1000.ABCDEF',
  clientSecret: 'shhh',
  redirectUri: 'https://stelic-assistant-production.up.railway.app/api/auth/callback',
  accountsDomain: 'https://accounts.zoho.com',
}

const NOW = new Date('2026-07-25T10:00:00Z')

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

describe('buildAuthorizeUrl', () => {
  const url = new URL(
    buildAuthorizeUrl(CONFIG, { state: 'st4te', codeChallenge: 'ch4llenge' }),
  )

  it('points at the configured accounts DC', () => {
    expect(url.origin).toBe('https://accounts.zoho.com')
    expect(url.pathname).toBe('/oauth/v2/auth')
  })

  it('carries state and S256 PKCE', () => {
    expect(url.searchParams.get('state')).toBe('st4te')
    expect(url.searchParams.get('code_challenge')).toBe('ch4llenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('requests offline access, without which there is no refresh token', () => {
    expect(url.searchParams.get('access_type')).toBe('offline')
  })

  it('asks only for the scopes it needs, and not the users scope', () => {
    const scope = url.searchParams.get('scope')!
    expect(scope.split(',')).toEqual([...REQUIRED_SCOPES])
    expect(scope).not.toContain('users')
  })

  it('never puts the client secret in a browser-visible URL', () => {
    expect(url.toString()).not.toContain(CONFIG.clientSecret)
  })
})

describe('exchangeCode', () => {
  it('posts the verifier and returns typed tokens', async () => {
    const fetchImpl = jsonFetch({
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
      api_domain: 'https://www.zohoapis.com',
      scope: 'ZohoProjects.timesheets.ALL',
    })

    const tokens = await exchangeCode(
      CONFIG,
      { code: 'the-code', codeVerifier: 'the-verifier' },
      { fetchImpl, now: NOW },
    )

    expect(tokens.accessToken).toBe('at')
    expect(tokens.refreshToken).toBe('rt')
    // Expires a minute early so a token cannot lapse mid-flight.
    expect(tokens.expiresAt.toISOString()).toBe('2026-07-25T10:59:00.000Z')

    const body = String(fetchImpl.mock.calls[0]![1]!.body)
    expect(body).toContain('grant_type=authorization_code')
    expect(body).toContain('code_verifier=the-verifier')
    expect(body).toContain('code=the-code')
  })

  it("treats Zoho's 200-with-error as a failure", async () => {
    const fetchImpl = jsonFetch({ error: 'invalid_code' })
    const error = await exchangeCode(
      CONFIG,
      { code: 'stale', codeVerifier: 'v' },
      { fetchImpl, now: NOW },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ZohoOAuthError)
    expect((error as ZohoOAuthError).code).toBe('invalid_code')
  })

  it('rejects an unreadable response instead of guessing', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>502</html>'))
    await expect(
      exchangeCode(CONFIG, { code: 'c', codeVerifier: 'v' }, { fetchImpl, now: NOW }),
    ).rejects.toBeInstanceOf(ZohoOAuthError)
  })

  it('rejects a payload missing the access token', async () => {
    const fetchImpl = jsonFetch({ refresh_token: 'rt', expires_in: 3600 })
    await expect(
      exchangeCode(CONFIG, { code: 'c', codeVerifier: 'v' }, { fetchImpl, now: NOW }),
    ).rejects.toBeInstanceOf(ZohoOAuthError)
  })
})

describe('refreshAccessToken', () => {
  it('sends the refresh grant and tolerates no new refresh token', async () => {
    const fetchImpl = jsonFetch({ access_token: 'at2', expires_in: 3600 })
    const tokens = await refreshAccessToken(CONFIG, 'rt', { fetchImpl, now: NOW })

    expect(tokens.accessToken).toBe('at2')
    expect(tokens.refreshToken).toBeUndefined()
    const body = String(fetchImpl.mock.calls[0]![1]!.body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=rt')
  })

  it('surfaces a revoked grant as a typed error', async () => {
    const fetchImpl = jsonFetch({ error: 'invalid_grant' })
    const error = await refreshAccessToken(CONFIG, 'revoked', {
      fetchImpl,
      now: NOW,
    }).catch((e: unknown) => e)
    expect((error as ZohoOAuthError).code).toBe('invalid_grant')
  })
})

describe('readIdentity', () => {
  // Shaped like the live response verified on 2026-07-25.
  const body = {
    login_id: '917530087',
    portals: [
      {
        id: 911636649,
        id_string: '911636649',
        name: 'stelic',
        role: 'jointadmin',
        login_zpuid: 2620762000000448000,
      },
    ],
  }

  it('reads the caller zuid, which is what the owner parameter needs', () => {
    const result = readIdentity(body, '911636649')
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.identity.zuid).toBe('917530087')
      expect(result.identity.portalId).toBe('911636649')
      expect(result.identity.role).toBe('jointadmin')
    }
  })

  it('rejects someone who is not on the Stelic portal', () => {
    expect(readIdentity(body, '999999999')).toEqual({ status: 'not_a_member' })
  })

  it('reports an unreadable response rather than inventing an identity', () => {
    expect(readIdentity({ portals: [] }, '911636649')).toEqual({ status: 'unreadable' })
    expect(readIdentity({ login_id: '' }, '911636649')).toEqual({ status: 'unreadable' })
    expect(readIdentity('nonsense', '911636649')).toEqual({ status: 'unreadable' })
  })

  it('matches on id_string, never the precision-corrupted numeric id', () => {
    const corrupted = {
      login_id: '917530087',
      portals: [{ id: 911636649, id_string: '911636649', name: 'stelic' }],
    }
    // A portal id long enough to lose precision must still match via id_string.
    const bigId = {
      login_id: '1',
      portals: [{ id: 2620762000000790022, id_string: '2620762000000790022' }],
    }
    expect(readIdentity(corrupted, '911636649').status).toBe('ok')
    expect(readIdentity(bigId, '2620762000000790022').status).toBe('ok')
  })
})

describe('readProfile', () => {
  it('reads the email and name the User row needs', () => {
    const profile = readProfile({
      ZUID: 917530087,
      Email: 'Nuno@Stelic.com',
      Display_Name: 'Nuno Barreto',
      First_Name: 'Nuno',
      Last_Name: 'Barreto',
    })
    expect(profile).toEqual({
      email: 'nuno@stelic.com',
      displayName: 'Nuno Barreto',
      zuid: '917530087',
    })
  })

  it('falls back to first and last name when there is no display name', () => {
    expect(
      readProfile({ Email: 'a@b.com', First_Name: 'Ana', Last_Name: 'Silva' }),
    ).toEqual({
      email: 'a@b.com',
      displayName: 'Ana Silva',
      zuid: undefined,
    })
  })

  it('returns null without an email, which is the join key', () => {
    expect(readProfile({ Display_Name: 'Nameless' })).toBeNull()
    expect(readProfile({ Email: '   ' })).toBeNull()
    expect(readProfile('nonsense')).toBeNull()
  })
})

describe('session policy', () => {
  it('issues opaque ids that never repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, createSessionId))
    expect(ids.size).toBe(200)
    expect(createSessionId()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('sets the cookie attributes AUTH-5 requires', () => {
    const cookie = sessionCookieOptions('stelic_session', 30)
    expect(cookie).toMatchObject({
      name: 'stelic_session',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    expect(cookie.maxAge).toBe(30 * 86_400)
  })

  it('clears with the same attributes and a zero max-age', () => {
    const cleared = clearedCookieOptions('stelic_session')
    expect(cleared.maxAge).toBe(0)
    expect(cleared.httpOnly).toBe(true)
    expect(cleared.secure).toBe(true)
  })

  it('accepts a live session and slides it', () => {
    const session = { expiresAt: new Date('2026-08-10T00:00:00Z') }
    const result = checkSession(session, NOW, 30)
    expect(result.status).toBe('valid')
    if (result.status === 'valid') {
      expect(result.slide).toBe(true)
      expect(result.newExpiresAt).toEqual(expiryFrom(NOW, 30))
    }
  })

  it('does not write to the database to move the deadline by seconds', () => {
    // Already expires almost exactly 30 days out: sliding would gain nothing.
    const session = { expiresAt: new Date(NOW.getTime() + 30 * 86_400_000 - 1000) }
    const result = checkSession(session, NOW, 30)
    expect(result.status).toBe('valid')
    if (result.status === 'valid') expect(result.slide).toBe(false)
  })

  it('lets a week-old session through, as AUTH-5 requires', () => {
    const lastUsed = new Date('2026-07-19T00:00:00Z')
    const session = { expiresAt: expiryFrom(lastUsed, 30) }
    expect(checkSession(session, NOW, 30).status).toBe('valid')
  })

  it('rejects an expired session', () => {
    expect(
      checkSession({ expiresAt: new Date('2026-07-24T00:00:00Z') }, NOW).status,
    ).toBe('expired')
  })

  it('rejects a revoked session even before its expiry', () => {
    const session = { expiresAt: new Date('2026-08-30T00:00:00Z'), revokedAt: NOW }
    expect(checkSession(session, NOW).status).toBe('revoked')
  })

  it('hashes IPs rather than storing them', () => {
    const hash = hashIp('203.0.113.9', 'salt')
    expect(hash).not.toContain('203')
    expect(hash).toBe(hashIp('203.0.113.9', 'salt'))
    expect(hash).not.toBe(hashIp('203.0.113.9', 'other-salt'))
  })

  it('refreshes an access token just before it lapses, not after', () => {
    expect(needsRefresh(new Date(NOW.getTime() + 600_000), NOW)).toBe(false)
    expect(needsRefresh(new Date(NOW.getTime() + 10_000), NOW)).toBe(true)
    expect(needsRefresh(new Date(NOW.getTime() - 1), NOW)).toBe(true)
    expect(needsRefresh(null, NOW)).toBe(true)
  })
})
