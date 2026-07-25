import { randomUUID } from 'node:crypto'
import { UnusableExtractionError } from '@/lib/extract/errors'
import {
  PROVIDER_POLICY,
  callToolChoiceRequired,
  type GatewayCallConfig,
  type Usage,
} from '@/lib/extract/openrouter'
import type { ChatMessage } from '@/lib/extract/prompt'
import type { DraftEntry, ResolveContext } from '@/lib/resolve/entry'
import { todayFor } from '@/lib/resolve/entry'
import {
  AGENT_TOOLS,
  buildEntries,
  listChargeCodes,
  searchProjects,
  type ProposedEntry,
} from './agent-tools'

/**
 * The conversation, run by the model (CHAT-7).
 *
 * This replaces the slot machine that used to own the conversation — a fixed
 * project → task → date → hours → description walk that could only ask one sentence per slot
 * and could only accept an answer shaped like that slot. Every live failure it produced was
 * the same one: an answer that did not fit the slot it was on was discarded, and the identical
 * question came back. Adding parsers to it only moved where the next person fell off.
 *
 * So the model drives, with tools, and the deterministic parts became the things that must
 * not be guessed rather than the thing in charge:
 *
 * - **ids come from the index**, never from the model — `search_projects` hands back real
 *   project ids and `propose_entries` refuses one it did not issue
 * - **dates, hours and descriptions are resolved here**, from the user's own words, by the
 *   same resolvers as before, in the user's timezone
 * - **nothing reaches Zoho without a confirmation tap** — the model's most powerful move is
 *   putting a card on the screen (CHAT-8)
 *
 * A proposal that fails validation is returned *to the model* as problems, so it asks about
 * them in its own words instead of the app rendering a dead end.
 */

export type AgentOutcome =
  | { kind: 'ask'; message: string; options: string[] }
  | { kind: 'propose'; message: string; entries: DraftEntry[] }
  | {
      kind: 'say'
      message: string
      intent: 'smalltalk' | 'week_summary' | 'undo' | 'refusal'
    }

export type AgentResult = { outcome: AgentOutcome; usage: Usage }

export interface Agent {
  run(input: {
    systemPrompt: string
    messages: readonly ChatMessage[]
    userKey: string
    context: ResolveContext
  }): Promise<AgentResult>
}

/** Lookups per turn before the loop stops. Far past any honest conversation. */
export const MAX_STEPS = 8

export type AgentPromptContext = {
  displayName?: string | null
  today: string
  timezone: string
  defaultBillable: boolean
}

