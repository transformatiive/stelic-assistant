import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { requireApiSession } from '@/lib/auth/guard'
import { createPkcePair, createState } from '@/lib/auth/pkce'
import { encodeHandshake } from '@/lib/auth/oauth-state'
import {
  SERVICE_CONNECT_COOKIE,
  SERVICE_CONNECT_MAX_AGE_SECONDS,
  SERVICE_SCOPES,
} from '@/lib/auth/service-connect'
import { buildAuthorizeUrl } from '@/lib/auth/zoho-oauth'

/**
 * `GET /api/admin/zoho/connect` — start the service-credential handshake (task 0.1).
 *
 * Signed-in only. Whoever completes this is the identity the app's reads run as, so it should
 * be someone with portal-wide visibility — but that is a judgement the app cannot make for
 * them, and gating it on a Zoho role we do not reliably know would lock out the one person who
 * can fix a broken credential.
 *
 * It reuses `/api/auth/callback` as its redirect URI, distinguished there by its own cookie.
 * A second redirect URI would have to be registered in the Zoho console, and asking for more
 * console work is exactly what this route exists to avoid.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const config = loadConfig()
  const { verifier, challenge } = createPkcePair()
  const state = createState()

  const authorizeUrl = buildAuthorizeUrl(
    {
      clientId: config.ZOHO_CLIENT_ID,
      redirectUri: config.ZOHO_REDIRECT_URI,
      accountsDomain: config.ZOHO_ACCOUNTS_DOMAIN,
    },
    { state, codeChallenge: challenge, scopes: SERVICE_SCOPES },
  )

  const response = NextResponse.redirect(authorizeUrl, { status: 302 })
  response.cookies.set({
    name: SERVICE_CONNECT_COOKIE,
    value: encodeHandshake(
      { state, verifier, returnTo: '/', issuedAt: Date.now() },
      config.TOKEN_ENCRYPTION_KEY,
    ),
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SERVICE_CONNECT_MAX_AGE_SECONDS,
  })
  response.headers.set('Cache-Control', 'no-store')
  return response
}
