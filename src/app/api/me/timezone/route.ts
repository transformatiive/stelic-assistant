import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { shouldUpdateTimeZone } from '@/lib/auth/timezone'

/**
 * `POST /api/me/timezone` — record where this person actually is (task 5.10).
 *
 * Stelic's people are in dispersed timezones and a timesheet records a day, so "yesterday"
 * has to mean yesterday where they are. The browser is the only thing that knows; the server
 * cannot infer it, and the portal's own setting describes where the portal was configured.
 *
 * Trusted because a user can only mis-set their own days, and because a person travelling is
 * a real case rather than an attack. Validated as an IANA name the runtime recognises, so a
 * malformed value cannot reach the date resolver.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const reported = (body as { timeZone?: unknown } | null)?.timeZone
  if (!shouldUpdateTimeZone(session.user.timezone, reported)) {
    // Unchanged or unusable: either way there is nothing to write.
    return NextResponse.json({ timeZone: session.user.timezone, updated: false })
  }

  const timeZone = (reported as string).trim()
  await prisma.user.update({
    where: { id: session.user.id },
    data: { timezone: timeZone },
  })
  console.info(
    JSON.stringify({ event: 'user.timezone_updated', userId: session.user.id, timeZone }),
  )

  return NextResponse.json({ timeZone, updated: true })
}
