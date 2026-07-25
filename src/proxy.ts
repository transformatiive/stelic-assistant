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
]

// Read directly: this runs in the edge runtime, where `loadConfig` (and the Node
// crypto it pulls in) is not available. The default matches `config.ts`.
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'stelic_session'

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true
  if (PUBLIC_FILES.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl

  if (isPublic(pathname)) return NextResponse.next()
  if (request.cookies.has(SESSION_COOKIE_NAME)) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const login = request.nextUrl.clone()
  login.pathname = '/login'
  login.search = ''
  // Come back to where they were trying to go, so a deep link survives sign-in.
  if (pathname !== '/') login.searchParams.set('returnTo', `${pathname}${search}`)
  return NextResponse.redirect(login)
}

export const config = {
  // Everything except Next's own build output and static assets, which never need a session
  // and would only add latency.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
