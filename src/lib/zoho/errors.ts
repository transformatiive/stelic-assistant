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

/** 429 that survived the retry budget. */
export class ZohoRateLimitError extends ZohoError {
  readonly attempts: number
  constructor(attempts: number, requestId: string) {
    super(`Zoho rate limited the request after ${attempts} attempts`, requestId)
    this.attempts = attempts
  }
}
