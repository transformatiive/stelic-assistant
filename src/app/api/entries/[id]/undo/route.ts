import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { userProjectsClient } from '@/lib/zoho/factory'
import { undoEntry, type UndoRefusal } from '@/lib/commit/undo'
import { route } from '@/lib/observability/route'

/**
 * `POST /api/entries/{id}/undo` — remove a log this app created today (task 6.7).
 *
 * `{id}` is the `CommitLog` id, not a Zoho log id: the app deletes only what it has its own
 * record of. Taking a Zoho id from the client would let a crafted request delete any log in
 * the portal.
 *
 * The delete runs on the signed-in person's own credential, same as the write did.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STATUS: Record<UndoRefusal, number> = {
  not_found: 404,
  not_today: 409,
  already_undone: 409,
  never_created: 409,
  no_log_id: 409,
  billed: 409,
  zoho_error: 502,
}

export const POST = route(async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const { id } = await context.params
  const config = loadConfig()

  const result = await undoEntry(prisma, userProjectsClient(session.user.id), {
    userId: session.user.id,
    commitLogId: id,
    timezone: session.user.timezone,
    billingLockedThrough: config.BILLING_LOCKED_THROUGH,
  })

  if (!result.ok) {
    return NextResponse.json(
      { error: result.refusal, message: result.message },
      { status: STATUS[result.refusal] },
    )
  }

  return NextResponse.json(result)
})
