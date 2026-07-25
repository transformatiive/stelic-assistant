import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { clearedCookieOptions } from './session'
import { loadSession, type AuthenticatedUser } from './store'
import { logAuthEvent } from './log'
import { readCookie } from './request'

/**
 * The authoritative session check (task 2.7, AUTH-7).
 *
 * Middleware can only see whether a cookie is *present*; it runs before the database is
 * reachable. So middleware turns away the obviously-unauthenticated cheaply, and this runs
 * inside the handler to decide whether the cookie names a real, live session. A forged id
 * gets past middleware and dies here.
 */

export type GuardResult =
  | { ok: true; sessionId: string; user: AuthenticatedUser }
  | { ok: false; response: NextResponse }

export async function requireApiSession(request: Request): Promise<GuardResult> {
  const config = loadConfig()
  const sessionId = readCookie(
    request.headers.get('cookie') ?? '',
    config.SESSION_COOKIE_NAME,
  )

  const lookup = await loadSession(prisma, sessionId, {
    maxAgeDays: config.SESSION_MAX_AGE_DAYS,
  })

  if (lookup.status !== 'valid') {
    // Logged whether the cookie was absent or unrecognised — the second is worth noticing,
    // and the client is told neither.
    logAuthEvent('auth.unauthenticated', {
      requestId: request.headers.get('x-request-id'),
      presented: sessionId !== undefined,
    })

    const response = NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
    if (sessionId !== undefined) {
      // A stale cookie is worse than none: it keeps the browser thinking it is signed in.
      const cleared = clearedCookieOptions(config.SESSION_COOKIE_NAME)
      response.cookies.set({ ...cleared, value: '' })
    }
    return { ok: false, response }
  }

  return { ok: true, sessionId: lookup.sessionId, user: lookup.user }
}
