import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * One structured logger, one alert channel (tasks 9.1, 9.6).
 *
 * Before this there were two ad-hoc loggers and twenty-odd bare `console.info(JSON.stringify(…))`
 * calls. Each was individually careful, which is exactly the problem: carefulness that lives
 * at every call site is carefulness that a future call site will not have.
 *
 * Three guarantees, enforced here rather than remembered:
 *
 * 1. **A request id on every line**, carried in async context so a handler does not have to
 *    thread it through six function signatures to get it into a log.
 * 2. **No message content and no secret can be emitted**, because `redact` refuses the field
 *    names that would carry them and scrubs values that look like credentials. A log drain is
 *    a third party; what a user typed about a client is not its business.
 * 3. **One alert channel with one severity.** An operational fault is `level: "alert"` and
 *    nothing else is, so a drain can filter on a single predicate and a human can be woken by
 *    a single rule.
 */

export type Level = 'info' | 'warn' | 'error' | 'alert'

export type Fields = Record<string, unknown>

const store = new AsyncLocalStorage<{ requestId: string }>()

/**
 * Run a handler with a request id attached to everything it logs.
 *
 * Takes the caller's `x-request-id` when there is one — Railway and most proxies set it — so
 * a line here can be joined to a line in the platform's own log.
 */
export function withRequestId<T>(request: Request | string | null, fn: () => T): T {
  const fromHeader =
    typeof request === 'string' ? request : (request?.headers.get('x-request-id') ?? null)
  return store.run({ requestId: fromHeader ?? randomUUID() }, fn)
}

export function currentRequestId(): string | null {
  return store.getStore()?.requestId ?? null
}

/**
 * Field names that may never be logged.
 *
 * Deliberately blunt. A near-miss here costs a client's name or somebody's timesheet note in
 * a third-party sink, and the value of any of these in a log line is close to zero — every
 * one of them is either reproducible from an id or is the thing we are trying not to leak.
 */
const FORBIDDEN = new Set([
  'message',
  'content',
  'text',
  'reply',
  'prompt',
  'systemprompt',
  'description',
  'notes',
  'entries',
  'draft',
  'token',
  'accesstoken',
  'refreshtoken',
  'refresh_token',
  'access_token',
  'secret',
  'clientsecret',
  'client_secret',
  'password',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'code',
  'body',
])

/** Long unbroken strings that look like a credential rather than an identifier. */
const SECRET_SHAPED =
  /^(?:[A-Za-z0-9_-]{40,}|1000\.[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,})$/

/**
 * Strip anything that must not reach a log sink.
 *
 * A forbidden key is dropped entirely rather than masked: `"description": "[redacted]"` still
 * tells a reader an entry had a description, and more importantly it invites someone to
 * "temporarily" unmask it.
 */
export function redact(fields: Fields): Fields {
  const out: Fields = {}
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN.has(key.toLowerCase().replace(/[^a-z_]/g, ''))) continue
    if (typeof value === 'string' && SECRET_SHAPED.test(value)) {
      out[key] = '[secret-shaped]'
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Fields)
      continue
    }
    out[key] = value
  }
  return out
}

function emit(level: Level, event: string, fields: Fields): void {
  const line = JSON.stringify({
    level,
    event,
    requestId: currentRequestId(),
    ...redact(fields),
  })

  // `alert` goes to stderr with the rest of the failures: a drain that only forwards stderr
  // must not be the reason nobody hears about a spent balance.
  if (level === 'info') console.info(line)
  else if (level === 'warn') console.warn(line)
  else console.error(line)
}

export const log = {
  info: (event: string, fields: Fields = {}) => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}) => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}) => emit('error', event, fields),
}

/**
 * Faults that are ours, not the user's (task 9.6).
 *
 * The three the spec names: the portal-user lookup failing on scope, OpenRouter answering
 * `402`, and no ZDR-eligible endpoint for the configured model. What they share is that no
 * amount of retrying or rephrasing by a user will fix them, and that each one degrades the
 * app for *everyone* while looking like a mild hiccup to each individual person.
 *
 * One severity on purpose. A second one becomes the one nobody routes.
 */
export type AlertReason =
  | 'missing_scope'
  | 'credits_exhausted'
  | 'no_compliant_endpoint'
  | 'service_credential'
  | 'config'

export function alert(reason: AlertReason, fields: Fields = {}): void {
  emit('alert', 'operational.alert', { reason, ...fields })
}
