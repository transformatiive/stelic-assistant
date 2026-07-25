import { describe, expect, it, vi } from 'vitest'
import {
  CreditsExhaustedError,
  GatewayRateLimitError,
  UnusableExtractionError,
} from '@/lib/extract/errors'
import {
  CONTINUATION_TOOL,
  buildContinuationSystemPrompt,
  createOpenRouterContinuationClassifier,
  readContinuationCompletion,
} from '@/lib/chat/continuation'
import type { DraftEntry } from '@/lib/resolve/entry'
import { completion } from './support/openrouter-fixtures'

const REQ = 'req-1'

const CONFIG = {
  apiKey: 'sk-or-v1-test',
  model: 'anthropic/claude-haiku-4.5',
  siteUrl: 'https://stelic-assistant-production.up.railway.app',
  appTitle: 'Stelic Assistant',
  sleep: async () => {},
  requestIdFactory: () => REQ,
}

function gateway(...responses: { status?: number; body: string }[]) {
  let call = 0
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const r = responses[Math.min(call++, responses.length - 1)]!
    return new Response(r.body, { status: r.status ?? 200 })
  })
  return {
    fetchImpl,
    classifier: createOpenRouterContinuationClassifier({ ...CONFIG, fetchImpl }),
  }
}

const INPUT = {
  systemPrompt: 'You are reading one new chat message...',
  messages: [{ role: 'user' as const, content: 'oh i meant Turner, not Clayco' }],
  userKey: 'abc123',
}

function entry(overrides: Partial<DraftEntry> = {}): DraftEntry {
  return {
    id: 'e1',
    said: { project: 'clayco', date: 'yesterday' },
    project: {
      status: 'resolved',
      projectId: 'p-clayco',
      projectName: 'Clayco EKI Data Center',
      why: 'matched the project name',
    },
    task: { status: 'resolved', taskId: 't1', taskName: 'Engineering', why: 'only task' },
    date: { status: 'resolved', date: '2026-07-24' },
    hours: { status: 'resolved', hours: 8 },
    description: { status: 'resolved', description: 'schedule updates' },
    billable: true,
    ...overrides,
  }
}

describe('reading a completion into a decision', () => {
  it('reads an answer with one update', () => {
    const body = completion('classify_continuation', {
      intent: 'answer',
      updates: [{ entryId: 'e1', slot: 'project', value: 'Turner' }],
    })
    const { decision } = readContinuationCompletion(body, CONFIG.model, REQ)
    expect(decision).toEqual({
      intent: 'answer',
      updates: [{ entryId: 'e1', slot: 'project', value: 'Turner' }],
    })
  })

  it('reads several updates at once — a correction can touch more than one slot', () => {
    const body = completion('classify_continuation', {
      intent: 'answer',
      updates: [
        { entryId: 'e1', slot: 'hours', value: '6' },
        { entryId: 'e1', slot: 'date', value: 'Tuesday' },
      ],
    })
    const { decision } = readContinuationCompletion(body, CONFIG.model, REQ)
    if (decision.intent !== 'answer') throw new Error('expected answer')
    expect(decision.updates).toHaveLength(2)
  })

  it('reads a new_message decision with no updates', () => {
    const body = completion('classify_continuation', {
      intent: 'new_message',
      updates: null,
    })
    const { decision } = readContinuationCompletion(body, CONFIG.model, REQ)
    expect(decision).toEqual({ intent: 'new_message' })
  })

  it('captures usage the same way the timesheet extractor does', () => {
    const body = completion('classify_continuation', {
      intent: 'new_message',
      updates: null,
    })
    const { usage } = readContinuationCompletion(body, CONFIG.model, REQ)
    expect(usage).toEqual({
      generationId: 'gen-01JABCDEF',
      modelRequested: CONFIG.model,
      modelServed: 'anthropic/claude-sonnet-5',
      promptTokens: 812,
      completionTokens: 96,
      costUsd: 0.00214,
    })
  })

  it('rejects "answer" with no updates — the schema, not just the description, forbids it', () => {
    const body = completion('classify_continuation', { intent: 'answer', updates: [] })
    expect(() => readContinuationCompletion(body, CONFIG.model, REQ)).toThrow(
      UnusableExtractionError,
    )
  })

  it('rejects "answer" with a null updates array', () => {
    const body = completion('classify_continuation', { intent: 'answer', updates: null })
    expect(() => readContinuationCompletion(body, CONFIG.model, REQ)).toThrow(
      UnusableExtractionError,
    )
  })

  it('rejects an unknown slot rather than passing it downstream', () => {
    const body = completion('classify_continuation', {
      intent: 'answer',
      updates: [{ entryId: 'e1', slot: 'rate', value: '$200/hr' }],
    })
    expect(() => readContinuationCompletion(body, CONFIG.model, REQ)).toThrow(
      UnusableExtractionError,
    )
  })

  it('rejects a tool call for the wrong tool', () => {
    const body = completion('submit_time_entries', { entries: [], reply: 'x' })
    expect(() => readContinuationCompletion(body, CONFIG.model, REQ)).toThrow(
      UnusableExtractionError,
    )
  })

  it('reports an in-body 402 as exhausted credit, same as the timesheet extractor', () => {
    const body = JSON.stringify({ error: { message: 'insufficient credit', code: 402 } })
    expect(() => readContinuationCompletion(body, CONFIG.model, REQ)).toThrow(
      CreditsExhaustedError,
    )
  })
})

