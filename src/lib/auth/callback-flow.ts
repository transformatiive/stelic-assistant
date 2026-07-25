import type { IdentityResult, ZohoProfile, ZohoTokens } from './zoho-oauth'
import { ZohoOAuthError } from './zoho-oauth'
import { AUTH_MESSAGES, type AuthErrorReason } from './messages'
import { handshakeMatches, safeReturnTo, type OAuthHandshake } from './oauth-state'

/**
 * What happens between Zoho redirecting back and a session cookie existing (task 2.2, 2.4).
 *
 * Written against injected ports rather than Prisma and `fetch` so every branch the auth spec
 * names — state mismatch, replayed code, valid account without portal membership, identity
 * lookup unavailable — is testable without a database or a network.
 */

export type CallbackPorts = {
  exchangeCode: (params: { code: string; codeVerifier: string }) => Promise<ZohoTokens>
  fetchIdentity: (accessToken: string) => Promise<IdentityResult>
  /** Email and display name — `/restapi/portals/` does not carry them. */
  fetchProfile: (accessToken: string) => Promise<ZohoProfile | null>
  /** Creates or updates the `User` row and returns its id. */
  upsertUser: (input: {
    zohoUserId: string
    email: string
    displayName?: string
    zohoProjectsUserId: string
  }) => Promise<{ id: string }>
  saveTokens: (userId: string, tokens: ZohoTokens) => Promise<void>
  createSession: (userId: string) => Promise<{ id: string; expiresAt: Date }>
  log: (event: string, fields: Record<string, unknown>) => void
}

export type CallbackInput = {
  handshake: OAuthHandshake | null
  state: string | null
  code: string | null
  /** Zoho reports a user-side refusal in the query string, not by failing the redirect. */
  errorFromZoho?: string | null
  requestId: string
  now: Date
}

export type CallbackOutcome =
  | { status: 'ok'; sessionId: string; expiresAt: Date; userId: string; returnTo: string }
  | { status: 'error'; reason: AuthErrorReason; message: string }

function failure(reason: AuthErrorReason): CallbackOutcome {
  return { status: 'error', reason, message: AUTH_MESSAGES[reason] }
}

export async function completeCallback(
  input: CallbackInput,
  ports: CallbackPorts,
): Promise<CallbackOutcome> {
  const { requestId } = input

  // A refusal at Zoho's consent screen is not an error worth alarming anyone about; it lands
  // the user back on the login screen with a retry, same as a stale link.
  if (input.errorFromZoho) {
    ports.log('auth.callback_refused', { requestId, error: input.errorFromZoho })
    return failure('stale_link')
  }

  // Check state before anything else: a mismatch must not cost a code exchange.
  if (!handshakeMatches(input.handshake, input.state, input.now)) {
    ports.log('auth.state_mismatch', {
      requestId,
      hasHandshake: input.handshake !== null,
    })
    return failure('stale_link')
  }
  if (!input.code) {
    ports.log('auth.missing_code', { requestId })
    return failure('stale_link')
  }

  const handshake = input.handshake!

  let tokens: ZohoTokens
  try {
    tokens = await ports.exchangeCode({
      code: input.code,
      codeVerifier: handshake.verifier,
    })
  } catch (error) {
    const code = error instanceof ZohoOAuthError ? error.code : 'unknown'
    // A replayed code lands here: Zoho refuses the second exchange, so no second session
    // can be issued for it.
    ports.log('auth.exchange_failed', { requestId, code })
    return failure('stale_link')
  }

  // Without a refresh token the session would die in an hour, and a silent refresh (AUTH-6)
  // would be impossible. Treat it as a configuration fault rather than issuing a session
  // that is going to break in the middle of someone's day.
  if (!tokens.refreshToken) {
    ports.log('auth.no_refresh_token', { requestId })
    return failure('unavailable')
  }

  // Both run on the user's own fresh access token. The profile is fetched before the
  // membership verdict so that a rejection can be logged with the email, as AUTH-3 requires.
  let identity: IdentityResult
  let profile: ZohoProfile | null
  try {
    ;[identity, profile] = await Promise.all([
      ports.fetchIdentity(tokens.accessToken),
      ports.fetchProfile(tokens.accessToken),
    ])
  } catch (error) {
    ports.log('auth.identity_error', {
      requestId,
      error: error instanceof Error ? error.name : 'unknown',
    })
    return failure('unavailable')
  }

  if (identity.status === 'unreadable') {
    // We could not tell whether they belong. Never guess in the permissive direction.
    ports.log('auth.identity_unreadable', { requestId })
    return failure('unavailable')
  }
  if (identity.status === 'not_a_member') {
    ports.log('auth.not_a_portal_member', { requestId, email: profile?.email ?? null })
    return failure('not_a_member')
  }

  // No email means no join key to CRM, Projects and Books, and a `User` row we cannot
  // reconcile later. That is our configuration problem, not something to paper over.
  if (!profile) {
    ports.log('auth.profile_unreadable', { requestId, zuid: identity.identity.zuid })
    return failure('unavailable')
  }

  const user = await ports.upsertUser({
    zohoUserId: identity.identity.zuid,
    email: profile.email,
    displayName: profile.displayName,
    // Spike 1.4: the time-log `owner` parameter takes the zuid, not the zpuid.
    zohoProjectsUserId: identity.identity.zuid,
  })

  await ports.saveTokens(user.id, tokens)
  const session = await ports.createSession(user.id)

  ports.log('auth.signed_in', {
    requestId,
    userId: user.id,
    role: identity.identity.role,
  })

  return {
    status: 'ok',
    sessionId: session.id,
    expiresAt: session.expiresAt,
    userId: user.id,
    returnTo: safeReturnTo(handshake.returnTo),
  }
}
