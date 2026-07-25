import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { refreshProjectIndex } from '@/lib/index/refresh'
import { isIndexStale } from '@/lib/index/store'

/**
 * `POST /api/index/refresh` — rebuild on demand (task 3.4).
 *
 * The schedule is the primary trigger; this exists for the case a scheduled run has not
 * happened yet, and for a first deployment. Signed-in only: the build runs on the service
 * credential, so an unauthenticated trigger would let anyone spend the portal's rate limit.
 *
 * `GET` reports staleness without spending a single Zoho call, which is what the browser uses
 * to decide whether a rebuild is worth asking for.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 800

export async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const [stale, projects] = await Promise.all([
    isIndexStale(prisma),
    prisma.projectIndex.count(),
  ])
  return NextResponse.json({ stale, projects })
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const outcome = await refreshProjectIndex(prisma, {
    trigger: 'browser',
    userId: session.user.id,
  })
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 502 })
}
