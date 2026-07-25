import { describe, expect, it } from 'vitest'
import {
  MAX_HISTORY_CHARS,
  MAX_PROJECT_HINTS,
  buildSystemPrompt,
  windowConversation,
  type ChatMessage,
} from '@/lib/extract/prompt'

const CONTEXT = {
  displayName: 'Nuno Barreto',
  today: '2026-07-25',
  timezone: 'America/New_York',
  recentProjects: [
    { projectName: 'STE-1 - Clayco: MS DC', accountName: 'Clayco' },
    { projectName: 'STE-2 - Internal', accountName: null },
  ],
  defaultBillable: true,
}

describe('buildSystemPrompt', () => {
  it('anchors the date in the user’s own timezone', () => {
    const prompt = buildSystemPrompt(CONTEXT)
    expect(prompt).toContain('2026-07-25')
    expect(prompt).toContain('America/New_York')
  })

  it('states the rules that change what gets billed', () => {
    const prompt = buildSystemPrompt(CONTEXT)
    expect(prompt).toMatch(/never invent hours/i)
    expect(prompt).toMatch(/never invent a description/i)
    expect(prompt).toMatch(/never invent or substitute a project/i)
    expect(prompt).toMatch(/never convert a date/i)
  })

  it('carries no Zoho identifier, no rate and no token', () => {
    // design §4.1 — the prompt is the one place a rate could leak to a third party.
    const prompt = buildSystemPrompt({
      ...CONTEXT,
      recentProjects: [{ projectName: 'STE-1 - Clayco: MS DC', accountName: 'Clayco' }],
    })
    expect(prompt).not.toMatch(/\b\d{16,}\b/) // a Zoho id
    expect(prompt).not.toMatch(/rate|\$|usd|hourly/i)
    expect(prompt).not.toMatch(/token|secret|bearer/i)
  })

  it('presents projects as hints, not as a list to choose from', () => {
    const prompt = buildSystemPrompt(CONTEXT)
    expect(prompt).toMatch(/NOT a list to choose from/i)
    expect(prompt).toContain('STE-1 - Clayco: MS DC (Clayco)')
    // No account, so no empty parentheses.
    expect(prompt).toContain('- STE-2 - Internal')
    expect(prompt).not.toContain('()')
  })

  it('caps the hints, so a heavy user does not inflate every prompt', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      projectName: `Project ${i}`,
      accountName: null,
    }))
    const prompt = buildSystemPrompt({ ...CONTEXT, recentProjects: many })
    const listed = prompt.split('\n').filter((l) => l.startsWith('- Project '))
    expect(listed).toHaveLength(MAX_PROJECT_HINTS)
  })

  it('says something sensible when the person has no history', () => {
    const prompt = buildSystemPrompt({ ...CONTEXT, recentProjects: [] })
    expect(prompt).toMatch(/no history for this person yet/i)
    expect(prompt).not.toMatch(/NOT a list to choose from/i)
  })

  it('tells the model the billable default, so it does not ask about it', () => {
    expect(buildSystemPrompt(CONTEXT)).toMatch(/defaults unstated entries to billable/i)
    expect(buildSystemPrompt({ ...CONTEXT, defaultBillable: false })).toMatch(
      /defaults unstated entries to non-billable/i,
    )
  })

  it('omits the greeting rather than addressing a blank name', () => {
    expect(buildSystemPrompt({ ...CONTEXT, displayName: '  ' })).not.toContain(
      'You are talking to',
    )
    expect(buildSystemPrompt({ ...CONTEXT, displayName: null })).not.toContain(
      'You are talking to',
    )
  })
})

describe('windowConversation', () => {
  const turn = (i: number): ChatMessage => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `turn ${i}`,
  })

  it('keeps everything when the history is small', () => {
    const history = [turn(0), turn(1), turn(2)]
    expect(windowConversation(history)).toEqual(history)
  })

  it('keeps the newest turns and drops the oldest', () => {
    const history = Array.from({ length: 30 }, (_, i) => turn(i))
    const kept = windowConversation(history, { maxTurns: 4 })
    expect(kept.map((m) => m.content)).toEqual([
      'turn 26',
      'turn 27',
      'turn 28',
      'turn 29',
    ])
  })

  it('preserves order, so a follow-up still reads as a follow-up', () => {
    const history = [
      { role: 'user' as const, content: '8 hours on Clayco' },
      { role: 'assistant' as const, content: 'Got it.' },
      { role: 'user' as const, content: 'make that 6' },
    ]
    expect(windowConversation(history).map((m) => m.content)).toEqual([
      '8 hours on Clayco',
      'Got it.',
      'make that 6',
    ])
  })

  it('drops from the oldest end when the character budget bites', () => {
    const history = [
      { role: 'user' as const, content: 'a'.repeat(60) },
      { role: 'assistant' as const, content: 'b'.repeat(60) },
      { role: 'user' as const, content: 'c'.repeat(60) },
    ]
    const kept = windowConversation(history, { maxChars: 130 })
    expect(kept).toHaveLength(2)
    expect(kept[1]!.content.startsWith('c')).toBe(true)
  })

  it('truncates rather than drops the newest turn, which is what the user just said', () => {
    const history = [{ role: 'user' as const, content: 'x'.repeat(500) }]
    const kept = windowConversation(history, { maxChars: 100 })
    expect(kept).toHaveLength(1)
    expect(kept[0]!.content).toHaveLength(101) // the ellipsis marks it as a fragment
    expect(kept[0]!.content.startsWith('…')).toBe(true)
  })

  it('drops an over-long older turn instead of showing half of it', () => {
    const history = [
      { role: 'user' as const, content: 'y'.repeat(500) },
      { role: 'user' as const, content: 'the recent one' },
    ]
    const kept = windowConversation(history, { maxChars: 100 })
    expect(kept.map((m) => m.content)).toEqual(['the recent one'])
  })

  it('handles an empty history', () => {
    expect(windowConversation([])).toEqual([])
  })

  it('has a default budget large enough for a real conversation', () => {
    expect(MAX_HISTORY_CHARS).toBeGreaterThan(2000)
  })
})
