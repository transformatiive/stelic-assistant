import { describe, expect, it } from 'vitest'
import { runChatTurn } from '@/lib/chat/turn'
import type { Agent, AgentOutcome } from '@/lib/chat/agent'
import { GatewayError } from '@/lib/extract/errors'
import type { ChatUi } from '@/lib/chat/ui'
import { FakeDb } from './support/fake-db'

const NOW = new Date('2026-07-22T16:00:00Z') // 12:00 Wednesday in New York

type Recorder = Agent & {
  calls: { systemPrompt: string; messages: readonly { content: string }[] }[]
}

/** An agent that settles on a fixed outcome, recording what it was asked. */
function agentReturning(outcome: AgentOutcome): Recorder {
  const calls: Recorder['calls'] = []
  return {
    calls,
    async run(input) {
      calls.push(input)
      return {
        outcome,
        usage: { modelRequested: 'anthropic/claude-sonnet-5', costUsd: 0.0012 },
      }
    },
  }
}

const failingAgent: Agent = {
  async run() {
    throw new GatewayError(503, 'req_1')
  },
}

function seedIndex(db: FakeDb) {
  db.projectIndexes.push({
    projectId: '2620762000000790022',
    projectName: 'STE-100013 - Clayco: MS Data Center',
    projectIdString: '2620762000000790022',
    crmDealId: null,
    dealName: null,
    accountName: 'Clayco Construction Company Inc',
    aliases: ['clayco'],
    chargeCodes: [
      { taskId: 'task_1', taskName: 'Engineering', tasklist: 'Stelic Services' },
    ],
    refreshedAt: NOW,
  })
}

const turnInput = {
  userId: 'user_1',
  displayName: 'Nuno Barreto',
  timezone: 'America/New_York',
  now: NOW,
  defaultBillable: true,
  backdateWarnDays: 14,
  userKey: 'opaque',
}

/** A ready entry, as the agent's own tools would have built it. */
const readyEntry = {
  id: 'e1',
  said: { project: 'clayco', date: 'yesterday' },
  project: {
    status: 'resolved' as const,
    projectId: '2620762000000790022',
    projectName: 'STE-100013 - Clayco: MS Data Center',
    accountName: 'Clayco Construction Company Inc',
    why: 'you chose it',
  },
  task: {
    status: 'resolved' as const,
    taskId: 'task_1',
    taskName: 'Engineering',
    why: 'you chose it',
  },
  date: { status: 'resolved' as const, date: '2026-07-21' },
  hours: { status: 'resolved' as const, hours: 8 },
  description: { status: 'resolved' as const, description: 'Structural review' },
  billable: true,
}

describe('a turn the agent can settle', () => {
  it('puts the proposed entries on a confirmation card', async () => {
    const db = new FakeDb()
    seedIndex(db)

    const result = await runChatTurn(
      db.client,
      agentReturning({
        kind: 'propose',
        message: 'Got it — 8 hours on Clayco yesterday.',
        entries: [readyEntry],
      }),
      { ...turnInput, message: '8 hours on clayco yesterday, structural review' },
    )

    expect(result.ui.kind).toBe('confirmation')
    const ui = result.ui as Extract<ChatUi, { kind: 'confirmation' }>
    expect(ui.totalHours).toBe(8)
    expect(ui.entries[0]).toMatchObject({
      state: 'ready',
      projectName: 'STE-100013 - Clayco: MS Data Center',
      taskName: 'Engineering',
      date: '2026-07-21',
      hours: 8,
    })
  })

  it('writes nothing to Zoho — a draft is all a turn can produce', async () => {
    const db = new FakeDb()
    seedIndex(db)
    await runChatTurn(
      db.client,
      agentReturning({ kind: 'propose', message: 'ok', entries: [readyEntry] }),
      { ...turnInput, message: '8h clayco yesterday' },
    )
    expect(db.commitLogs).toEqual([])
    expect(db.drafts).toHaveLength(1)
    expect(db.drafts[0]!.status).toBe('pending')
  })

  it('records what the turn cost against the message that caused it', async () => {
    const db = new FakeDb()
    seedIndex(db)
    await runChatTurn(
      db.client,
      agentReturning({ kind: 'propose', message: 'ok', entries: [readyEntry] }),
      { ...turnInput, message: '8h clayco yesterday' },
    )
    const assistant = db.messages.find((m) => m.role === 'assistant')!
    expect(assistant.costUsd).toBe('0.0012')
    expect(assistant.modelRequested).toBe('anthropic/claude-sonnet-5')
  })

  it('asks in the agent’s own words, with tappable options', async () => {
    const db = new FakeDb()
    seedIndex(db)

    const result = await runChatTurn(
      db.client,
      agentReturning({
        kind: 'ask',
        message: 'Which Clayco project — the data centre or the warehouse?',
        options: ['MS Data Center', 'Warehouse 4'],
      }),
      { ...turnInput, message: '8h on clayco' },
    )

    expect(result.reply).toContain('Clayco')
    expect(result.ui).toEqual({
      kind: 'question',
      options: ['MS Data Center', 'Warehouse 4'],
    })
    // A question is not a draft: nothing is pending until entries are proposed.
    expect(db.drafts).toEqual([])
  })

  it('asks with no options when there is no finite set to offer', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const result = await runChatTurn(
      db.client,
      agentReturning({ kind: 'ask', message: 'What did you work on?', options: [] }),
      { ...turnInput, message: '8h clayco yesterday' },
    )
    expect(result.ui).toEqual({ kind: 'question', options: [] })
  })
})

