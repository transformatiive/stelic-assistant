import { describe, expect, it, vi } from 'vitest'
import {
  CreditsExhaustedError,
  GatewayError,
  GatewayRateLimitError,
  NoCompliantEndpointError,
  UnusableExtractionError,
} from '@/lib/extract/errors'
import {
  createOpenRouterExtractor,
  readCompletion,
  userAttribution,
} from '@/lib/extract/openrouter'
import { TOOL_DEFINITIONS, hoursLookImplausible } from '@/lib/extract/schema'
import { FIXTURES, completion } from './support/openrouter-fixtures'

const REQ = 'req-1'

const CONFIG = {
  apiKey: 'sk-or-v1-test',
  model: 'anthropic/claude-sonnet-5',
  fallbackModels: ['anthropic/claude-sonnet-4.5'],
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
  return { fetchImpl, extractor: createOpenRouterExtractor({ ...CONFIG, fetchImpl }) }
}

const INPUT = {
  systemPrompt: 'You help Stelic staff log time.',
  messages: [{ role: 'user' as const, content: '8 hours on Clayco yesterday' }],
  userKey: 'abc123',
}

// Task 4.7 names these eight cases.
describe('fixtures', () => {
  it('single entry', () => {
    const { extraction } = readCompletion(FIXTURES.singleEntry, CONFIG.model, REQ)
    expect(extraction.kind).toBe('submit_time_entries')
    if (extraction.kind !== 'submit_time_entries') return
    expect(extraction.entries).toHaveLength(1)
    expect(extraction.entries[0]).toMatchObject({
      project_query: 'clayco',
      date_expression: 'yesterday',
      hours: 8,
    })
  })

  it('two projects in one sentence become two entries', () => {
    const { extraction } = readCompletion(
      FIXTURES.twoProjectsOneSentence,
      CONFIG.model,
      REQ,
    )
    if (extraction.kind !== 'submit_time_entries') throw new Error('wrong tool')
    expect(extraction.entries.map((e) => e.project_query)).toEqual([
      'clayco',
      'the Google job',
    ])
  })

  it('one project across three days becomes three entries, not one of 24 hours', () => {
    const { extraction } = readCompletion(FIXTURES.oneProjectThreeDays, CONFIG.model, REQ)
    if (extraction.kind !== 'submit_time_entries') throw new Error('wrong tool')
    expect(extraction.entries).toHaveLength(3)
    expect(extraction.entries.every((e) => e.hours === 8)).toBe(true)
    expect(extraction.entries.map((e) => e.date_expression)).toEqual([
      'Monday',
      'Tuesday',
      'Wednesday',
    ])
  })

  it('missing description stays null rather than being invented', () => {
    const { extraction } = readCompletion(FIXTURES.missingDescription, CONFIG.model, REQ)
    if (extraction.kind !== 'submit_time_entries') throw new Error('wrong tool')
    expect(extraction.entries[0]!.description).toBeNull()
  })

  it('missing hours stays null rather than being estimated', () => {
    const { extraction } = readCompletion(FIXTURES.missingHours, CONFIG.model, REQ)
    if (extraction.kind !== 'submit_time_entries') throw new Error('wrong tool')
    expect(extraction.entries[0]!.hours).toBeNull()
  })

  it('a pure question records nothing', () => {
    const { extraction } = readCompletion(FIXTURES.pureQuestion, CONFIG.model, REQ)
    expect(extraction).toMatchObject({ kind: 'reply_only', intent: 'week_summary' })
  })

  it('gibberish records nothing', () => {
    const { extraction } = readCompletion(FIXTURES.gibberish, CONFIG.model, REQ)
    expect(extraction.kind).toBe('reply_only')
  })

  it('a malformed tool call is a handled failure, not a crash', () => {
    expect(() => readCompletion(FIXTURES.malformedToolCall, CONFIG.model, REQ)).toThrow(
      UnusableExtractionError,
    )
  })
})