export function buildAgentPrompt(context: AgentPromptContext): string {
  const who = context.displayName?.trim()
  return [
    'You record timesheets for Stelic staff in Zoho Projects, by chatting. You are brief,',
    'warm and concrete.',
    '',
    `Today is ${context.today} in the user's timezone (${context.timezone}).`,
    who ? `You are talking to ${who}.` : '',
    '',
    'HOW TO WORK',
    '- Read the whole conversation. Never ask again for something already said, in any',
    '  wording, however long ago.',
    '- Search for the project before proposing anything; ids only come from search_projects.',
    '- One message can hold several entries — different projects, different days, or both.',
    '  Propose them together.',
    '- Ask only about what is genuinely missing or genuinely ambiguous, one thing at a time,',
    '  and offer tappable options whenever there is a finite set.',
    '- When a search returns one convincing hit, use it. Do not ask which project when only',
    '  one plausibly matches what they said.',
    '- If a project has exactly one charge code, use it without asking. If several, ask —',
    '  and accept a task they name that is not on the list; it gets created on confirm.',
    '- Never invent hours, a date or a description. If they did not say, ask.',
    `- Unstated entries are ${context.defaultBillable ? 'billable' : 'non-billable'} by default, so do not ask about that.`,
    '',
    'WHAT YOU DO NOT DO',
    '- You only record timesheets. Anything else — rates, budgets, invoices, approvals,',
    '  admin, or any request unrelated to logging time — gets a brief, friendly decline via',
    '  say(intent: "refusal") saying you are only set up to record timesheets. Do not',
    '  attempt it, and do not speculate about it.',
    '- You cannot write to Zoho yourself. propose_entries puts a card on screen; the user',
    '  confirming it is what records the time.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

type ToolCall = { id?: string; function?: { name?: string; arguments?: string } }

export type AgentConfig = GatewayCallConfig & {
  fallbackModels?: readonly string[]
  requestIdFactory?: () => string
}

export function createOpenRouterAgent(config: AgentConfig): Agent {
  const newRequestId = config.requestIdFactory ?? randomUUID

  return {
    async run({ systemPrompt, messages, userKey, context }) {
      const requestId = newRequestId()
      const history: unknown[] = [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ]

      const usage: Usage = { modelRequested: config.model }
      let prompt = 0
      let completion = 0
      let cost = 0

      for (let step = 0; step < MAX_STEPS; step += 1) {
        const text = await callToolChoiceRequired(
          config,
          {
            model: config.model,
            ...(config.fallbackModels?.length
              ? { models: [...config.fallbackModels] }
              : {}),
            max_tokens: 2000,
            temperature: 0,
            tools: AGENT_TOOLS,
            tool_choice: 'required',
            provider: PROVIDER_POLICY,
            usage: { include: true },
            user: userKey,
            messages: history,
          },
          requestId,
        )

        const parsed = readStep(text, requestId)
        prompt += parsed.usage.prompt ?? 0
        completion += parsed.usage.completion ?? 0
        cost += parsed.usage.cost ?? 0
        usage.generationId ??= parsed.usage.generationId
        usage.modelServed = parsed.usage.modelServed ?? usage.modelServed

        const settle = (outcome: AgentOutcome): AgentResult => ({
          outcome,
          usage: {
            ...usage,
            promptTokens: prompt,
            completionTokens: completion,
            costUsd: Number(cost.toFixed(6)),
          },
        })

        const { name, args, call } = parsed

        if (name === 'ask_user') {
          const question = str(args.question)
          if (!question)
            throw new UnusableExtractionError('ask_user with no question', requestId)
          return settle({
            kind: 'ask',
            message: question,
            options: Array.isArray(args.options)
              ? args.options.filter((o): o is string => typeof o === 'string').slice(0, 6)
              : [],
          })
        }

        if (name === 'say') {
          const message = str(args.message)
          if (!message)
            throw new UnusableExtractionError('say with no message', requestId)
          const intent = str(args.intent)
          return settle({
            kind: 'say',
            message,
            intent:
              intent === 'week_summary' || intent === 'undo' || intent === 'refusal'
                ? intent
                : 'smalltalk',
          })
        }

        if (name === 'propose_entries') {
          const built = buildEntries(
            Array.isArray(args.entries) ? (args.entries as ProposedEntry[]) : [],
            context,
          )
          if (built.ok) {
            return settle({
              kind: 'propose',
              message: str(args.reply) ?? 'Here’s what I have.',
              entries: built.entries,
            })
          }
          // Not a dead end and not a card full of blocked lines: the model is told what is
          // wrong and asks the user about it.
          history.push(
            assistantTurn(call),
            toolResult(call, { ok: false, problems: built.problems }),
          )
          continue
        }

        if (name === 'search_projects') {
          const hits = searchProjects(str(args.query) ?? '', context)
          history.push(
            assistantTurn(call),
            toolResult(call, {
              projects: hits,
              ...(hits.length === 0
                ? { note: 'Nothing matched. Try different wording, or ask the user.' }
                : {}),
            }),
          )
          continue
        }

        if (name === 'list_charge_codes') {
          const codes = listChargeCodes(str(args.project_id) ?? '', context)
          history.push(
            assistantTurn(call),
            toolResult(call, {
              charge_codes: codes,
              ...(codes.length === 0
                ? {
                    note: 'This project has none yet. Ask what they worked on and send it as new_task_name.',
                  }
                : {}),
            }),
          )
          continue
        }

        throw new UnusableExtractionError(`unknown tool ${name}`, requestId)
      }

      // Out of steps: the model is circling rather than answering. Better to say so than to
      // return whatever half-finished thing it last produced.
      throw new UnusableExtractionError(
        'the agent did not settle on an answer',
        requestId,
      )
    },
  }
}

function assistantTurn(call: ToolCall) {
  return { role: 'assistant', content: null, tool_calls: [call] }
}

function toolResult(call: ToolCall, payload: unknown) {
  return {
    role: 'tool',
    tool_call_id: call.id ?? 'call_1',
    name: call.function?.name ?? '',
    content: JSON.stringify(payload),
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** One model step: which tool it called, with what, and what the call cost. */
export function readStep(text: string, requestId: string) {
  let json: {
    id?: string
    model?: string
    error?: { message?: string; code?: number }
    choices?: { message?: { tool_calls?: ToolCall[] } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  }
  try {
    json = JSON.parse(text)
  } catch {
    throw new UnusableExtractionError('response body was not JSON', requestId)
  }
  if (json.error)
    throw new UnusableExtractionError(json.error.message ?? 'gateway error', requestId)

  const call = json.choices?.[0]?.message?.tool_calls?.[0]
  const name = call?.function?.name
  if (!name) throw new UnusableExtractionError('no tool call in the response', requestId)

  let args: Record<string, unknown> = {}
  if (call?.function?.arguments) {
    try {
      const parsed: unknown = JSON.parse(call.function.arguments)
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
    } catch {
      throw new UnusableExtractionError(
        `${name} arguments were not valid JSON`,
        requestId,
      )
    }
  }

  return {
    name,
    args,
    call: call!,
    usage: {
      generationId: json.id,
      modelServed: json.model,
      prompt: json.usage?.prompt_tokens,
      completion: json.usage?.completion_tokens,
      cost: json.usage?.cost,
    },
  }
}

export { todayFor }
