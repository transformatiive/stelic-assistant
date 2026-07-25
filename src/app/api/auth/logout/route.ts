import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { clearedCookieOptions } from '@/lib/auth/session'
import {
  clearTokens,
  hasOtherActiveSession,
  loadSession,
  revokeSession,
} from '@/lib/auth/store'
import { logAuthEvent } from '@/lib/auth/log'
import { readCookie } from '@/lib/auth/request'

/**
 * `POST /api/auth/logout` — sign out this device (task 2.9, AUTH-8 *Sign out*).
 *
 * POST, not GET: a link-prefetcher or an `<img src>` must not be able to sign someone out.
 * Only this session is revoked — the same person's other devices keep working (AUTH-5,
 * *Multiple devices*). The stored Zoho grant is dropped only when no live session is left.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const config = loadConfig()
  const now = new Date()
  const sessionId = readCookie(
    request.headers.get('cookie') ?? '',
    config.SESSION_COOKIE_NAME,
  )

  if (sessionId) {
    const lookup = await loadSession(prisma, sessionId, {
      maxAgeDays: config.SESSION_MAX_AGE_DAYS,
      now,
    })
    await revokeSession(prisma, sessionId, now)

    if (lookup.status === 'valid') {
      const stillSignedInElsewhere = await hasOtherActiveSession(
        prisma,
        lookup.user.id,
        sessionId,
        now,
      )
      if (!stillSignedInElsewhere) await clearTokens(prisma, lookup.user.id)
      logAuthEvent('auth.signed_out', {
        userId: lookup.user.id,
        keptGrant: stillSignedInElsewhere,
      })
    }
  }

  // Always 200 with the cookie cleared, even for an unknown session: signing out must never
  // fail, and the answer must not reveal whether the id was real.
  const response = NextResponse.json({ ok: true })
  response.cookies.set({ ...clearedCookieOptions(config.SESSION_COOKIE_NAME), value: '' })
  response.headers.set('Cache-Control', 'no-store')
  return response
}
