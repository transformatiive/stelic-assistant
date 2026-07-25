import type { PrismaClient } from '@/generated/prisma/client'
import { buildProjectIndex, type BuildResult } from './build'
import { saveProjectIndex } from './store'
import { serviceCrmClient, serviceProjectsClient } from '@/lib/zoho/factory'
import { ServiceCredentialUnavailable } from '@/lib/auth/token-sources'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'

/**
 * Rebuilding the shared index (task 3.4).
 *
 * One function behind both callers — the schedule and the browser — so a rebuild triggered by
 * cron and one triggered by someone opening the app cannot drift into behaving differently.
 */

export type RefreshOutcome =
  | {
      ok: true
      stats: BuildResult['stats']
      written: number
      removed: number
      ms: number
    }
  | { ok: false; reason: RefreshFailure; detail: string; ms: number }

export type RefreshFailure =
  'service_credential' | 'rate_limited' | 'missing_scope' | 'zoho_error' | 'unknown'

export async function refreshProjectIndex(
  db: PrismaClient,
  options: { trigger: 'schedule' | 'browser'; userId?: string } = { trigger: 'browser' },
): Promise<RefreshOutcome> {
  const startedAt = Date.now()

  try {
    const result = await buildProjectIndex(
      { projects: serviceProjectsClient(db), crm: serviceCrmClient(db) },
      {
        onTaskFailure: (project, error) =>
          console.warn(
            JSON.stringify({
              event: 'index.tasks_unreadable',
              projectId: project.id,
              status: error instanceof ZohoHttpError ? error.status : null,
            }),
          ),
      },
    )

    const saved = await saveProjectIndex(db, result.rows)
    const ms = Date.now() - startedAt

    console.info(
      JSON.stringify({
        event: 'index.rebuilt',
        trigger: options.trigger,
        userId: options.userId ?? null,
        ...result.stats,
        ...saved,
        ms,
      }),
    )

    return { ok: true, stats: result.stats, ...saved, ms }
  } catch (error) {
    const { reason, detail } = describe(error)
    const ms = Date.now() - startedAt

    console.error(
      JSON.stringify({
        event: 'index.rebuild_failed',
        trigger: options.trigger,
        userId: options.userId ?? null,
        reason,
        error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
        ms,
      }),
    )

    return { ok: false, reason, detail, ms }
  }
}

/**
 * Turn a failure into something diagnosable without leaking a token or a client name.
 *
 * The scope case is named deliberately. `403 Invalid OAuth scope` is what the service
 * credential returns when it was consented without the reads this needs, and reporting it as
 * a generic upstream error would send someone hunting through logs for something the response
 * could have named.
 */
function describe(error: unknown): { reason: RefreshFailure; detail: string } {
  if (error instanceof ServiceCredentialUnavailable) {
    return {
      reason: 'service_credential',
      detail:
        'Zoho is not connected for reading, or its access has expired. Reconnect it.',
    }
  }
  if (error instanceof ZohoAuthError) {
    return {
      reason: 'service_credential',
      detail: 'Zoho rejected the connection. Reconnect it.',
    }
  }
  if (error instanceof ZohoRateLimitError) {
    return {
      reason: 'rate_limited',
      detail: 'Zoho rate limited the rebuild. It will try again shortly.',
    }
  }
  if (error instanceof ZohoHttpError) {
    const scopeProblem = error.status === 403 && /Invalid OAuth scope/i.test(error.body)
    return {
      reason: scopeProblem ? 'missing_scope' : 'zoho_error',
      detail: scopeProblem
        ? 'The Zoho connection lacks a read permission. Reconnect it to grant the missing one.'
        : `Zoho responded ${error.status}.`,
    }
  }
  return { reason: 'unknown', detail: 'The rebuild failed.' }
}
