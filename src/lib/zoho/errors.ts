/** Which credential a Zoho call ran on. Reads use `service`, writes use `user` (§2). */
export type CredentialMode = 'service' | 'user'

export class ZohoError extends Error {
  readonly requestId: string
  constructor(message: string, requestId: string) {
    super(message)
    this.name = new.target.name
    this.requestId = requestId
  }
}

/** A non-2xx response that is not specifically auth or rate limiting. */
export class ZohoHttpError extends ZohoError {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string, requestId: string) {
    super(`Zoho responded ${status}`, requestId)
    this.status = status
    this.body = body
  }
}

/** 401 that survived one refresh-and-retry. The caller must re-authenticate. */
export class ZohoAuthError extends ZohoError {
  readonly mode: CredentialMode
  constructor(mode: CredentialMode, requestId: string) {
    super(`Zoho rejected the ${mode} credential after a refresh`, requestId)
    this.mode = mode
  }
}

/**
 * The quota is spent.
 *
 * Two ways to arrive here: a 429 that survived the retry budget, or a **400** carrying
 * `URL_ROLLING_THROTTLES_LIMIT_EXCEEDED`, which is how Zoho Projects actually reports it.
 * The second is not retryable in-request — the lockout runs to about a quarter of an hour,
 * and `retryAfterSeconds` says how long.
 */
export class ZohoRateLimitError extends ZohoError {
  readonly attempts: number
  readonly retryAfterSeconds?: number
  constructor(
    attempts: number,
    requestId: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(
      options.retryAfterSeconds
        ? `Zoho throttled the request; retry after ${options.retryAfterSeconds}s`
        : `Zoho rate limited the request after ${attempts} attempts`,
      requestId,
    )
    this.attempts = attempts
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}
