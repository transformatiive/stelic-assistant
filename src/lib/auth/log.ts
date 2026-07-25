import { alert, log } from '@/lib/observability/log'

/**
 * Structured auth logging.
 *
 * Two levels, one distinction: events that mean *we* are misconfigured raise an operational
 * alert (AUTH-3, *Portal user lookup is unavailable* — "an operational alert is raised — this
 * is a configuration fault, not a user fault"). Everything else is `info`.
 *
 * A token, a client secret or an authorization code must never be passed in here — and now
 * cannot be, because `log` drops those field names. Emails are allowed: AUTH-3 requires the
 * rejected email in the log so a PM can be told who to add.
 */

const OPERATIONAL_EVENTS: ReadonlySet<string> = new Set([
  'auth.identity_unreadable',
  'auth.identity_error',
  'auth.profile_unreadable',
  'auth.no_refresh_token',
])

export function logAuthEvent(event: string, fields: Record<string, unknown>): void {
  if (OPERATIONAL_EVENTS.has(event)) {
    alert('missing_scope', { event, ...fields })
    return
  }
  log.info(event, fields)
}
