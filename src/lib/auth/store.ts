import type { PrismaClient } from '@/generated/prisma/client'
import { encrypt } from './crypto'
import {
  DEFAULT_MAX_AGE_DAYS,
  checkSession,
  createSessionId,
  expiryFrom,
  hashIp,
} from './session'
import type { ZohoTokens } from './zoho-oauth'

/**
 * Persistence for users, tokens and sessions (tasks 2.2, 2.4, 2.6, 2.9).
 *
 * The rules live in `session.ts` and stay pure; this module is the part that touches the
 * database, so the two cannot drift into two different notions of "expired".
 */

export type UpsertUserInput = {
  zohoUserId: string
  email: string
  displayName?: string
  zohoProjectsUserId: string
}

/**
 * Match on `zohoUserId` first — it is the stable identity. Email is unique too but a person
 * can have theirs changed in Zoho, and we would rather update the address on an existing row
 * than create a second user who then owns none of their own history.
 */
export async function upsertUser(
  db: PrismaClient,
  input: UpsertUserInput,
  now: Date = new Date(),
): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase()
  const existing =
    (await db.user.findUnique({ where: { zohoUserId: input.zohoUserId } })) ??
    (await db.user.findUnique({ where: { email } }))

  if (existing) {
    return db.user.update({
      where: { id: existing.id },
      data: {
        zohoUserId: input.zohoUserId,
        email,
        // Never overwrite a stored name with nothing.
        ...(input.displayName ? { displayName: input.displayName } : {}),
        zohoProjectsUserId: input.zohoProjectsUserId,
        isActive: true,
        lastSeenAt: now,
      },
      select: { id: true },
    })
  }

  return db.user.create({
    data: {
      zohoUserId: input.zohoUserId,
      email,
      displayName: input.displayName ?? null,
      zohoProjectsUserId: input.zohoProjectsUserId,
      lastSeenAt: now,
    },
    select: { id: true },
  })
}

/**
 * Both tokens are encrypted before they touch the row (AUTH-2). Zoho omits the refresh token
 * on a plain refresh, so an absent one means "keep the one you have", not "clear it".
 */
export async function saveTokens(
  db: PrismaClient,
  userId: string,
  tokens: ZohoTokens,
  key: string,
): Promise<void> {
  const accessTokenEncrypted = encrypt(tokens.accessToken, key)
  const refreshTokenEncrypted = tokens.refreshToken
    ? encrypt(tokens.refreshToken, key)
    : undefined

  await db.oAuthToken.upsert({
    where: { userId },
    create: {
      userId,
      // A create without a refresh token would leave a row that can never refresh; callers
      // are expected to have rejected that case already.
      refreshTokenEncrypted: refreshTokenEncrypted ?? '',
      accessTokenEncrypted,
      accessTokenExpiresAt: tokens.expiresAt,
      scope: tokens.scope ?? null,
    },
    update: {
      ...(refreshTokenEncrypted ? { refreshTokenEncrypted } : {}),
      accessTokenEncrypted,
      accessTokenExpiresAt: tokens.expiresAt,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    },
  })
}

/** Consent is gone: the stored grant is worthless and must not be retried (AUTH-6). */
export async function clearTokens(db: PrismaClient, userId: string): Promise<void> {
  await db.oAuthToken.deleteMany({ where: { userId } })
}

export type CreateSessionInput = {
  userId: string
  userAgent?: string | null
  ip?: string | null
  ipSalt: string
  maxAgeDays?: number
}

export async function createSession(
  db: PrismaClient,
  input: CreateSessionInput,
  now: Date = new Date(),
): Promise<{ id: string; expiresAt: Date }> {
  const id = createSessionId()
  const expiresAt = expiryFrom(now, input.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS)

  await db.session.create({
    data: {
      id,
      userId: input.userId,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipHash: input.ip ? hashIp(input.ip, input.ipSalt) : null,
      createdAt: now,
      lastUsedAt: now,
      expiresAt,
    },
  })

  return { id, expiresAt }
}

export type AuthenticatedUser = {
  id: string
  email: string
  displayName: string | null
  zohoUserId: string | null
  zohoProjectsUserId: string | null
  crmUserId: string | null
  timezone: string
}

export type SessionLookup =
  { status: 'valid'; sessionId: string; user: AuthenticatedUser } | { status: 'invalid' }

/**
 * Resolve a cookie value to a user, sliding the expiry as it goes (AUTH-5).
 *
 * An unknown id, an expired one and a revoked one all return the same `invalid` — a caller
 * has no business distinguishing them, and neither has an attacker probing for valid ids.
 */
export async function loadSession(
  db: PrismaClient,
  sessionId: string | undefined,
  options: { maxAgeDays?: number; now?: Date } = {},
): Promise<SessionLookup> {
  if (!sessionId) return { status: 'invalid' }

  const now = options.now ?? new Date()
  const maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS

  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  })
  if (!session || !session.user || !session.user.isActive) return { status: 'invalid' }

  const verdict = checkSession(session, now, maxAgeDays)
  if (verdict.status !== 'valid') return { status: 'invalid' }

  if (verdict.slide) {
    await db.session.update({
      where: { id: session.id },
      data: { lastUsedAt: now, expiresAt: verdict.newExpiresAt },
    })
  }

  const user = session.user
  return {
    status: 'valid',
    sessionId: session.id,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      zohoUserId: user.zohoUserId,
      zohoProjectsUserId: user.zohoProjectsUserId,
      crmUserId: user.crmUserId,
      timezone: user.timezone,
    },
  }
}

/**
 * Revoke one session, not the user (AUTH-5, *Multiple devices*). Signing out on a phone must
 * leave the desktop alone.
 */
export async function revokeSession(
  db: PrismaClient,
  sessionId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: now },
  })
}

/** True when the user has no other live session — the cue to drop the stored grant (AUTH-8). */
export async function hasOtherActiveSession(
  db: PrismaClient,
  userId: string,
  excludingSessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const count = await db.session.count({
    where: {
      userId,
      id: { not: excludingSessionId },
      revokedAt: null,
      expiresAt: { gt: now },
    },
  })
  return count > 0
}

/** Every session for a user, e.g. after a refresh failure means the grant is dead (AUTH-6). */
export async function revokeAllSessions(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: now },
  })
}
