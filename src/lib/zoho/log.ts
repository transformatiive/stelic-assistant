import type { ZohoLogger } from './client'

/**
 * Structured logging for Zoho traffic.
 *
 * A request id, a method and a status — never a token, never a response body. Bodies can
 * carry client names and time-log notes, and neither belongs in a log line.
 */
export const logZohoEvent: ZohoLogger = {
  info(event, fields) {
    console.info(JSON.stringify({ event, ...fields }))
  },
  warn(event, fields) {
    console.warn(JSON.stringify({ event, ...fields }))
  },
}