describe('replies that record nothing', () => {
  it('tells the client to show the week', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const result = await runChatTurn(
      db.client,
      agentReturning({
        kind: 'say',
        message: 'Here’s your week.',
        intent: 'week_summary',
      }),
      { ...turnInput, message: 'what did I log this week?' },
    )
    expect(result.ui).toEqual({ kind: 'week' })
  })

  it('offers only what undo would actually accept', async () => {
    const db = new FakeDb()
    seedIndex(db)
    db.commitLogs.push(
      {
        id: 'commit_ok',
        userId: 'user_1',
        projectId: 'p1',
        projectName: 'Clayco',
        taskName: 'Engineering',
        status: 'success',
        logDate: new Date('2026-07-22T00:00:00Z'),
        hoursDecimal: 8,
        completedAt: new Date('2026-07-22T15:00:00Z'),
      },
      {
        id: 'commit_failed',
        userId: 'user_1',
        projectId: 'p1',
        projectName: 'Clayco',
        taskName: 'Engineering',
        status: 'failed',
        logDate: new Date('2026-07-22T00:00:00Z'),
        hoursDecimal: 2,
        completedAt: new Date('2026-07-22T15:05:00Z'),
      },
    )

    const result = await runChatTurn(
      db.client,
      agentReturning({ kind: 'say', message: 'Which one?', intent: 'undo' }),
      { ...turnInput, message: 'undo that' },
    )

    // A failed entry is not in Zoho, so a button for it would refuse when tapped.
    expect(result.ui).toMatchObject({
      kind: 'undo',
      candidates: [{ commitLogId: 'commit_ok', hours: 8 }],
    })
  })

  it('carries a refusal with nothing attached to it', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const result = await runChatTurn(
      db.client,
      agentReturning({
        kind: 'say',
        message: 'I only record timesheets, so I can’t help with that one.',
        intent: 'refusal',
      }),
      { ...turnInput, message: 'book me a flight to Lisbon' },
    )
    expect(result.ui).toEqual({ kind: 'none' })
    expect(db.drafts).toEqual([])
  })
})

describe('the out-of-scope guard on the chat path', () => {
  it('refuses before the model is called at all', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const agent = agentReturning({
      kind: 'say',
      message: 'never reached',
      intent: 'smalltalk',
    })

    const result = await runChatTurn(db.client, agent, {
      ...turnInput,
      message: "what's my rate on Clayco?",
    })

    expect(agent.calls).toHaveLength(0)
    expect(result.reply).toMatch(/only log time/i)
    // What they said is still recorded — a refusal is part of the conversation.
    expect(db.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('when the gateway is down', () => {
  it('says so plainly rather than failing the request', async () => {
    const db = new FakeDb()
    seedIndex(db)

    const result = await runChatTurn(db.client, failingAgent, {
      ...turnInput,
      message: 'clayco',
    })

    expect(result.degraded).toBe('gateway_error')
    expect(result.ui).toEqual({ kind: 'none' })
    expect(db.drafts).toEqual([])
  })

  it('never names a provider, a model or a status code to the user', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const result = await runChatTurn(db.client, failingAgent, {
      ...turnInput,
      message: 'clayco',
    })
    expect(result.reply).not.toMatch(/openrouter|503|gateway|claude|anthropic/i)
  })

  it('still records what the user typed', async () => {
    const db = new FakeDb()
    seedIndex(db)
    await runChatTurn(db.client, failingAgent, { ...turnInput, message: 'clayco' })
    expect(db.messages.find((m) => m.role === 'user')?.content).toBe('clayco')
  })
})

describe('what the agent is given', () => {
  it('sees the conversation so far, so nothing has to be asked twice', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const agent = agentReturning({
      kind: 'ask',
      message: 'Which day?',
      options: [],
    })

    await runChatTurn(db.client, agent, { ...turnInput, message: '8h on clayco' })
    await runChatTurn(db.client, agent, {
      ...turnInput,
      message: 'yesterday',
      now: new Date(NOW.getTime() + 60_000),
    })

    // Second turn: the first exchange is in the window, not just the newest message.
    const seen = agent.calls[1]!.messages.map((m) => m.content)
    expect(seen).toContain('8h on clayco')
    expect(seen).toContain('yesterday')
  })

  it('tells it the date and the timezone, and never a Zoho id or an email', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const agent = agentReturning({ kind: 'say', message: 'Sure.', intent: 'smalltalk' })

    await runChatTurn(db.client, agent, { ...turnInput, message: 'hello' })

    const prompt = agent.calls[0]!.systemPrompt
    expect(prompt).toContain('2026-07-22')
    expect(prompt).toContain('America/New_York')
    // Projects reach the agent through a tool, not the prompt — so no ids, and no email.
    expect(prompt).not.toContain('2620762000000790022')
    expect(prompt).not.toMatch(/@/)
  })

  it('tells it to decline anything that is not recording time', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const agent = agentReturning({ kind: 'say', message: 'Sure.', intent: 'smalltalk' })
    await runChatTurn(db.client, agent, { ...turnInput, message: 'hello' })
    expect(agent.calls[0]!.systemPrompt).toMatch(/only record timesheets/i)
  })
})

