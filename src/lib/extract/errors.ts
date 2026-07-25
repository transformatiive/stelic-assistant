/**
 * Why an extraction failed (task 4.1).
 *
 * These are distinguished because the *responses* differ. A rate limit is worth retrying. An
 * exhausted balance is not — it needs a human to top up an account, and it must page
 * operations rather than quietly degrade every user until someone notices the bot has been
 * useless for a day (design §5). A model that returned nothing usable is neither: it is a
 * one-turn failure the user should barely feel, because the guided form takes over.
 */

export class ExtractionError extends Error {
  readonly requestId: string
  constructor(message: string, requestId: string) {
    super(message)
    this.name = new.target.name
    this.requestId = requestId
  }
}

/** 402 — the OpenRouter balance is spent. Operational alert, not a user-facing hiccup. */
export class CreditsExhaustedError extends ExtractionError {
  constructor(requestId: string) {
    super('OpenRouter reports the account is out of credit', requestId)
  }
}

/** 429 — survived the retry budget. */
export class GatewayRateLimitError extends ExtractionError {
  constructor(requestId: string) {
    super('OpenRouter rate limited the request', requestId)
  }
}

/** Any other non-2xx from the gateway, or an unreadable body. */
export class GatewayError extends ExtractionError {
  readonly status: number
  constructor(status: number, requestId: string) {
    super(`OpenRouter responded ${status}`, requestId)
    this.status = status
  }
}

/**
 * The call succeeded but the answer is unusable — no tool call, an unknown tool, or arguments
 * that fail the schema. Distinct from a gateway failure: nothing is wrong with the
 * infrastructure, so retrying the same prompt would likely fail the same way.
 */
export class UnusableExtractionError extends ExtractionError {
  readonly reason: string
  constructor(reason: string, requestId: string) {
    super(`The model did not return a usable tool call: ${reason}`, requestId)
    this.reason = reason
  }
}

/** No ZDR endpoint for the configured model. Fail closed — do not quietly drop the flag. */
export class NoCompliantEndpointError extends ExtractionError {
  constructor(model: string, requestId: string) {
    super(
      `No endpoint for ${model} satisfies the required provider policy (zdr, data_collection: deny)`,
      requestId,
    )
  }
}
