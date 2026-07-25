import { after } from 'next/server'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { warmCrmUserId } from '@/lib/auth/crm-warm'
import { isIndexStale } from '@/lib/index/store'
import { route } from '@/lib/observability/route'
import { serviceCrmClient } from '@/lib/zoho/factory'

/**
 * `GET /api/me` — who is signed in, and is the app ready to be useful (task 7.6).
 *
 * The client needs both in one call on load: a returning user with a live session should go
 * straight to the chat, and the chat is only worth showing if the project index has something
 * in it. Two calls would mean a visible flash of the wrong state.
 *
 * **No Zoho identifiers leave the server.** The browser has no use for a Zuid, and an id in a
 * response is an id in a log, a screenshot and a bug report. The email is here because the
 * person needs to see which account they are signed in as — that is the one identifier with
 * a reason to be on screen.
 *
 * **Background: CRM user ID warming (task 2.5).** The CRM user id is the join key between
 * Projects and CRM — it is what lets the billing-role stamper find the right PCCR row. It
 * only needs to be resolved once per person, and the result is cached on the `User` row, so
 * every subsequent request short-circuits immediately. It runs post-response via `after()` so
 * that a slow CRM call never holds up the chat.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const [projects, stale] = await Promise.all([
    prisma.projectIndex.count(),
    isIndexStale(prisma),
  ])

  // Post-response: warm the CRM user id so it is ready when the first commit needs it.
  // Only fires when not yet cached. `after()` keeps this off the hot path.
  after(() => warmCrmUserId(prisma, serviceCrmClient(), session.user))

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
