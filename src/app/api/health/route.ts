import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { route } from '@/lib/observability/route'

/**
 * `GET /api/health` — is this instance able to serve (task 9.4)?
 *
 * **It checks the database and nothing else.** A health check that calls Zoho or OpenRouter
 * would fail the instance during someone else's outage, and Railway would restart a container
 * that was working perfectly — turning a degraded dependency into an unavailable app. Those
 * failures already degrade gracefully in the request path, which is where they belong.
 *
 * Public to the proxy, because a health check has no session by definition. It exposes
 * nothing beyond up-or-down: no version, no counts, no configuration. An unauthenticated
 * endpoint that answers "which env vars are set" is a reconnaissance gift.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async function GET(): Promise<NextResponse> {
  try {
    // The cheapest possible round trip: proves the pool is alive and the credentials work,
    // and touches no table, so it cannot be slowed down by data.
    await prisma.$queryRaw`SELECT 1`
    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
})
