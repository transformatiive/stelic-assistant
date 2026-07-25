import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  CreditsExhaustedError,
  GatewayError,
  UnusableExtractionError,
} from '@/lib/extract/errors'
import {
  PROVIDER_POLICY,
  callToolChoiceRequired,
  type GatewayCallConfig,
  type Usage,
} from '@/lib/extract/openrouter'
import type { ChatMessage } from '@/lib/extract/prompt'
import type { DraftEntry, SlotName } from '@/lib/resolve/entry'
import { questionText } from './ui'

/**
 * Deciding what a reply means when a draft is already waiting on an answer (CHAT-7).
 *
 * A chip tap is unambiguous — the value is a server-issued id, applied without a model round
 * trip. Typed text is not: "oh i meant Turner" or "actually 6 hours" answers the draft, but
 * "actually 6 hours" could just as easily be a correction to an entry that was already
 * resolved, not the one currently being asked about. Deciding *which* entry and slot a typed
 * reply means is exactly the kind of short, careful reading a small model is good at — so this
 * runs on a cheaper, faster model than the sentence-level extraction in `lib/extract/`, which
 * has the harder job of splitting a whole freeform message into one or more entries.
 *
 * The boundary that makes this safe is unchanged from the rest of the app: the classifier
 * returns the user's own words for a slot, never a resolved project id or calendar date. Those
 * still come from the exact same deterministic matcher (`applyAnswer` in `lib/resolve/draft.ts`)
 * that a chip tap goes through — a wrong classification produces a wrong follow-up question at
 * worst, never a wrong Zoho entry.
 */

export type ContinuationUpdate = { entryId: string; slot: SlotName; value: string }

export type ContinuationDecision =
  { intent: 'answer'; updates: ContinuationUpdate[] } | { intent: 'new_message' }

export interface ContinuationClassifier {
  classify(input: {
    systemPrompt: string
    messages: readonly ChatMessage[]
    userKey: string
  }): Promise<{ decision: ContinuationDecision; usage: Usage }>
}

const updateSchema = z.object({
  entryId: z.string().trim().min(1),
  slot: z.enum(['project', 'task', 'date', 'hours', 'description']),
  // The user's own phrase, not a resolved value — re-validated by `applyAnswer`, same as a
  // chip's value would be, so a malformed or hallucinated update can only ever fail to
  // resolve, never silently become a wrong project or date.
  value: z.string().trim().min(1),
})

const decisionSchema = z
  .object({
    intent: z.enum(['answer', 'new_message']),
    updates: z.array(updateSchema).nullable(),
  })
  .refine((v) => v.intent === 'new_message' || (v.updates?.length ?? 0) > 0, {
    message: '"answer" requires at least one update',
  })

export const CONTINUATION_TOOL = {
  type: 'function' as const,
  function: {
    name: 'classify_continuation',
    description:
      'Decide whether the newest message answers or corrects the timesheet draft already in ' +
      'progress, or is unrelated to it.',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: ['answer', 'new_message'],
          description:
            '"answer" if the message answers the question just asked, or corrects a value ' +
            'already given anywhere in the draft below (right project but wrong date, right ' +
            'day but wrong hours, and so on). "new_message" if it is unrelated to this draft — ' +
            'a fresh topic, a new time entry, a question, or small talk.',
        },
        updates: {
          type: ['array', 'null'],
          description:
            'Required and non-empty when intent is "answer"; null when intent is ' +
            '"new_message". One entry per value being set or corrected.',
          items: {
            type: 'object',
            properties: {
              entryId: {
                type: 'string',
                description:
                  'The id of the entry this applies to, copied from the draft below.',
              },
              slot: {
                type: 'string',
                enum: ['project', 'task', 'date', 'hours', 'description'],
                description: 'Which field is being set or corrected.',
              },
              value: {
                type: 'string',
                description:
                  'The user\'s own words for the new value, copied verbatim — e.g. "Turner", ' +
                  '"yesterday", "6 hours" — never a resolved id, a calendar date, or a computed ' +
                  'number.',
              },
            },
            required: ['entryId', 'slot', 'value'],
            additionalProperties: false,
          },
        },
      },
      required: ['intent', 'updates'],
      additionalProperties: false,
    },
  },
}

