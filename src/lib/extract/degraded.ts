import {
  CreditsExhaustedError,
  ExtractionError,
  GatewayError,
  GatewayRateLimitError,
  NoCompliantEndpointError,
  UnusableExtractionError,
} from './errors'
import { alert, log } from '@/lib/observability/log'

/**
 * What to do when extraction fails (task 4.5, CHAT-13).
 *
 * The bot must never be *down*. When the model cannot be reached or cannot be trusted, the
 * app falls back to a guided slot-by-slot form: the same fields, asked one at a time, with no
 * model in the loop. Slower to use, but it still logs the time — which is the whole job.
 *
 * The classification here does two separate things, and conflating them is the mistake worth
 * avoiding: it decides **what the user sees** and, independently, **whether a human is
 * paged**. An exhausted balance looks like a mild hiccup to each individual user while
 * quietly making the bot useless for everyone, so it must alert even though its user-facing
 * message is gentle.
 */

export type DegradedOutcome = {
  /** Shown to the user. Never mentions a provider, a model, a status code or a token. */
  message: string
  /** Whether to drop into the guided form for this turn. */
  useGuidedForm: boolean
  /** Whether a human needs to know now. */
  alert: boolean
  /** Short slug for the log line and any alert. */
  reason:
    | 'credits_exhausted'
    | 'rate_limited'
    | 'no_compliant_endpoint'
    | 'gateway_error'
    | 'unusable_extraction'
    | 'unknown'
}

const GUIDED_SUFFIX = "Let's do it the short way instead."

export function classifyExtractionFailure(error: unknown): DegradedOutcome {
  if (error instanceof CreditsExhaustedError) {
    // Gentle for the user, loud for us. Without the alert this degrades every conversation
    // silently until somebody happens to notice.
    return {
      message: `I can't read that properly right now. ${GUIDED_SUFFIX}`,
      useGuidedForm: true,
      alert: true,
      reason: 'credits_exhausted',
    }
  }

  if (error instanceof NoCompliantEndpointError) {
    // A configuration fault: the model has no endpoint meeting the data policy. Nobody can
    // fix this from a browser, and we will not quietly drop the policy to route around it.
    return {
      message: `I can't read that properly right now. ${GUIDED_SUFFIX}`,
      useGuidedForm: true,
      alert: true,
      reason: 'no_compliant_endpoint',
    }
  }

  if (error instanceof GatewayRateLimitError) {
    return {
      message: `Things are busy at the moment. ${GUIDED_SUFFIX}`,
      useGuidedForm: true,
      alert: false,
      reason: 'rate_limited',
    }
  }

  if (error instanceof UnusableExtractionError) {
    // One turn went wrong. The user should barely feel it.
    return {
      message: `I didn't quite follow that. ${GUIDED_SUFFIX}`,
      useGuidedForm: true,
      alert: false,
      reason: 'unusable_extraction',
    }
  }

  if (error instanceof GatewayError) {
    return {
      message: `I can't read that properly right now. ${GUIDED_SUFFIX}`,
      useGuidedForm: true,
      // A single upstream blip is noise; sustained 5xx shows up as a rate of these in the log.
      alert: false,
      reason: 'gateway_error',
    }
  }

  return {
    message: `Something went wrong on my side. ${GUIDED_SUFFIX}`,
    useGuidedForm: true,
    alert: true,
    reason: 'unknown',
  }
}

/** Structured log for a failed extraction. Carries no prompt text and no user message. */
export function logExtractionFailure(error: unknown, outcome: DegradedOutcome): void {
  const fields = {
    reason: outcome.reason,
    gatewayRequestId: error instanceof ExtractionError ? error.requestId : null,
    detail: error instanceof UnusableExtractionError ? error.reason : null,
  }

  // The two that mean the bot is quietly useless for everyone go to the one alert channel
  // (task 9.6); a busy gateway is just a bad minute and stays a warning.
  if (outcome.alert) {
    alert(
      outcome.reason === 'credits_exhausted'
        ? 'credits_exhausted'
        : outcome.reason === 'no_compliant_endpoint'
          ? 'no_compliant_endpoint'
          : 'config',
      fields,
    )
    return
  }
  log.warn('extract.failed', fields)
}
