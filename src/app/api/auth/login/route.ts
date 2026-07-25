import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { createPkcePair, createState } from '@/lib/auth/pkce'
import { buildAuthorizeUrl } from '@/lib/auth/zoho-oauth'
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SECONDS,
  encodeHandshake,
  safeReturnTo,
} from '@/lib/auth/oauth-state'

/**
 * `GET /api/auth/login` — start the handshake (task 2.1, AUTH-1).
 *
 * Issues `state` and a PKCE pair, parks them in a short-lived encrypted cookie, and sends the
 * browser to Zoho's own hosted login page. This app never sees a password.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(request: Request): NextResponse {
  const config = loadConfig()
  const { verifier, challenge } = createPkcePair()
  const state = createState()

  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'))

  const authorizeUrl = buildAuthorizeUrl(
    {
      clientId: config.ZOHO_CLIENT_ID,
      redirectUri: config.ZOHO_REDIRECT_URI,
      accountsDomain: config.ZOHO_ACCOUNTS_DOMAIN,
    },
    { state, codeChallenge: challenge },
  )

  const response = NextResponse.redirect(authorizeUrl, { status: 302 })
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: encodeHandshake(
      { state, verifier, returnTo, issuedAt: Date.now() },
      config.TOKEN_ENCRYPTION_KEY,
    ),
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the browser arrives back from accounts.zoho.com on a top-level GET,
    // and Strict would withhold the cookie exactly when the callback needs it.
    sameSite: 'lax',
    path: '/',
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  })

  // The authorize URL carries a one-shot challenge; nothing may cache this hop.
  response.headers.set('Cache-Control', 'no-store')
  return response
}
