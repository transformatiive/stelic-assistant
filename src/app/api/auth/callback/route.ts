import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { completeCallback } from '@/lib/auth/callback-flow'
import { OAUTH_STATE_COOKIE, decodeHandshake } from '@/lib/auth/oauth-state'
import { logAuthEvent } from '@/lib/auth/log'
import { sessionCookieOptions } from '@/lib/auth/session'
import { createSession, saveTokens, upsertUser } from '@/lib/auth/store'
import { exchangeCode, fetchIdentity, fetchProfile } from '@/lib/auth/zoho-oauth'
import { appOrigin, clientIpFrom, readCookie } from '@/lib/auth/request'

/**
 * `GET /api/auth/callback` — finish the handshake (tasks 2.2, 2.4).
 *
 * All the branching lives in `callback-flow.ts`; this handler is the wiring: real Zoho, real
 * database, real cookies. It always lands the browser on a page — a bare JSON error here
 * would strand someone mid-sign-in.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const config = loadConfig()
  const requestId = randomUUID()
  const url = new URL(request.url)
  // The public origin, never the request's — behind Railway's proxy that is localhost:8080.
  const origin = appOrigin(config.ZOHO_REDIRECT_URI)
  const now = new Date()

  const cookieHeader = request.headers.get('cookie') ?? ''
  const handshake = decodeHandshake(
    readCookie(cookieHeader, OAUTH_STATE_COOKIE),
    config.TOKEN_ENCRYPTION_KEY,
  )

  const oauthConfig = {
    clientId: config.ZOHO_CLIENT_ID,
    clientSecret: config.ZOHO_CLIENT_SECRET,
    redirectUri: config.ZOHO_REDIRECT_URI,
    accountsDomain: config.ZOHO_ACCOUNTS_DOMAIN,
  }

  const outcome = await completeCallback(
    {
      handshake,
      state: url.searchParams.get('state'),
      code: url.searchParams.get('code'),
      errorFromZoho: url.searchParams.get('error'),
      requestId,
      now,
    },
    {
      exchangeCode: (params) => exchangeCode(oauthConfig, params, { now }),
      fetchIdentity: (accessToken) =>
        fetchIdentity(accessToken, config.ZOHO_PORTAL_ID, {
          projectsApiDomain: config.ZOHO_PROJECTS_API_DOMAIN,
        }),
      fetchProfile: (accessToken) =>
        fetchProfile(accessToken, config.ZOHO_ACCOUNTS_DOMAIN),
      upsertUser: (input) => upsertUser(prisma, input, now),
      saveTokens: (userId, tokens) =>
        saveTokens(prisma, userId, tokens, config.TOKEN_ENCRYPTION_KEY),
      createSession: (userId) =>
        createSession(
          prisma,
          {
            userId,
            userAgent: request.headers.get('user-agent'),
            ip: clientIpFrom(request.headers),
            ipSalt: config.TOKEN_ENCRYPTION_KEY,
            maxAgeDays: config.SESSION_MAX_AGE_DAYS,
          },
          now,
        ),
      log: logAuthEvent,
    },
  )

  // Whatever happened, the one-shot handshake cookie is spent.
  const clearHandshake = (response: NextResponse) => {
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    response.headers.set('Cache-Control', 'no-store')
    return response
  }

  if (outcome.status === 'error') {
    const target = new URL('/login', origin)
    // A reason code, not a sentence: the login page owns the wording, and a message in a
    // query string is a message an attacker can choose.
    target.searchParams.set('error', outcome.reason)
    return clearHandshake(NextResponse.redirect(target, { status: 302 }))
  }

  const response = NextResponse.redirect(new URL(outcome.returnTo, origin), {
    status: 302,
  })
  const cookie = sessionCookieOptions(
    config.SESSION_COOKIE_NAME,
    config.SESSION_MAX_AGE_DAYS,
  )
  response.cookies.set({ ...cookie, value: outcome.sessionId })
  return clearHandshake(response)
}
