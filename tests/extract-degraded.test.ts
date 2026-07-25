import { describe, expect, it } from 'vitest'
import {
  CreditsExhaustedError,
  GatewayError,
  GatewayRateLimitError,
  NoCompliantEndpointError,
  UnusableExtractionError,
} from '@/lib/extract/errors'
import { classifyExtractionFailure } from '@/lib/extract/degraded'
import { usageColumns } from '@/lib/extract/usage'

const REQ = 'req-1'

describe('degraded mode', () => {
  it('always keeps the user able to log time', () => {
    // CHAT-13: the bot is never simply down. Every failure lands in the guided form.
    const failures = [
      new CreditsExhaustedError(REQ),
      new GatewayRateLimitError(REQ),
      new GatewayError(500, REQ),
      new UnusableExtractionError('no tool call', REQ),
      new NoCompliantEndpointError('anthropic/claude-sonnet-5', REQ),
      new Error('something unexpected'),
      'not even an error',
    ]
    for (const failure of failures) {
      expect(classifyExtractionFailure(failure).useGuidedForm).toBe(true)
    }
  })

  it('never leaks a provider, a model, a status code or a token to the user', () => {
    const failures = [
      new CreditsExhaustedError(REQ),
      new GatewayRateLimitError(REQ),
      new GatewayError(503, REQ),
      new UnusableExtractionError('arguments were not valid JSON', REQ),
      new NoCompliantEndpointError('anthropic/claude-sonnet-5', REQ),
    ]
    for (const failure of failures) {
      const { message } = classifyExtractionFailure(failure)
      expect(message).not.toMatch(/openrouter|anthropic|claude|token|credit|402|429|503/i)
    }
  })

  it('pages someone when the balance is gone, though the user sees only a hiccup', () => {
    // Individually mild, collectively fatal: without the alert the bot is useless for
    // everyone until somebody happens to notice.
    const outcome = classifyExtractionFailure(new CreditsExhaustedError(REQ))
    expect(outcome).toMatchObject({ alert: true, reason: 'credits_exhausted' })
    expect(outcome.message).not.toMatch(/credit/i)
  })

  it('pages someone when no endpoint meets the data policy', () => {
    const outcome = classifyExtractionFailure(new NoCompliantEndpointError('m', REQ))
    expect(outcome).toMatchObject({ alert: true, reason: 'no_compliant_endpoint' })
  })

  it('does not page for a rate limit or a one-off bad extraction', () => {
    expect(classifyExtractionFailure(new GatewayRateLimitError(REQ)).alert).toBe(false)
    expect(classifyExtractionFailure(new UnusableExtractionError('x', REQ)).alert).toBe(
      false,
    )
    expect(classifyExtractionFailure(new GatewayError(502, REQ)).alert).toBe(false)
  })

  it('pages for something it does not recognise, because unknown is not safe', () => {
    expect(classifyExtractionFailure(new Error('?')).alert).toBe(true)
    expect(classifyExtractionFailure(undefined).reason).toBe('unknown')
  })

  it('blames itself rather than the user', () => {
    for (const failure of [
      new GatewayError(500, REQ),
      new UnusableExtractionError('x', REQ),
    ]) {
      const { message } = classifyExtractionFailure(failure)
      expect(message).not.toMatch(/you (did|typed|wrote) .* wrong/i)
      expect(message).toMatch(/short way/i)
    }
  })
})

describe('usageColumns', () => {
  it('records what a cost question needs', () => {
    expect(
      usageColumns({
        generationId: 'gen-1',
        modelRequested: 'anthropic/claude-sonnet-5',
        modelServed: 'anthropic/claude-sonnet-4.5',
        promptTokens: 812,
        completionTokens: 96,
        costUsd: 0.00214,
      }),
    ).toEqual({
      generationId: 'gen-1',
      modelRequested: 'anthropic/claude-sonnet-5',
      modelServed: 'anthropic/claude-sonnet-4.5',
      promptTokens: 812,
      completionTokens: 96,
      costUsd: '0.00214',
    })
  })

  it('writes nothing for a turn that made no model call', () => {
    // A degraded turn is answered by the guided form, with no gateway involved.
    expect(usageColumns(null)).toEqual({})
    expect(usageColumns(undefined)).toEqual({})
  })

  it('records a partial row rather than nothing when a provider omits cost', () => {
    const columns = usageColumns({ modelRequested: 'm', promptTokens: 10 })
    expect(columns).toMatchObject({
      modelRequested: 'm',
      promptTokens: 10,
      costUsd: null,
    })
  })

  it('passes cost as a string, so summing thousands of rows does not drift', () => {
    expect(usageColumns({ modelRequested: 'm', costUsd: 0.1 }).costUsd).toBe('0.1')
    expect(typeof usageColumns({ modelRequested: 'm', costUsd: 0 }).costUsd).toBe(
      'string',
    )
  })
})
