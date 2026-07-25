import type { ZohoLogger } from './client'
import { log } from '@/lib/observability/log'

/**
 * Structured logging for Zoho traffic.
 *
 * A request id, a method and a status — never a token, never a response body. Bodies can
 * carry client names and time-log notes, and neither belongs in a log line. That is no longer
 * a convention held at each call site: `log` drops those field names itself (task 9.1).
 */
export const logZohoEvent: ZohoLogger = {
  info(event, fields) {
    log.info(event, fields)
  },
  warn(event, fields) {
    log.warn(event, fields)
  },
}
