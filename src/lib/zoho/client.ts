import { randomUUID } from 'node:crypto'
import { backoffDelayMs, retryAfterMs } from './backoff'
import {
  ZohoAuthError,
  ZohoHttpError,
  ZohoRateLimitError,
  type CredentialMode,
} from './errors'

/**
 * Typed Zoho HTTP client with two credential modes (task 1.5).
 *
 * Reads run on the service credential, writes on the signed-in user's own token
 * (design.md §2). The mode is a property of the injected `TokenSource`, so a caller cannot
 * accidentally write on the service credential — it has to be handed a user token source.
 */

export interface TokenSource {
  readonly mode: CredentialMode
  /** A usable access token, refreshing transparently if the cached one has expired. */
  getAccessToken(): Promise<string>
  /** Force a refresh. Called once after a 401. */
  refreshAccessToken(): Promise<string>
}

export interface ZohoLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
}

const silentLogger: ZohoLogger = { info: () => {}, warn: () => {} }

export interface ZohoClientOptions {
  /** Absolute base, e.g. `https://projectsapi.zoho.com/restapi/portal/911636649/`. */
  baseUrl: string
  tokens: TokenSource
  logger?: ZohoLogger
  /** Retries for 429 only. A write is never retried on 5xx — that is the commit pipeline's job. */
  maxRateLimitRetries?: number
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  random?: () => number
  now?: () => number
  requestIdFactory?: () => string
}

export interface ZohoRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Query parameters. Undefined and null values are dropped. */
  query?: Record<string, string | number | boolean | undefined | null>
  /** Sent as `application/x-www-form-urlencoded`, which is what the Projects API expects. */
  form?: Record<string, string | number | boolean | undefined | null>
  /** Overrides the client-level request id, so a retry chain can share one. */
  requestId?: string
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ZohoClient {
  private readonly baseUrl: string
  private readonly tokens: TokenSource
  private readonly logger: ZohoLogger
  private readonly maxRateLimitRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly now: () => number
  private readonly requestIdFactory: () => string

  constructor(options: ZohoClientOptions) {
    // A trailing slash matters: `new URL('projects/', base)` drops the last path segment
    // without one, silently addressing the wrong portal.
    this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
    this.tokens = options.tokens
    this.logger = options.logger ?? silentLogger
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 3
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sleep = options.sleep ?? defaultSleep
    this.random = options.random ?? Math.random
    this.now = options.now ?? Date.now
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  get mode(): CredentialMode {
    return this.tokens.mode
  }

  async requestJson<T>(path: string, options: ZohoRequestOptions = {}): Promise<T> {
    const text = await this.requestText(path, options)
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  async requestText(path: string, options: ZohoRequestOptions = {}): Promise<string> {
    const requestId = options.requestId ?? this.requestIdFactory()
    const method = options.method ?? 'GET'
    const url = this.buildUrl(path, options.query)

    let token = await this.tokens.getAccessToken()
    let refreshed = false
    let rateLimitAttempts = 0

    for (;;) {
      const response = await this.fetchImpl(url, {
        method,
        headers: this.buildHeaders(token, requestId, options.form !== undefined),
        body: options.form === undefined ? undefined : encodeForm(options.form),
        cache: 'no-store',
      })

      if (response.status === 401) {
        if (refreshed) {
          this.logger.warn('zoho.auth_failed', { requestId, method, mode: this.mode })
          throw new ZohoAuthError(this.mode, requestId)
        }
        // Exactly one silent refresh-and-retry (design.md §8).
        this.logger.info('zoho.token_refresh', { requestId, mode: this.mode })
        token = await this.tokens.refreshAccessToken()
        refreshed = true
        continue
      }

      if (response.status === 429) {
        if (rateLimitAttempts >= this.maxRateLimitRetries) {
          this.logger.warn('zoho.rate_limited', {
            requestId,
            method,
            attempts: rateLimitAttempts,
          })
          throw new ZohoRateLimitError(rateLimitAttempts, requestId)
        }
        const advised = retryAfterMs(response.headers.get('retry-after'), this.now())
        const delay = advised ?? backoffDelayMs(rateLimitAttempts, this.random)
        rateLimitAttempts += 1
        this.logger.info('zoho.backoff', { requestId, attempt: rateLimitAttempts, delay })
        await this.sleep(delay)
        continue
      }

      const body = await response.text()

      if (!response.ok) {
        // Body is logged, not shown: errors reach the user as sentences (project.md).
        this.logger.warn('zoho.http_error', {
          requestId,
          method,
          status: response.status,
          mode: this.mode,
        })
        throw new ZohoHttpError(response.status, body, requestId)
      }

      this.logger.info('zoho.ok', {
        requestId,
        method,
        status: response.status,
        mode: this.mode,
      })
      return body
    }
  }

  private buildUrl(path: string, query: ZohoRequestOptions['query']): string {
    const url = new URL(path.replace(/^\//, ''), this.baseUrl)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private buildHeaders(token: string, requestId: string, hasForm: boolean): HeadersInit {
    const headers: Record<string, string> = {
      Authorization: `Zoho-oauthtoken ${token}`,
      Accept: 'application/json',
      'X-Request-Id': requestId,
    }
    if (hasForm) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    return headers
  }
}

function encodeForm(
  form: Record<string, string | number | boolean | undefined | null>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(form)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  return params.toString()
}
