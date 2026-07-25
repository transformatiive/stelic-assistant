import { createHash, randomUUID } from 'node:crypto'
import {
  CreditsExhaustedError,
  GatewayError,
  GatewayRateLimitError,
  NoCompliantEndpointError,
  UnusableExtractionError,
} from './errors'
import { TOOL_DEFINITIONS, parseToolCall, type Extraction } from './schema'
import type { ChatMessage } from './prompt'

/**
 * The OpenRouter extractor (task 4.1, design §4.1).
 *
 * Behind an `Extractor` interface so the gateway is swappable — the rest of the app depends
 * on "text in, validated tool call out", not on OpenRouter. That also makes every downstream
 * test able to use a stub instead of a network.
 */

export type Usage = {
  generationId?: string
  /** What we asked for, and what actually served the request — they differ under fallback. */
  modelRequested: string
  modelServed?: string
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
}

export type ExtractionResult = {
  extraction: Extraction
  usage: Usage
  requestId: string
}

export interface Extractor {
  extract(input: {
    systemPrompt: string
    messages: readonly ChatMessage[]
    /** Opaque, stable per user. Never the email — see `userAttribution`. */
    userKey: string
  }): Promise<ExtractionResult>
}

/**
 * A stable per-user handle for gateway-side attribution.
 *
 * Hashed because OpenRouter stores this field, and an email address is personal data that
 * has no business leaving the estate for the sake of a usage chart.
 */
export function userAttribution(userId: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${userId}`).digest('hex').slice(0, 32)
}

export type OpenRouterConfig = {
  apiKey: string
  model: string
  fallbackModels: readonly string[]
  siteUrl: string
  appTitle: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  requestIdFactory?: () => string
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const DEFAULT_TIMEOUT_MS = 45_000

/**
 * Endpoints that neither train on inputs nor retain them, and that honour `tools`.
 *
 * `require_parameters` matters more than it looks: without it OpenRouter may route to an
 * endpoint that ignores the `tools` field entirely, and the model answers in prose. That
 * would show up as a mysterious extraction failure rather than a routing problem.
 */
export const PROVIDER_POLICY = {
  data_collection: 'deny',
  zdr: true,
  require_parameters: true,
} as const

/** The subset of {@link OpenRouterConfig} that {@link callToolChoiceRequired} needs. */
export type GatewayCallConfig = {
  apiKey: string
  model: string
  siteUrl: string
  appTitle: string
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

/**
 * The retry and error-mapping shared by every caller that sends a tool-choice-required chat
 * completion to OpenRouter — the timesheet extractor below, and the lighter continuation
 * classifier in `lib/chat/continuation.ts` that reads a pending draft's free-text answers.
 *
 * One request id ties the header sent to the log line a failure produces, across the retry. A
 * 402 will still be a 402 in two seconds, and a schema failure will reproduce, so only 429/5xx
 * are retried, and only once.
 */
export async function callToolChoiceRequired(
  config: GatewayCallConfig,
  body: Record<string, unknown>,
  requestId: string,
): Promise<string> {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const fetchImpl = config.fetchImpl ?? fetch
  const sleep = config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  async function callOnce(): Promise<{ status: number; text: string }> {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          // Attribution on OpenRouter's dashboard; neither carries user data.
          'HTTP-Referer': config.siteUrl,
          'X-Title': config.appTitle,
          'X-Request-Id': requestId,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      })
      return { status: response.status, text: await response.text() }
    } finally {
      clearTimeout(timer)
    }
  }

  let attempt = await callOnce()

  // Retry once, and only for the failures a retry can actually fix. A 402 will still be
  // a 402 in two seconds, and a schema failure will reproduce.
  if (attempt.status === 429 || attempt.status >= 500) {
    await sleep(1000)
    attempt = await callOnce()
  }

  if (attempt.status === 402) throw new CreditsExhaustedError(requestId)
  if (attempt.status === 429) throw new GatewayRateLimitError(requestId)
  if (attempt.status === 404 && /no endpoints|no allowed providers/i.test(attempt.text)) {
    // The provider policy left nothing to route to. Fail closed rather than retrying
    // without `zdr` — the whole point of the flag is that it is not negotiable.
    throw new NoCompliantEndpointError(config.model, requestId)
  }
  if (attempt.status < 200 || attempt.status >= 300) {
    throw new GatewayError(attempt.status, requestId)
  }

  return attempt.text
}

export function createOpenRouterExtractor(config: OpenRouterConfig): Extractor {
  const newRequestId = config.requestIdFactory ?? randomUUID

  return {
    async extract({ systemPrompt, messages, userKey }) {
      const requestId = newRequestId()
      const body = {
        model: config.model,
        ...(config.fallbackModels.length ? { models: [...config.fallbackModels] } : {}),
        max_tokens: 1500,
        // Zero temperature: the same sentence must extract the same way every time. This is
        // a parser, not a writer.
        temperature: 0,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'required',
        provider: PROVIDER_POLICY,
        usage: { include: true },
        user: userKey,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.map((m) => ({ role: m.role, content: m.content })),
        ],
      }

      const text = await callToolChoiceRequired(config, body, requestId)
      return readCompletion(text, config.model, requestId)
    },
  }
}

/** Exported for the fixture tests, which exercise real recorded response bodies. */
export function readCompletion(
  text: string,
  modelRequested: string,
  requestId: string,
): ExtractionResult {
  let json: {
    id?: string
    model?: string
    error?: { message?: string; code?: number }
    choices?: {
      message?: {
        tool_calls?: { function?: { name?: string; arguments?: string } }[]
        content?: string
      }
    }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      cost?: number
    }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new UnusableExtractionError('response body was not JSON', requestId)
  }

  // OpenRouter reports some upstream failures as 200 with an error object.
  if (json.error) {
    if (json.error.code === 402) throw new CreditsExhaustedError(requestId)
    throw new GatewayError(json.error.code ?? 502, requestId)
  }

  const usage: Usage = {
    generationId: json.id,
    modelRequested,
    modelServed: json.model,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    costUsd: json.usage?.cost,
  }

  const call = json.choices?.[0]?.message?.tool_calls?.[0]?.function
  if (!call?.name) {
    // `tool_choice: "required"` should make this impossible, so it is worth logging loudly
    // when it happens — it means a provider is ignoring the field.
    throw new UnusableExtractionError('no tool call in the response', requestId)
  }

  const parsed = parseToolCall(call.name, call.arguments ?? '')
  if (parsed.status !== 'ok') {
    throw new UnusableExtractionError(parsed.reason, requestId)
  }

  return { extraction: parsed.extraction, usage, requestId }
}
