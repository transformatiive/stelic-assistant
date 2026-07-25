import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { isIndexStale } from '@/lib/index/store'
import { route } from '@/lib/observability/route'
import { resolveCrmUserId } from '@/lib/zoho/crm-users'
import { serviceCrmClient } from '@/lib/zoho/factory'

/**
 * `GET /api/me` — who is signed in, and is the app ready to be useful (task 7.6)?
 *
 * The client needs both in one call on load: a returning user with a live session should go
 * straight to the chat, and the chat is only worth showing if the project index has something
 * in it. Two calls would mean a visible flash of the wrong state.
 *
 * **No Zoho identifiers leave the server.** The browser has no use for a zuid, and an id in a
 * response is an id in a log, a screenshot and a bug report. The email is here because the
 * person needs to see which account they are signed in as — that is the one identifier with
 * a reason to be on screen.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  // Task 2.5, AUTH-4: lazily resolve and cache the CRM user id the first time this person
  // calls /api/me after signing in. The function returns immediately if already set, and
  // absence must never block a session (AUTH-4), so this is fire-and-forget.
  // It runs here rather than at sign-in because:
  // - /api/me is called within seconds of every sign-in from the chat page mount
  // - the session already carries the fields we need (no extra DB lookup)
  // - the callback route stays simpler and the resolution does not delay the 302 redirect
  if (!session.user.crmUserId && session.user.zohoUserId) {
    void resolveCrmUserId(prisma, serviceCrmClient(), {
      id: session.user.id,
      zohoUserId: session.user.zohoUserId,
      crmUserId: null,
    })
  }

  const [projects, stale] = await Promise.all([
    prisma.projectIndex.count(),
    isIndexStale(prisma),
  ])

  return NextResponse.json({
    user: {
      email: session.user.email,
      displayName: session.user.displayName,
      timezone: session.user.timezone,
    },
    index: {
      projects,
      stale,
      // The distinction the client acts on: an empty index means "wait", a stale one means
      // "carry on, a refresh is due". Only the first is worth blocking the chat for.
      ready: projects > 0,
    },
  })
})