describe('validation catches what the schema forbids', () => {
  it('rejects zero hours, which would create an empty log', () => {
    const error = catchError(() =>
      readCompletion(FIXTURES.schemaViolation, CONFIG.model, REQ),
    )
    expect(error).toBeInstanceOf(UnusableExtractionError)
    expect((error as UnusableExtractionError).reason).toContain('hours')
  })

  it('rejects hours beyond a day', () => {
    const body = completion('submit_time_entries', {
      entries: [
        {
          project_query: 'x',
          date_expression: 'today',
          hours: 25,
          description: 'd',
          billable: null,
          charge_code_hint: null,
        },
      ],
      reply: 'ok',
    })
    expect(() => readCompletion(body, CONFIG.model, REQ)).toThrow(UnusableExtractionError)
  })

  it('rejects an empty project_query, which the matcher could not use', () => {
    const body = completion('submit_time_entries', {
      entries: [
        {
          project_query: '   ',
          date_expression: 'today',
          hours: 1,
          description: 'd',
          billable: null,
          charge_code_hint: null,
        },
      ],
      reply: 'ok',
    })
    expect(() => readCompletion(body, CONFIG.model, REQ)).toThrow(UnusableExtractionError)
  })

  it('rejects submit_time_entries with no entries at all', () => {
    const body = completion('submit_time_entries', { entries: [], reply: 'ok' })
    expect(() => readCompletion(body, CONFIG.model, REQ)).toThrow(UnusableExtractionError)
  })

  it('rejects an unknown intent rather than passing it downstream', () => {
    const body = completion('reply_only', { reply: 'hi', intent: 'something_new' })
    expect(() => readCompletion(body, CONFIG.model, REQ)).toThrow(UnusableExtractionError)
  })

  it('rejects a tool nobody defined', () => {
    const body = completion('delete_everything', { reply: 'ok' })
    expect(() => readCompletion(body, CONFIG.model, REQ)).toThrow(UnusableExtractionError)
  })

  it('treats prose instead of a tool call as unusable', () => {
    // tool_choice: "required" should prevent this; when it happens, a provider ignored it.
    const error = catchError(() => readCompletion(FIXTURES.noToolCall, CONFIG.model, REQ))
    expect((error as UnusableExtractionError).reason).toContain('no tool call')
  })

  it('flags sub-quarter-hour values as implausible rather than rounding them away', () => {
    expect(hoursLookImplausible(0.1)).toBe(true)
    expect(hoursLookImplausible(0.25)).toBe(false)
    expect(hoursLookImplausible(null)).toBe(false)
  })
})

describe('usage accounting', () => {
  it('captures what the month-end cost question needs', () => {
    const { usage } = readCompletion(FIXTURES.singleEntry, CONFIG.model, REQ)
    expect(usage).toEqual({
      generationId: 'gen-01JABCDEF',
      modelRequested: 'anthropic/claude-sonnet-5',
      modelServed: 'anthropic/claude-sonnet-5',
      promptTokens: 812,
      completionTokens: 96,
      costUsd: 0.00214,
    })
  })

  it('records the model that actually served, which differs under fallback', () => {
    const body = completion(
      'reply_only',
      { reply: 'hi', intent: 'smalltalk' },
      { model: 'anthropic/claude-sonnet-4.5' },
    )
    const { usage } = readCompletion(body, 'anthropic/claude-sonnet-5', REQ)
    expect(usage.modelRequested).toBe('anthropic/claude-sonnet-5')
    expect(usage.modelServed).toBe('anthropic/claude-sonnet-4.5')
  })
})

