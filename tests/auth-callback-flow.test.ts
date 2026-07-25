import { beforeEach, describe, expect, it, vi } from 'vitest'
import { completeCallback, type CallbackPorts } from '@/lib/auth/callback-flow'
import { encrypt } from '@/lib/auth/crypto'
import { AUTH_MESSAGES } from '@/lib/auth/messages'
import {
  OAUTH_STATE_MAX_AGE_SECONDS,
  decodeHandshake,
  encodeHandshake,
  handshakeMatches,
  safeReturnTo,
  type OAuthHandshake,
} from '@/lib/auth/oauth-state'
import { ZohoOAuthError, type ZohoTokens } from '@/lib/auth/zoho-oauth'

const KEY = Buffer.alloc(32, 3).toString('base64')
const NOW = new Date('2026-07-25T12:00:00Z')

function handshake(overrides: Partial<OAuthHandshake> = {}): OAuthHandshake {
  return {
    state: 'the-state',
    verifier: 'the-verifier',
    returnTo: '/',
    issuedAt: NOW.getTime() - 5_000,
    ...overrides,
  }
}

const TOKENS: ZohoTokens = {
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: new Date(NOW.getTime() + 3_540_000),
}

function ports(overrides: Partial<CallbackPorts> = {}): CallbackPorts {
  return {
    exchangeCode: vi.fn(async () => TOKENS),
    fetchIdentity: vi.fn(async () => ({
      status: 'ok' as const,
      identity: { zuid: '917530087', portalId: '911636649', role: 'jointadmin' },
    })),
    fetchProfile: vi.fn(async () => ({
      email: 'Nuno@Stelic.com',
      displayName: 'Nuno Barreto',
    })),
    upsertUser: vi.fn(async () => ({ id: 'user_1' })),
    saveTokens: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({
      id: 'sess_1',
      expiresAt: new Date('2026-08-24T12:00:00Z'),
    })),
    log: vi.fn(),
    ...overrides,
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    handshake: handshake(),
    state: 'the-state',
    code: 'the-code',
    requestId: 'req-1',
    now: NOW,
    ...overrides,
  } as Parameters<typeof completeCallback>[0]
}

describe('handshake cookie', () => {
  it('round-trips through encryption', () => {
    const value = encodeHandshake(handshake(), KEY)
    expect(decodeHandshake(value, KEY)).toEqual(handshake())
  })

  it('never exposes the verifier in the cookie value', () => {
    expect(encodeHandshake(handshake(), KEY)).not.toContain('the-verifier')
  })

  it('treats a forged or foreign cookie as no handshake at all', () => {
    const otherKey = Buffer.alloc(32, 9).toString('base64')
    expect(decodeHandshake(encodeHandshake(handshake(), KEY), otherKey)).toBeNull()
    expect(decodeHandshake('garbage', KEY)).toBeNull()
    expect(decodeHandshake(undefined, KEY)).toBeNull()
  })

  it('rejects a decryptable payload that is not a handshake', () => {
    expect(decodeHandshake(encrypt('{"state":"a"}', KEY), KEY)).toBeNull()
    expect(decodeHandshake(encrypt('not json', KEY), KEY)).toBeNull()
  })

  it('expires, so an abandoned attempt cannot be resumed later', () => {
    const fresh = handshake()
    expect(handshakeMatches(fresh, 'the-state', NOW)).toBe(true)

    const stale = handshake({
      issuedAt: NOW.getTime() - (OAUTH_STATE_MAX_AGE_SECONDS + 1) * 1000,
    })
    expect(handshakeMatches(stale, 'the-state', NOW)).toBe(false)
  })

  it('rejects a cookie stamped in the future', () => {
    expect(
      handshakeMatches(handshake({ issuedAt: NOW.getTime() + 60_000 }), 's', NOW),
    ).toBe(false)
  })
})

describe('safeReturnTo', () => {
  it('keeps a same-origin path', () => {
    expect(safeReturnTo('/week')).toBe('/week')
    expect(safeReturnTo('/week?day=mon')).toBe('/week?day=mon')
  })

  it('refuses anything that could leave the origin', () => {
    for (const hostile of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      '',
      null,
      undefined,
    ]) {
      expect(safeReturnTo(hostile)).toBe('/')
    }
  })
})

