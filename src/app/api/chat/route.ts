import { NextResponse } from 'next/server'
import { z } from 'zod'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { consumeChatQuota } from '@/lib/chat/rate-limit'
import { runChatTurn } from '@/lib/chat/turn'
import { chatExtractor, userKeyFor } from '@/lib/chat/factory'

/**
 * `POST /api/chat` — one turn (task 7.1).
 *
 * Rate limited **before** the model call, because the thing being protected is the spend, not
 * the server (CHAT-14). A user at the limit should not pay for the request that tells them so.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** A slow gateway plus a fallback model is the worst realistic case. */
export const maxDuration = 90

/** Long enough for a week of work described in one go; short enough not to be an attack. */
const MAX_MESSAGE_CHARS = 2000

const bodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
})

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const config = loadConfig()

  const quota = await consumeChatQuota(prisma, session.user.id)
  if (!quota.allowed) {
    return NextResponse.json(
      {
        error: 'rate_limited',
        message: 'That’s a lot of messages at once. Give me a few seconds.',
      },
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
    return NextResponse.json(
      { error: 'invalid_body', message: 'I need something to work with.' },
      { status: 400 },
    )
  }

  const result = await runChatTurn(prisma, chatExtractor(), {
    userId: session.user.id,
    displayName: session.user.displayName,
    timezone: session.user.timezone,
    message: parsed.data.message,
    defaultBillable: config.DEFAULT_BILL_STATUS === 'Billable',
    backdateWarnDays: config.BACKDATE_WARN_DAYS,
    userKey: userKeyFor(session.user.id),
  })

  return NextResponse.json(result)
}
