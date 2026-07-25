import { createHash, randomBytes } from 'node:crypto'

/**
 * Session policy (task 2.6, AUTH-5).
 *
 * Pure decisions only — what the cookie looks like, when a session expires, whether to slide
 * it. Persistence lives with the route handlers; keeping the rules here makes them testable
 * without a database and impossible to get subtly different in two places.
 */

export const DEFAULT_MAX_AGE_DAYS = 30
const DAY_MS = 86_400_000

/** Opaque, 256 bits of entropy. Never a token, never a serialised user. */
export function createSessionId(): string {
  return randomBytes(32).toString('base64url')
}

/** IPs are logged as a salted hash — useful for spotting theft, not for tracking people. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`).digest('base64url').slice(0, 32)
}

export type CookieOptions = {
  name: string
  httpOnly: true
  secure: true
  sameSite: 'lax'
  path: '/'
  maxAge: number
}

export function sessionCookieOptions(
  name: string,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
): CookieOptions {
  return {
    name,
    // HttpOnly keeps it out of document.cookie; Secure keeps it off plain HTTP; Lax lets the
    // OAuth redirect back from Zoho carry it while still blocking cross-site POSTs.
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.round(maxAgeDays * DAY_MS) / 1000,
  }
}

/** Clearing means an immediately-expired cookie with otherwise identical attributes. */
export function clearedCookieOptions(name: string): CookieOptions {
  return { ...sessionCookieOptions(name), maxAge: 0 }
}

export function expiryFrom(now: Date, maxAgeDays = DEFAULT_MAX_AGE_DAYS): Date {
  return new Date(now.getTime() + maxAgeDays * DAY_MS)
}

export type SessionRecord = {
  expiresAt: Date
  revokedAt?: Date | null
  lastUsedAt?: Date | null
}

export type SessionCheck =
  | { status: 'valid'; slide: boolean; newExpiresAt: Date }
  | { status: 'expired' }
  | { status: 'revoked' }

/**
 * Expiry is sliding, but the row is only touched when it has drifted by more than an hour —
 * otherwise every request writes to the database to move a 30-day deadline by milliseconds.
 */
export const SLIDE_THRESHOLD_MS = 60 * 60 * 1000

export function checkSession(
  session: SessionRecord,
  now: Date,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
): SessionCheck {
  if (session.revokedAt) return { status: 'revoked' }
  if (session.expiresAt.getTime() <= now.getTime()) return { status: 'expired' }

  const newExpiresAt = expiryFrom(now, maxAgeDays)
  const slide = newExpiresAt.getTime() - session.expiresAt.getTime() > SLIDE_THRESHOLD_MS
  return { status: 'valid', slide, newExpiresAt }
}

/** An access token is due for refresh slightly before it actually lapses. */
export function needsRefresh(expiresAt: Date | null | undefined, now: Date): boolean {
  if (!expiresAt) return true
  return expiresAt.getTime() - now.getTime() <= 30_000
}
