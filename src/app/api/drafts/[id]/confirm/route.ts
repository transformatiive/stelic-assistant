import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { userProjectsClient } from '@/lib/zoho/factory'
import { confirmDraft, type ConfirmRefusal } from '@/lib/commit/confirm'

/**
 * `POST /api/drafts/{id}/confirm` — write the draft into Zoho (task 6.5).
 *
 * **The body is not read.** Everything to be written was resolved server-side when the card
 * was built, and the draft is re-read here by id and owner. Accepting entry data from the
 * client would let a crafted request log hours to any project in the portal.
 *
 * The write runs on the signed-in person's own Zoho credential, so the log's owner is the
 * person the hours belong to (AUTH-8, design §2).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A ten-entry draft is ten sequential Zoho calls, and Zoho is not always quick. */
export const maxDuration = 120

const REFUSALS: Record<ConfirmRefusal, { status: number; message: string }> = {
  not_found: { status: 404, message: 'That draft no longer exists.' },
  expired: {
    status: 409,
    message: 'That draft has expired. Tell me again what you worked on.',
  },
  cancelled: { status: 409, message: 'That draft was cancelled.' },
  nothing_ready: {
    status: 409,
    message: 'Nothing on that card can be logged yet.',
  },
  no_source_message: {
    status: 409,
    message: 'That draft has lost the message it came from and cannot be logged.',
  },
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const { id } = await context.params

  const result = await confirmDraft(prisma, userProjectsClient(session.user.id), {
    userId: session.user.id,
    draftId: id,
    zohoUserId: session.user.zohoUserId,
    logger: {
      info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
      warn: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
    },
  })

  if (!result.ok) {
    const refusal = REFUSALS[result.refusal]
    if (result.refusal === 'no_source_message') {
      // An invariant the chat API is supposed to hold: a draft always follows a message.
      console.error(JSON.stringify({ event: 'confirm.no_source_message', draftId: id }))
    }
    return NextResponse.json(
      { error: result.refusal, message: refusal.message },
      { status: refusal.status },
    )
  }

  return NextResponse.json(result)
}
