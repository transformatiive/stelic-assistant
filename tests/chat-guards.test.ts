import { describe, expect, it } from 'vitest'
import {
  CHAT_LIMIT_PER_MINUTE,
  consumeChatQuota,
  pruneRateLimits,
} from '@/lib/chat/rate-limit'
import { checkScope } from '@/lib/chat/scope'
import { FakeDb } from './support/fake-db'

describe('the chat rate limit', () => {
  const at = (iso: string) => new Date(iso)

  it('allows thirty in a minute and refuses the thirty-first', async () => {
    const db = new FakeDb()
    const now = at('2026-07-25T12:00:30Z')

    for (let i = 0; i < CHAT_LIMIT_PER_MINUTE; i += 1) {
      const verdict = await consumeChatQuota(db.client, 'user_1', { now })
      expect(verdict.allowed).toBe(true)
    }

    const over = await consumeChatQuota(db.client, 'user_1', { now })
    expect(over.allowed).toBe(false)
    expect(over.remaining).toBe(0)
  })

  it('counts down what is left', async () => {
    const db = new FakeDb()
    const now = at('2026-07-25T12:00:00Z')
    const first = await consumeChatQuota(db.client, 'user_1', { now })
    expect(first.remaining).toBe(CHAT_LIMIT_PER_MINUTE - 1)
  })

  it('rolls over into the next minute', async () => {
    const db = new FakeDb()
    for (let i = 0; i <= CHAT_LIMIT_PER_MINUTE; i += 1) {
      await consumeChatQuota(db.client, 'user_1', { now: at('2026-07-25T12:00:30Z') })
    }
    const next = await consumeChatQuota(db.client, 'user_1', {
      now: at('2026-07-25T12:01:00Z'),
    })
    expect(next.allowed).toBe(true)
  })

  it('quantises the window, so every request in a minute shares one counter', async () => {
    const db = new FakeDb()
    await consumeChatQuota(db.client, 'user_1', { now: at('2026-07-25T12:00:01Z') })
    await consumeChatQuota(db.client, 'user_1', { now: at('2026-07-25T12:00:59Z') })
    // One row, not two — which is what makes the unique constraint do the concurrency work.
    expect(db.rateLimits).toHaveLength(1)
    expect(db.rateLimits[0]!.count).toBe(2)
  })

  it('limits each person separately', async () => {
    const db = new FakeDb()
    const now = at('2026-07-25T12:00:00Z')
    for (let i = 0; i <= CHAT_LIMIT_PER_MINUTE; i += 1) {
      await consumeChatQuota(db.client, 'noisy', { now })
    }
    await expect(consumeChatQuota(db.client, 'quiet', { now })).resolves.toMatchObject({
      allowed: true,
    })
  })

  it('says how long until the window rolls over', async () => {
    const db = new FakeDb()
    const verdict = await consumeChatQuota(db.client, 'user_1', {
      now: at('2026-07-25T12:00:45Z'),
    })
    expect(verdict.resetSeconds).toBe(15)
  })

  it('drops counters from windows that have rolled over', async () => {
    const db = new FakeDb()
    await consumeChatQuota(db.client, 'user_1', { now: at('2026-07-25T10:00:00Z') })
    await consumeChatQuota(db.client, 'user_1', { now: at('2026-07-25T12:00:00Z') })

    const removed = await pruneRateLimits(db.client, { now: at('2026-07-25T12:00:00Z') })
    expect(removed).toBe(1)
    expect(db.rateLimits).toHaveLength(1)
  })
})

describe('staying inside the remit', () => {
  const refused = (message: string) => {
    const verdict = checkScope(message)
    expect(verdict.inScope).toBe(false)
    return verdict.inScope === false ? verdict : null
  }

  it('declines the questions the spec names', () => {
    expect(refused("what's my rate on Clayco?")?.topic).toBe('rate')
    expect(refused('how much is left in the budget?')?.topic).toBe('budget')
    expect(refused('approve my timesheet')?.topic).toBe('approval')
  })

  it('declines invoices and administration too', () => {
    expect(refused('show me the invoice for Clayco')?.topic).toBe('invoice')
    expect(refused('can you add a user to the portal?')?.topic).toBe('admin')
  })

  it('says what it can do instead of only what it cannot', () => {
    const verdict = refused('what is my hourly rate?')
    expect(verdict?.reply).toMatch(/only log time|log it/i)
    expect(verdict?.reply).toContain('8h on Clayco')
  })

  it('never puts a number in the refusal, because it has none to give', () => {
    // The guarantee is that no code path fetches a rate or a budget at all. The reply must
    // not read as though one was looked up and withheld.
    const verdict = refused("what's my rate on Clayco?")
    expect(verdict?.reply).not.toMatch(/\$|\d+\s*(\/|per)\s*h/i)
  })
})

describe('what the guard must never refuse', () => {
  // Refusing a log is a worse failure than answering a question we would rather not answer:
  // the log is the thing the app exists for.
  it('lets through a time entry that happens to mention a sensitive word', () => {
    expect(checkScope('6h on Clayco for the budget review').inScope).toBe(true)
    expect(checkScope('2 hours preparing the invoice pack for Turner').inScope).toBe(true)
    expect(checkScope('90m on the rate card workshop').inScope).toBe(true)
    expect(checkScope('half a day on approvals cleanup').inScope).toBe(true)
  })

  it('lets through ordinary logging and ordinary questions', () => {
    expect(checkScope('8 hours on Clayco yesterday — structural review').inScope).toBe(
      true,
    )
    expect(checkScope('what did I log this week?').inScope).toBe(true)
    expect(checkScope('undo that').inScope).toBe(true)
    expect(checkScope('which projects do I have?').inScope).toBe(true)
  })

  it('lets through a statement that merely contains a topic word', () => {
    // Not a question and not an instruction — a description of work.
    expect(checkScope('budget meeting with the client').inScope).toBe(true)
  })

  it('lets through an empty message rather than refusing it', () => {
    expect(checkScope('   ').inScope).toBe(true)
  })
})
