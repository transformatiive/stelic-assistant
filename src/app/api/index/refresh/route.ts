import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireApiSession } from '@/lib/auth/guard'
import { buildProjectIndex } from '@/lib/index/build'
import { isIndexStale, refreshRecency, saveProjectIndex } from '@/lib/index/store'
import { serviceCrmClient, serviceProjectsClient } from '@/lib/zoho/factory'
import { ServiceCredentialUnavailable } from '@/lib/auth/token-sources'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'

/**
 * `POST /api/index/refresh` — rebuild the caller's project index (task 3.4).
 *
 * Signed-in only, though the build itself runs on the service credential: the index is
 * per-user data, and an unauthenticated trigger would let anyone spend the portal's rate
 * limit. `GET` reports staleness without spending a single Zoho call, which is what the chat
 * route will use to decide whether a refresh is due.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const [stale, count] = await Promise.all([
    isIndexStale(prisma, session.user.id),
    prisma.projectIndex.count({ where: { userId: session.user.id } }),
  ])
  return NextResponse.json({ stale, projects: count })
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireApiSession(request)
  if (!session.ok) return session.response

  const startedAt = Date.now()

  try {
    const result = await buildProjectIndex({
      projects: serviceProjectsClient(prisma),
      crm: serviceCrmClient(prisma),
    })

    const saved = await saveProjectIndex(prisma, session.user.id, result.rows)
    const recency = await refreshRecency(prisma, session.user.id)

    console.info(
      JSON.stringify({
        event: 'index.rebuilt',
        userId: session.user.id,
        ...result.stats,
        ...saved,
        recency,
        ms: Date.now() - startedAt,
      }),
    )

    return NextResponse.json({ ok: true, ...result.stats, ...saved, recency })
  } catch (error) {
    return NextResponse.json(describe(error), { status: 502 })
  }
}

/**
 * Turn a failure into something diagnosable without leaking a token or a client name.
 *
 * The scope case is called out by name deliberately. `403 Invalid OAuth scope` is what the
 * service credential returns when it was consented without the reads this needs, and it is
 * the single most likely thing to be wrong on a first run — task 0.2 already hit it once on
 * the users endpoint. Reporting it as a generic upstream error would send someone hunting
 * through logs for something the response could have named.
 */
function describe(error: unknown): { ok: false; reason: string; detail: string } {
  if (error instanceof ServiceCredentialUnavailable) {
    return {
      ok: false,
      reason: 'service_credential',
      detail:
        'The service credential could not be refreshed. Check ZOHO_SERVICE_REFRESH_TOKEN.',
    }
  }
  if (error instanceof ZohoAuthError) {
    return {
      ok: false,
      reason: 'service_credential',
      detail: 'Zoho rejected the service credential after a refresh.',
    }
  }
  if (error instanceof ZohoRateLimitError) {
    return {
      ok: false,
      reason: 'rate_limited',
      detail: 'Zoho rate limited the rebuild. Try again in a couple of minutes.',
    }
  }
  if (error instanceof ZohoHttpError) {
    const scopeProblem = error.status === 403 && /Invalid OAuth scope/i.test(error.body)
    return {
      ok: false,
      reason: scopeProblem ? 'missing_scope' : 'zoho_error',
      detail: scopeProblem
        ? 'The service credential lacks a read scope. Re-consent it with ZohoProjects.projects.READ, ZohoProjects.tasks.READ and ZohoCRM.modules.READ.'
        : `Zoho responded ${error.status}.`,
    }
  }
  console.error(
    JSON.stringify({
      event: 'index.rebuild_failed',
      error: error instanceof Error ? error.name : 'unknown',
    }),
  )
  return { ok: false, reason: 'unknown', detail: 'The rebuild failed.' }
}
