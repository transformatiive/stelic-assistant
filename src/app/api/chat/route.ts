import { NextResponse } from 'next/server'
import { z } from 'zod'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { consumeChatQuota } from '@/lib/chat/rate-limit'
import { runChatTurn } from '@/lib/chat/turn'
import { checkUserMessage } from '@/lib/chat/sanitise'
import { chatExtractor, continuationClassifier, userKeyFor } from '@/lib/chat/factory'
import { route } from '@/lib/observability/route'

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

const bodySchema = z.object({ message: z.string() })

export const POST = route(async function POST(request: Request): Promise<NextResponse> {
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
  // Sanitised and bounded in one place (task 9.3): control characters and bidi overrides
  // stripped *before* the length check, so invisible padding cannot smuggle a message past it.
  const checked = parsed.success ? checkUserMessage(parsed.data.message) : null
  if (!checked?.ok) {
    return NextResponse.json(
      {
        error: 'invalid_body',
        message:
          checked?.reason === 'too_long'
            ? 'That is longer than I can take in one go. Split it up.'
            : 'I need something to work with.',
      },
      { status: 400 },
    )
  }

  const result = await runChatTurn(
    prisma,
    chatExtractor(),
    {
      userId: session.user.id,
      displayName: session.user.displayName,
      timezone: session.user.timezone,
      message: checked.message,
      defaultBillable: config.DEFAULT_BILL_STATUS === 'Billable',
      backdateWarnDays: config.BACKDATE_WARN_DAYS,
      userKey: userKeyFor(session.user.id),
    },
    continuationClassifier(),
  )

  return NextResponse.json(result)
})