export type ContinuationPromptContext = {
  displayName?: string | null
  today: string
  timezone: string
  entries: readonly DraftEntry[]
  pending: { entryId: string; slot: SlotName }
}

/**
 * The pending draft, rendered as short lines a small model can read carefully — every entry,
 * not just the one being asked about, so a correction to something already resolved ("actually
 * the Tuesday one was 6 hours") has something to match against.
 */
export function buildContinuationSystemPrompt(
  context: ContinuationPromptContext,
): string {
  const who = context.displayName?.trim()
  const pendingEntry = context.entries.find(
    (entry) => entry.id === context.pending.entryId,
  )
  const pendingQuestion = pendingEntry
    ? questionText(pendingEntry, context.pending.slot)
    : 'Which one did you mean?'

  return [
    'You are reading one new chat message in the middle of an in-progress timesheet draft.',
    '',
    `Today is ${context.today} in the user's timezone (${context.timezone}).`,
    who ? `You are talking to ${who}.` : '',
    '',
    'The draft so far:',
    ...context.entries.map(summariseEntry),
    '',
    `You just asked: "${pendingQuestion}"`,
    '',
    'Decide whether the new message answers that question, corrects a value already in the',
    'draft above, or is unrelated to it entirely.',
    '',
    "Copy the user's own words into `value` — never invent a project name, resolve a date, or",
    'compute an hours total yourself. That happens afterwards, deterministically.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

function summariseEntry(entry: DraftEntry): string {
  const project =
    entry.project.status === 'resolved'
      ? entry.project.projectName
      : `unresolved (said "${entry.said.project}")`
  const task = entry.task.status === 'resolved' ? entry.task.taskName : 'unresolved'
  const date =
    entry.date.status === 'unresolved'
      ? entry.said.date
        ? `unresolved (said "${entry.said.date}")`
        : 'unresolved'
      : entry.date.date
  const hours = entry.hours.status === 'resolved' ? `${entry.hours.hours}h` : 'unresolved'
  const description =
    entry.description.status === 'resolved' ? entry.description.description : 'unresolved'
  return `- ${entry.id}: project=${project}; task=${task}; date=${date}; hours=${hours}; description=${JSON.stringify(description)}`
}

export type ContinuationConfig = GatewayCallConfig & {
  fallbackModels?: readonly string[]
  requestIdFactory?: () => string
}

export function createOpenRouterContinuationClassifier(
  config: ContinuationConfig,
): ContinuationClassifier {
  const newRequestId = config.requestIdFactory ?? randomUUID

  return {
    async classify({ systemPrompt, messages, userKey }) {
      const requestId = newRequestId()
      const body = {
        model: config.model,
        ...(config.fallbackModels?.length ? { models: [...config.fallbackModels] } : {}),
        // Short by design: a decision and at most a few short updates, not prose.
        max_tokens: 500,
        temperature: 0,
        tools: [CONTINUATION_TOOL],
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
      return readContinuationCompletion(text, config.model, requestId)
    },
  }
}

/**
 * Exported for fixture-style tests, same shape as `readCompletion` in `lib/extract/openrouter`
 * — the JSON-parsing and usage-extraction steps are near-identical there because they read the
 * same gateway response envelope; only the final tool-call schema differs.
 */
export function readContinuationCompletion(
  text: string,
  modelRequested: string,
  requestId: string,
): { decision: ContinuationDecision; usage: Usage } {
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
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new UnusableExtractionError('response body was not JSON', requestId)
  }

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
    throw new UnusableExtractionError('no tool call in the response', requestId)
  }
  if (call.name !== 'classify_continuation') {
    throw new UnusableExtractionError(`unknown tool ${call.name}`, requestId)
  }

  let args: unknown
  try {
    args = JSON.parse(call.arguments ?? '')
  } catch {
    throw new UnusableExtractionError('arguments were not valid JSON', requestId)
  }

  const parsed = decisionSchema.safeParse(args)
  if (!parsed.success) {
    throw new UnusableExtractionError(describeIssues(parsed.error), requestId)
  }

  const decision: ContinuationDecision =
    parsed.data.intent === 'answer'
      ? { intent: 'answer', updates: parsed.data.updates! }
      : { intent: 'new_message' }

  return { decision, usage }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}