describe('the gateway call', () => {
  it('forces the single classification tool, at temperature zero', async () => {
    const { classifier, fetchImpl } = gateway({
      body: completion('classify_continuation', { intent: 'new_message', updates: null }),
    })
    await classifier.classify(INPUT)

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(body.tool_choice).toBe('required')
    expect(
      body.tools.map((t: { function: { name: string } }) => t.function.name),
    ).toEqual(['classify_continuation'])
    expect(body.temperature).toBe(0)
    expect(body.model).toBe(CONFIG.model)
  })

  it('sends the same zero-retention provider policy as the timesheet extractor', async () => {
    const { classifier, fetchImpl } = gateway({
      body: completion('classify_continuation', { intent: 'new_message', updates: null }),
    })
    await classifier.classify(INPUT)
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(body.provider).toEqual({
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    })
  })

  it('retries once on a 429 and succeeds', async () => {
    const { classifier, fetchImpl } = gateway(
      { status: 429, body: '{}' },
      {
        body: completion('classify_continuation', {
          intent: 'new_message',
          updates: null,
        }),
      },
    )
    const { decision } = await classifier.classify(INPUT)
    expect(decision).toEqual({ intent: 'new_message' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after one retry on a persistent 429', async () => {
    const { classifier } = gateway({ status: 429, body: '{}' })
    await expect(classifier.classify(INPUT)).rejects.toBeInstanceOf(GatewayRateLimitError)
  })
})

describe('the tool definition', () => {
  it('tells the model to copy the user’s words, not resolve them', () => {
    const props = CONTINUATION_TOOL.function.parameters.properties
    expect(props.updates.items.properties.value.description).toMatch(/verbatim/i)
  })

  it('requires both fields, so a partial call fails validation rather than guessing', () => {
    expect(CONTINUATION_TOOL.function.parameters.required).toEqual(['intent', 'updates'])
  })
})

describe('the continuation prompt', () => {
  it('quotes the pending question and lists every entry, not just the one being asked about', () => {
    const prompt = buildContinuationSystemPrompt({
      today: '2026-07-25',
      timezone: 'America/New_York',
      entries: [entry(), entry({ id: 'e2', hours: { status: 'resolved', hours: 2 } })],
      pending: { entryId: 'e1', slot: 'project' },
    })
    expect(prompt).toContain('e1')
    expect(prompt).toContain('e2')
    expect(prompt).toMatch(/Which project/i)
  })

  it('treats rejecting the offered options as an answer, not a new topic', () => {
    // The live field report: 'i want something else like "i created an app"' against the
    // charge-code chips was classified as a new message, and the whole extraction restarted.
    const prompt = buildContinuationSystemPrompt({
      today: '2026-07-25',
      timezone: 'America/New_York',
      entries: [entry()],
      pending: { entryId: 'e1', slot: 'task' },
    })
    expect(prompt).toMatch(/still an answer/i)
    expect(prompt).toMatch(/does not exist yet/i)
  })

  it('carries no Zoho id — only the project name the entry already resolved to', () => {
    const prompt = buildContinuationSystemPrompt({
      today: '2026-07-25',
      timezone: 'America/New_York',
      entries: [entry()],
      pending: { entryId: 'e1', slot: 'date' },
    })
    expect(prompt).not.toContain('p-clayco')
    expect(prompt).toContain('Clayco EKI Data Center')
  })
})
