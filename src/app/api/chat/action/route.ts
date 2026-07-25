import { NextResponse } from 'next/server'
import { z } from 'zod'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { consumeChatQuota } from '@/lib/chat/rate-limit'
import { runChatAction } from '@/lib/chat/turn'

/**
 * `POST /api/chat/action` — answer one slot from a chip tap (task 7.2).
 *
 * No model call, so it has its own, looser quota: a person working through a guided form taps
 * far more often than they type, and spending the chat budget on taps would lock them out of
 * the very path that exists for when the model is unavailable. It is still limited, because
 * every tap is a database write.
 *
 * A refused action returns `200`, not an error. The user tapped a real button; the answer is
 * a conversational one — "that option is no longer available", plus the question they are
 * actually on — rather than a failure the client has to invent wording for.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const ACTION_BUCKET = 'chat_action'
export const ACTION_LIMIT_PER_MINUTE = 120

const bodySchema = z.object({
  draftId: z.string().min(1),
  entryId: z.string().min(1),
  slot: z.enum(['project', 'task', 'date', 'hours', 'description']),
  value: z.string().trim().min(1).max(500),
  echo: z.string().trim().min(1).max(500).optional(),
})

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const config = loadConfig()

  const quota = await consumeChatQuota(prisma, session.user.id, {
    bucket: ACTION_BUCKET,
    limit: ACTION_LIMIT_PER_MINUTE,
  })
  if (!quota.allowed) {
    return NextResponse.json(
      { error: 'rate_limited', message: 'Slow down a moment.' },
      { status: 429, headers: { 'retry-after': String(quota.resetSeconds) } },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }

  const result = await runChatAction(prisma, {
    userId: session.user.id,
    timezone: session.user.timezone,
    defaultBillable: config.DEFAULT_BILL_STATUS === 'Billable',
    backdateWarnDays: config.BACKDATE_WARN_DAYS,
    ...parsed.data,
  })

  return NextResponse.json(result)
}
