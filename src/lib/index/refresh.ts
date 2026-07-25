import type { PrismaClient } from '@/generated/prisma/client'
import { buildProjectIndex, type BuildResult } from './build'
import { saveProjectIndex } from './store'
import { serviceCrmClient, serviceProjectsClient } from '@/lib/zoho/factory'
import { ServiceCredentialUnavailable } from '@/lib/auth/token-sources'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'
import { alert, log } from '@/lib/observability/log'

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
          log.warn('index.tasks_unreadable', {
            projectId: project.id,
            status: error instanceof ZohoHttpError ? error.status : null,
          }),
        onThrottled: (error) =>
          // Not a failure: every project is still indexed and matchable, and the next
          // scheduled run fills in the charge codes it could not read.
          log.warn('index.throttled', {
            retryAfterSeconds: error.retryAfterSeconds ?? null,
          }),
      },
    )

    const saved = await saveProjectIndex(db, result.rows)
    const ms = Date.now() - startedAt

    log.info('index.rebuilt', {
      trigger: options.trigger,
      userId: options.userId ?? null,
      ...result.stats,
      ...saved,
      ms,
    })

    return { ok: true, stats: result.stats, ...saved, ms }
  } catch (error) {
    const { reason, detail } = describe(error)
    const ms = Date.now() - startedAt

    // A missing scope or a dead service credential is ours to fix and nobody else's, so it
    // goes to the alert channel rather than being one more warning in a stream (task 9.6).
    const fields = {
      trigger: options.trigger,
      userId: options.userId ?? null,
      reason,
      error: error instanceof Error ? error.name : 'unknown',
      ms,
    }
    if (reason === 'missing_scope') alert('missing_scope', fields)
    else if (reason === 'service_credential') alert('service_credential', fields)
    else log.error('index.rebuild_failed', fields)

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