describe('completeCallback', () => {
  let p: CallbackPorts

  beforeEach(() => {
    p = ports()
  })

  it('issues a session for a portal member', async () => {
    const outcome = await completeCallback(input(), p)
    expect(outcome).toMatchObject({ status: 'ok', sessionId: 'sess_1', userId: 'user_1' })
    expect(p.saveTokens).toHaveBeenCalledWith('user_1', TOKENS)
  })

  it('stores the zuid as the Projects user id, which is what owner takes', async () => {
    await completeCallback(input(), p)
    expect(p.upsertUser).toHaveBeenCalledWith({
      zohoUserId: '917530087',
      email: 'Nuno@Stelic.com',
      displayName: 'Nuno Barreto',
      zohoProjectsUserId: '917530087',
    })
  })

  it('lands the user back where they were trying to go', async () => {
    const outcome = await completeCallback(
      input({ handshake: handshake({ returnTo: '/week' }) }),
      p,
    )
    expect(outcome).toMatchObject({ status: 'ok', returnTo: '/week' })
  })

  it('never trusts returnTo to leave the origin', async () => {
    const outcome = await completeCallback(
      input({ handshake: handshake({ returnTo: 'https://evil.example' }) }),
      p,
    )
    expect(outcome).toMatchObject({ status: 'ok', returnTo: '/' })
  })

  // AUTH-1: State mismatch is rejected
  it('rejects a state mismatch without attempting an exchange', async () => {
    const outcome = await completeCallback(input({ state: 'not-the-state' }), p)
    expect(outcome).toEqual({
      status: 'error',
      reason: 'stale_link',
      message: AUTH_MESSAGES.stale_link,
    })
    expect(p.exchangeCode).not.toHaveBeenCalled()
    expect(p.createSession).not.toHaveBeenCalled()
  })

  it('rejects a callback with no handshake cookie at all', async () => {
    const outcome = await completeCallback(input({ handshake: null }), p)
    expect(outcome).toMatchObject({ status: 'error', reason: 'stale_link' })
    expect(p.exchangeCode).not.toHaveBeenCalled()
  })

  // AUTH-1: Replayed authorization code
  it('issues no second session for a replayed code, and logs it with a request id', async () => {
    const exchangeCode = vi.fn(async () => {
      throw new ZohoOAuthError('invalid_code', 'already used')
    })
    const replay = ports({ exchangeCode })
    const outcome = await completeCallback(input(), replay)

    expect(outcome).toMatchObject({ status: 'error', reason: 'stale_link' })
    expect(replay.createSession).not.toHaveBeenCalled()
    expect(replay.log).toHaveBeenCalledWith('auth.exchange_failed', {
      requestId: 'req-1',
      code: 'invalid_code',
    })
  })

  it('treats a refusal at the Zoho consent screen as a retryable dead end', async () => {
    const outcome = await completeCallback(input({ errorFromZoho: 'access_denied' }), p)
    expect(outcome).toMatchObject({ status: 'error', reason: 'stale_link' })
    expect(p.exchangeCode).not.toHaveBeenCalled()
  })

  // AUTH-3: Valid Zoho account without portal membership
  it('refuses a valid Zoho account that is not on the portal, and logs the email', async () => {
    const outsider = ports({
      fetchIdentity: vi.fn(async () => ({ status: 'not_a_member' as const })),
      fetchProfile: vi.fn(async () => ({ email: 'someone@elsewhere.com' })),
    })
    const outcome = await completeCallback(input(), outsider)

    expect(outcome).toEqual({
      status: 'error',
      reason: 'not_a_member',
      message: AUTH_MESSAGES.not_a_member,
    })
    expect(outsider.createSession).not.toHaveBeenCalled()
    expect(outsider.saveTokens).not.toHaveBeenCalled()
    expect(outsider.log).toHaveBeenCalledWith('auth.not_a_portal_member', {
      requestId: 'req-1',
      email: 'someone@elsewhere.com',
    })
  })

  // AUTH-3: Portal user lookup is unavailable
  it('shows a neutral sentence, not a scope error, when identity cannot be read', async () => {
    const broken = ports({
      fetchIdentity: vi.fn(async () => ({ status: 'unreadable' as const })),
    })
    const outcome = await completeCallback(input(), broken)

    expect(outcome).toEqual({
      status: 'error',
      reason: 'unavailable',
      message: AUTH_MESSAGES.unavailable,
    })
    expect(outcome.status === 'error' && outcome.message).not.toMatch(
      /scope|token|401|403/i,
    )
    expect(broken.createSession).not.toHaveBeenCalled()
  })

  it('treats a thrown identity lookup the same as an unreadable one', async () => {
    const broken = ports({
      fetchIdentity: vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    })
    expect(await completeCallback(input(), broken)).toMatchObject({
      reason: 'unavailable',
    })
  })

  it('refuses to sign in a user whose email it cannot read', async () => {
    const anonymous = ports({ fetchProfile: vi.fn(async () => null) })
    const outcome = await completeCallback(input(), anonymous)
    expect(outcome).toMatchObject({ status: 'error', reason: 'unavailable' })
    expect(anonymous.upsertUser).not.toHaveBeenCalled()
  })

  it('refuses a grant with no refresh token rather than issuing a session that will break', async () => {
    const noRefresh = ports({
      exchangeCode: vi.fn(async () => ({ ...TOKENS, refreshToken: undefined })),
    })
    const outcome = await completeCallback(input(), noRefresh)
    expect(outcome).toMatchObject({ status: 'error', reason: 'unavailable' })
    expect(noRefresh.createSession).not.toHaveBeenCalled()
  })

  it('passes the verifier from the cookie, not from the query string', async () => {
    await completeCallback(input(), p)
    expect(p.exchangeCode).toHaveBeenCalledWith({
      code: 'the-code',
      codeVerifier: 'the-verifier',
    })
  })
})
