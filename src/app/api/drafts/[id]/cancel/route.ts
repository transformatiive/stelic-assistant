import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { cancelDraft } from '@/lib/commit/confirm'

/**
 * `POST /api/drafts/{id}/cancel` — discard a draft without writing anything (task 6.6).
 *
 * Idempotent: the failure mode of a cancel button is a double tap, and the second one should
 * not produce an error. A confirmed draft is refused rather than cancelled — cancelling does
 * not undo anything, and answering `200` would leave someone believing hours had been removed
 * from Zoho when they had not.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const { id } = await context.params
  const result = await cancelDraft(prisma, { userId: session.user.id, draftId: id })

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.refusal,
        message:
          result.refusal === 'not_found'
            ? 'That draft no longer exists.'
            : 'Those hours are already in Zoho. Use undo to remove them.',
      },
      { status: result.refusal === 'not_found' ? 404 : 409 },
    )
  }

  return NextResponse.json({ draftId: id, status: 'cancelled' })
}