describe('the conversation window', () => {
  it('reuses a warm conversation and starts a fresh one after a long gap', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const agent = agentReturning({ kind: 'say', message: 'Sure.', intent: 'smalltalk' })

    await runChatTurn(db.client, agent, { ...turnInput, message: 'hello' })
    await runChatTurn(db.client, agent, {
      ...turnInput,
      message: 'hello again',
      now: new Date(NOW.getTime() + 60_000),
    })
    expect(db.conversations).toHaveLength(1)

    await runChatTurn(db.client, agent, {
      ...turnInput,
      message: 'monday morning',
      now: new Date(NOW.getTime() + 3 * 24 * 3600_000),
    })
    expect(db.conversations).toHaveLength(2)
  })
})

describe('the possible-duplicate warning', () => {
  /** A successful commit by this user, as the commit pipeline would have left it. */
  function alreadyLogged(db: FakeDb, over: { description: string; date?: string }) {
    db.commitLogs.push({
      id: 'commit_prior',
      userId: 'user_1',
      status: 'success',
      projectId: '2620762000000790022',
      taskId: 'task_1',
      logDate: new Date(`${over.date ?? '2026-07-21'}T00:00:00.000Z`),
      description: over.description,
    })
  }

  async function cardFor(db: FakeDb) {
    const result = await runChatTurn(
      db.client,
      agentReturning({ kind: 'propose', message: 'ok', entries: [readyEntry] }),
      { ...turnInput, message: '8h clayco yesterday, structural review' },
    )
    return result.ui as Extract<ChatUi, { kind: 'confirmation' }>
  }

  it('fires when the same work is already logged on that task and day', async () => {
    // The regression this exists for: `warningsForDraft` used to be called with no existing
    // logs at all, so re-sending the same sentence produced a clean card every time.
    const db = new FakeDb()
    seedIndex(db)
    alreadyLogged(db, { description: 'Structural review' })

    const ui = await cardFor(db)
    expect(ui.entries[0]!.warnings).toContainEqual(
      expect.objectContaining({
        kind: 'possible_duplicate',
        existingLogId: 'commit_prior',
      }),
    )
  })

  it('stays quiet when the day’s other entry is genuinely different work', async () => {
    // Two entries on one task in a day is normal — mornings and afternoons differ.
    const db = new FakeDb()
    seedIndex(db)
    alreadyLogged(db, { description: 'Site walk with the client and photo survey' })

    const ui = await cardFor(db)
    expect(ui.entries[0]!.warnings).toEqual([])
  })

  it('stays quiet when the identical work was logged on a different day', async () => {
    const db = new FakeDb()
    seedIndex(db)
    alreadyLogged(db, { description: 'Structural review', date: '2026-07-20' })

    const ui = await cardFor(db)
    expect(ui.entries[0]!.warnings).toEqual([])
  })

  it('ignores a commit that failed, since those hours never reached Zoho', async () => {
    const db = new FakeDb()
    seedIndex(db)
    db.commitLogs.push({
      id: 'commit_failed',
      userId: 'user_1',
      status: 'failed',
      projectId: '2620762000000790022',
      taskId: 'task_1',
      logDate: new Date('2026-07-21T00:00:00.000Z'),
      description: 'Structural review',
    })

    const ui = await cardFor(db)
    expect(ui.entries[0]!.warnings).toEqual([])
  })

  it('reads no commit log at all when nothing is proposed', async () => {
    const db = new FakeDb()
    seedIndex(db)
    const result = await runChatTurn(
      db.client,
      agentReturning({ kind: 'ask', message: 'Which project?', options: [] }),
      { ...turnInput, message: '8 hours yesterday' },
    )
    expect(result.ui.kind).toBe('question')
  })
})
