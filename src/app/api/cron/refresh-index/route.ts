import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { safeEqual } from '@/lib/auth/crypto'
import { refreshProjectIndex } from '@/lib/index/refresh'

/**
 * `POST /api/cron/refresh-index` — the scheduled rebuild (task 3.4).
 *
 * The index has to be current whether or not anyone has signed in today. Sessions last thirty
 * days, so a returning user goes straight to the chat and never triggers a page load that
 * happens to be the first of the hour — leaving the browser-side warmer as the only trigger
 * would mean the index is freshest exactly when it matters least.
 *
 * Runs on the **service** credential and needs no user, which is the whole point of the index
 * being shared rather than per person.
 *
 * Authenticated by a bearer secret rather than a session, because a scheduler has no session.
 * The comparison is constant-time: a timing oracle on a static secret is a slow but real way
 * to learn it.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request: Request): Promise<NextResponse> {
  const config = loadConfig()

  if (!config.CRON_SECRET) {
    // Refusing is safer than running: an unauthenticated rebuild endpoint is a way to spend
    // someone else's Zoho rate limit.
    console.error(JSON.stringify({ event: 'cron.not_configured' }))
    return NextResponse.json({ error: 'not_configured' }, { status: 503 })
  }

  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (!safeEqual(presented, config.CRON_SECRET)) {
    console.warn(JSON.stringify({ event: 'cron.unauthorised' }))
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  const outcome = await refreshProjectIndex(prisma, { trigger: 'schedule' })
  // 200 either way: a scheduler retrying a rebuild that failed on a missing Zoho scope would
  // hammer the portal for nothing. The log line is the alert, not the status code.
  return NextResponse.json(outcome)
}
