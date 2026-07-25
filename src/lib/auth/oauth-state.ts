import { DecryptionError, decrypt, encrypt, safeEqual } from './crypto'

/**
 * The in-flight OAuth handshake (task 2.1, 2.2).
 *
 * `state` and the PKCE verifier have to survive the round trip to Zoho and come back
 * associated with *this* browser. They live in a short-lived encrypted cookie rather than a
 * database row: there is nothing to clean up afterwards, a stolen cookie is useless without
 * `TOKEN_ENCRYPTION_KEY`, and an attacker who plants their own cookie only completes a
 * sign-in as themselves.
 */

export const OAUTH_STATE_COOKIE = 'stelic_oauth'

/** Long enough for a Zoho login, short enough that an abandoned attempt does not linger. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 600

export type OAuthHandshake = {
  state: string
  verifier: string
  /** Where to land after sign-in. Same-origin path only — never an absolute URL. */
  returnTo: string
  /** Epoch milliseconds. Checked on the way back, so a stale cookie cannot be replayed. */
  issuedAt: number
}

export function encodeHandshake(handshake: OAuthHandshake, key: string): string {
  return encrypt(JSON.stringify(handshake), key)
}

export function decodeHandshake(
  value: string | undefined,
  key: string,
): OAuthHandshake | null {
  if (!value) return null
  let json: string
  try {
    json = decrypt(value, key)
  } catch (error) {
    // A wrong key, a forged cookie and a tampered one are all the same answer: no handshake.
    if (error instanceof DecryptionError) return null
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Record<string, unknown>
  if (
    typeof candidate.state !== 'string' ||
    typeof candidate.verifier !== 'string' ||
    typeof candidate.returnTo !== 'string' ||
    typeof candidate.issuedAt !== 'number' ||
    candidate.state === '' ||
    candidate.verifier === ''
  ) {
    return null
  }

  return {
    state: candidate.state,
    verifier: candidate.verifier,
    returnTo: candidate.returnTo,
    issuedAt: candidate.issuedAt,
  }
}

/** Constant-time, and expiry-checked: a handshake older than its window is not a handshake. */
export function handshakeMatches(
  handshake: OAuthHandshake | null,
  stateFromZoho: string | null | undefined,
  now: Date,
): boolean {
  if (!handshake || !stateFromZoho) return false
  const age = now.getTime() - handshake.issuedAt
  if (age < 0 || age > OAUTH_STATE_MAX_AGE_SECONDS * 1000) return false
  return safeEqual(handshake.state, stateFromZoho)
}

/**
 * Only a same-origin path is an acceptable landing place. Anything else — an absolute URL, a
 * protocol-relative `//evil.example`, a backslash Windows treats as a slash — becomes `/`,
 * so the sign-in flow can never be used as an open redirect.
 */
export function safeReturnTo(candidate: string | null | undefined): string {
  if (!candidate) return '/'
  if (!candidate.startsWith('/')) return '/'
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/'
  return candidate
}
