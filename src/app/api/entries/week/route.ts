import { NextResponse } from 'next/server'
import { requireApiSession } from '@/lib/auth/guard'
import { userProjectsClient } from '@/lib/zoho/factory'
import { readWeek } from '@/lib/entries/week'
import { ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'

/**
 * `GET /api/entries/week` — what this person logged, Sunday to Saturday (task 6.8).
 *
 * Runs on the signed-in person's own credential rather than the shared service one. It is
 * their own timesheet, their token already carries `ZohoProjects.timesheets.ALL`, and a
 * per-person read on the shared credential would spend the index rebuild's rate limit
 * (100 calls per 120 seconds, portal-wide) on something that concerns one user.
 *
 * `?date=YYYY-MM-DD` picks the week containing that date; without it, the week containing
 * today where the person is.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  if (!session.user.zohoUserId) {
    // Every row gets a zuid at sign-in, so this means the row predates that or the identity
    // call failed. Reading the whole portal's logs instead would be worse than saying so.
    return NextResponse.json(
      {
        error: 'no_zoho_identity',
        message: 'I could not work out which Zoho user you are.',
      },
      { status: 409 },
    )
  }

  const date = new URL(request.url).searchParams.get('date') ?? undefined

  try {
    const week = await readWeek(userProjectsClient(session.user.id), {
      zuid: session.user.zohoUserId,
      timezone: session.user.timezone,
      date,
    })
    return NextResponse.json(week)
  } catch (error) {
    const rateLimited = error instanceof ZohoRateLimitError
    console.warn(
      JSON.stringify({
        event: 'week.read_failed',
        userId: session.user.id,
        status: error instanceof ZohoHttpError ? error.status : null,
        rateLimited,
      }),
    )
    return NextResponse.json(
      {
        error: rateLimited ? 'rate_limited' : 'zoho_error',
        message: rateLimited
          ? 'Zoho is rate limiting right now. Try again shortly.'
          : 'Zoho would not give me your week.',
      },
      { status: rateLimited ? 429 : 502 },
    )
  }
}
