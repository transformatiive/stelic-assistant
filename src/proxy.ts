import { NextResponse, type NextRequest } from 'next/server'

/**
 * Route middleware — the `proxy` file convention, which Next 16 renamed from `middleware`
 * (task 2.7, AUTH-7).
 *
 * This runs on every request, before the database is in reach, so it can only answer the
 * cheap question: *is a session cookie present at all?* That is enough to satisfy the two
 * scenarios about **unauthenticated** access — no cookie means 401 for an API route and a
 * redirect for a page, with no LLM or Zoho call made.
 *
 * It is deliberately **not** the authority on whether a session is real. A forged or expired
 * id passes here and is refused by `requireApiSession` inside the handler, which can actually
 * read the database. Duplicating that check here would mean either shipping Prisma to the
 * edge or a second, subtly different notion of "valid".
 */

const PUBLIC_PATHS = ['/login']
/**
 * `/api/cron/` is public *to the proxy* because it carries no session — a scheduler has none.
 * It is not unauthenticated: the route checks a bearer secret in constant time and refuses to
 * run at all when one is not configured. Leaving it out of this list meant the proxy answered
 * 401 before the route ever ran, so the schedule could never have worked.
 */
const PUBLIC_PREFIXES = ['/api/auth/', '/api/cron/', '/_next/', '/icons/']
const PUBLIC_FILES = [
  '/manifest.webmanifest',
  '/favicon.ico',
  '/robots.txt',
  '/sw.js',
  // Read by iOS before there is any session — an *Add to Home Screen* from the login page
  // would otherwise get a redirect where it expected a PNG, and fall back to a screenshot.
  '/apple-touch-icon.png',
  // A health check has no session by definition. It answers up-or-down and nothing else, so
  // there is nothing here for an unauthenticated caller to learn (task 9.4).
  '/api/health',
]

// Read directly: this runs in the edge runtime, where `loadConfig` (and the Node
// crypto it pulls in) is not available. The default matches `config.ts`.
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'stelic_session'

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true
  if (PUBLIC_FILES.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

/**
 * One request id for the whole call, minted here when nothing upstream set one (task 9.1).
 *
 * At the edge rather than in each handler, so a request that never reaches a handler — a 401
 * from this file, say — is still traceable, and so a platform-set id is preferred over one of
 * ours when Railway or a proxy has already assigned it.
 */
function withRequestId(request: NextRequest, response: NextResponse): NextResponse {
  const id = request.headers.get('x-request-id') ?? crypto.randomUUID()
  response.headers.set('x-request-id', id)
  return response
}

/** Pass the id inward, so the handler's logger picks the same one out of the request. */
function forward(request: NextRequest): NextResponse {
  const id = request.headers.get('x-request-id') ?? crypto.randomUUID()
  const headers = new Headers(request.headers)
  headers.set('x-request-id', id)
  const response = NextResponse.next({ request: { headers } })
  response.headers.set('x-request-id', id)
  return response
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl

  if (isPublic(pathname)) return forward(request)
  if (request.cookies.has(SESSION_COOKIE_NAME)) return forward(request)

  if (pathname.startsWith('/api/')) {
    return withRequestId(
      request,
      NextResponse.json({ error: 'unauthenticated' }, { status: 401 }),
    )
  }

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  // Come back to where they were trying to go, so a deep link survives sign-in.
  if (pathname !== '/') login.searchParams.set('returnTo', `${pathname}${search}`)
  return withRequestId(request, NextResponse.redirect(login))
}

export const config = {
  // Everything except Next's own build output and static assets, which never need a session
  // and would only add latency.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