describe('request shape', () => {
  it('sends the policy that keeps prompts off training data and on ZDR endpoints', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(body.provider).toEqual({
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    })
  })

  it('forces a tool call and offers exactly the two tools', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)

    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(body.tool_choice).toBe('required')
    expect(
      body.tools.map((t: { function: { name: string } }) => t.function.name),
    ).toEqual(['submit_time_entries', 'reply_only'])
  })

  it('asks at temperature zero, because the same sentence must parse the same way', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).temperature).toBe(0)
  })

  it('requests usage, without which cost cannot be attributed', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body)).usage).toEqual({
      include: true,
    })
  })

  it('sends the opaque user key and never anything identifying', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract({ ...INPUT, userKey: userAttribution('user_1', 'salt') })

    const raw = String(fetchImpl.mock.calls[0]![1]!.body)
    expect(JSON.parse(raw).user).toBe(userAttribution('user_1', 'salt'))
    expect(raw).not.toContain('user_1')
    expect(raw).not.toContain('@')
  })

  it('puts the system prompt first and the conversation after it', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))
    expect(body.messages[0]).toEqual({ role: 'system', content: INPUT.systemPrompt })
    expect(body.messages[1]).toEqual(INPUT.messages[0])
  })

  it('keeps the key out of everything except the Authorization header', async () => {
    const { extractor, fetchImpl } = gateway({ body: FIXTURES.singleEntry })
    await extractor.extract(INPUT)
    const [, init] = fetchImpl.mock.calls[0]!
    expect(String(init!.body)).not.toContain(CONFIG.apiKey)
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFIG.apiKey}`,
    )
  })
})

describe('userAttribution', () => {
  it('is stable, opaque and salt-dependent', () => {
    expect(userAttribution('u1', 's')).toBe(userAttribution('u1', 's'))
    expect(userAttribution('u1', 's')).not.toContain('u1')
    expect(userAttribution('u1', 's')).not.toBe(userAttribution('u1', 'other'))
    expect(userAttribution('u1', 's')).not.toBe(userAttribution('u2', 's'))
  })
})

describe('failure modes', () => {
  it('retries once on 429 and succeeds', async () => {
    const { extractor, fetchImpl } = gateway(
      { status: 429, body: '{}' },
      { body: FIXTURES.singleEntry },
    )
    const result = await extractor.extract(INPUT)
    expect(result.extraction.kind).toBe('submit_time_entries')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries once on 5xx and succeeds', async () => {
    const { extractor, fetchImpl } = gateway(
      { status: 503, body: 'upstream down' },
      { body: FIXTURES.singleEntry },
    )
    await extractor.extract(INPUT)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('gives up after one retry on a persistent 429', async () => {
    const { extractor, fetchImpl } = gateway({ status: 429, body: '{}' })
    await expect(extractor.extract(INPUT)).rejects.toBeInstanceOf(GatewayRateLimitError)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never retries a 402 — an empty balance will still be empty', async () => {
    const { extractor, fetchImpl } = gateway({ status: 402, body: '{}' })
    await expect(extractor.extract(INPUT)).rejects.toBeInstanceOf(CreditsExhaustedError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reports an in-body 402 as exhausted credit, not a generic error', () => {
    expect(() => readCompletion(FIXTURES.errorInBody, CONFIG.model, REQ)).toThrow(
      CreditsExhaustedError,
    )
  })

  it('fails closed when the provider policy leaves nothing to route to', async () => {
    const { extractor } = gateway({
      status: 404,
      body: JSON.stringify({
        error: { message: 'No endpoints found matching your data policy' },
      }),
    })
    await expect(extractor.extract(INPUT)).rejects.toBeInstanceOf(
      NoCompliantEndpointError,
    )
  })

  it('surfaces any other gateway failure as itself', async () => {
    const { extractor } = gateway({ status: 400, body: 'bad request' })
    const error = await extractor.extract(INPUT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(GatewayError)
    expect((error as GatewayError).status).toBe(400)
  })

  it('carries one request id through a retry chain, so logs join up', async () => {
    const { extractor, fetchImpl } = gateway(
      { status: 429, body: '{}' },
      { body: FIXTURES.singleEntry },
    )
    const result = await extractor.extract(INPUT)
    const ids = fetchImpl.mock.calls.map(
      ([, init]) => (init!.headers as Record<string, string>)['X-Request-Id'],
    )
    expect(new Set(ids).size).toBe(1)
    expect(result.requestId).toBe(REQ)
  })
})

describe('tool definitions', () => {
  it('tells the model to copy the user’s wording rather than interpret it', () => {
    const submit = TOOL_DEFINITIONS[0]!.function
    const props = (
      submit.parameters.properties as {
        entries: { items: { properties: Record<string, { description?: string }> } }
      }
    ).entries.items.properties
    expect(props.project_query!.description).toMatch(/verbatim/i)
    expect(props.date_expression!.description).toMatch(/verbatim/i)
    expect(props.hours!.description).toMatch(/never estimate/i)
    expect(props.description!.description).toMatch(/never invent/i)
  })
})

function catchError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('expected a throw')
}
