import type { PrismaClient } from '@/generated/prisma/client'
import type { Usage } from '@/lib/extract/openrouter'
import {
  classifyExtractionFailure,
  logExtractionFailure,
  type DegradedOutcome,
} from '@/lib/extract/degraded'
import { windowConversation, type ChatMessage } from '@/lib/extract/prompt'
import { usageColumns } from '@/lib/extract/usage'
import { buildAgentPrompt, type Agent } from './agent'
import { loadChargeCodes, loadProjectIndex } from '@/lib/index/store'
import { todayFor, type DraftEntry, type ResolveContext } from '@/lib/resolve/entry'
import { saveDraft } from '@/lib/resolve/draft'
import { warningsForDraft, type ExistingLog } from '@/lib/resolve/warnings'
import { log } from '@/lib/observability/log'
import { checkScope } from './scope'
import { toCardEntry, totalHours, type ChatUi, type UndoCandidate } from './ui'

/**
 * One turn of the conversation (task 7.1, CHAT-7).
 *
 *   scope check → persist what they said → **run the agent** → respond
 *
 * The agent owns the conversation now; what is left here is everything that must not depend
 * on a model behaving well: the out-of-scope refusal (the app's sentence, not a generated
 * one), the record of what the user typed, the draft that a confirmation tap later commits,
 * and the guided fallback for when the gateway is down.
 *
 * **The agent's most powerful move is putting a card on the screen.** It cannot write to
 * Zoho, cannot invent a project id, and cannot decide what a date means — see `agent.ts`.
 */

export type ChatTurnResult = {
  conversationId: string
  /** The assistant message, so the client can key off it. */
  messageId: string
  reply: string
  ui: ChatUi
  /** Present when the model was unavailable and the guided form took over. */
  degraded?: DegradedOutcome['reason']
}

export type ChatTurnInput = {
  userId: string
  displayName?: string | null
  timezone: string
  message: string
  now?: Date
  defaultBillable: boolean
  backdateWarnDays: number
  /** Opaque per-user handle for gateway attribution. Never the email. */
  userKey: string
}

/** How long a conversation stays open before a new message starts a fresh one. */
export const CONVERSATION_IDLE_MS = 12 * 60 * 60 * 1000

export async function runChatTurn(
  db: PrismaClient,
  agent: Agent,
  input: ChatTurnInput,
): Promise<ChatTurnResult> {
  const now = input.now ?? new Date()
  const conversationId = await openConversation(db, input.userId, now)
  const userMessage = await say(db, conversationId, 'user', input.message, now)

  // Before anything expensive, and before the model is given the chance to answer in its own
  // words: a refusal is the app's sentence, not a generated one. The agent is told the same
  // rule, so an out-of-scope request that gets past this guard is still declined — but this
  // one costs nothing and cannot be talked out of.
  const scope = checkScope(input.message)
  if (!scope.inScope) {
    const assistant = await say(db, conversationId, 'assistant', scope.reply, now)
    log.info('chat.out_of_scope', { topic: scope.topic, userId: input.userId })
    return {
      conversationId,
      messageId: assistant.id,
      reply: scope.reply,
      ui: { kind: 'none' },
    }
  }

  const context = await buildContext(db, input, now)

  let outcome
  let usage: Usage | null = null
  try {
    const result = await agent.run({
      systemPrompt: buildAgentPrompt({
        displayName: input.displayName,
        today: todayFor(context),
        timezone: input.timezone,
        defaultBillable: input.defaultBillable,
      }),
      messages: await history(db, conversationId, userMessage.id),
      userKey: input.userKey,
      context,
    })
    outcome = result.outcome
    usage = result.usage
  } catch (error) {
    const degraded = classifyExtractionFailure(error)
    logExtractionFailure(error, degraded)
    const assistant = await say(db, conversationId, 'assistant', degraded.message, now)
    return {
      conversationId,
      messageId: assistant.id,
      reply: degraded.message,
      ui: { kind: 'none' },
      degraded: degraded.reason,
    }
  }

  log.info('chat.turn', {
    userId: input.userId,
    outcome: outcome.kind,
    ...(outcome.kind === 'propose' ? { entries: outcome.entries.length } : {}),
    ...(outcome.kind === 'say' ? { intent: outcome.intent } : {}),
  })

  if (outcome.kind === 'ask') {
    const ui: ChatUi = { kind: 'question', options: outcome.options }
    const assistant = await say(
      db,
      conversationId,
      'assistant',
      outcome.message,
      now,
      usage,
      ui,
    )
    return { conversationId, messageId: assistant.id, reply: outcome.message, ui }
  }

  if (outcome.kind === 'say') {
    const ui = await replyUi(db, input, outcome.intent, now)
    const assistant = await say(
      db,
      conversationId,
      'assistant',
      outcome.message,
      now,
      usage,
      ui,
    )
    return { conversationId, messageId: assistant.id, reply: outcome.message, ui }
  }

  const draft = await saveDraft(
    db,
    { conversationId, userId: input.userId, entries: outcome.entries },
    now,
  )
  const warnings = warningsForDraft(outcome.entries, {
    today: todayFor(context),
    backdateWarnDays: input.backdateWarnDays,
    existingLogs: await alreadyLoggedOn(db, input.userId, outcome.entries),
  })
  const ui: ChatUi = {
    kind: 'confirmation',
    draftId: draft.id,
    entries: outcome.entries.map((entry) =>
      toCardEntry(entry, warnings.get(entry.id) ?? []),
    ),
    totalHours: totalHours(outcome.entries),
  }

  const assistant = await say(
    db,
    conversationId,
    'assistant',
    outcome.message,
    now,
    usage,
    ui,
  )
  return { conversationId, messageId: assistant.id, reply: outcome.message, ui }
}

/**
 * What this user has already logged on the days this draft covers.
 *
 * Without it `warningsForDraft` compares every entry against an empty list, so the
 * possible-duplicate warning could never fire however many times somebody re-sent the same
 * sentence — the code existed and was unit-tested, but nothing ever handed it the one input
 * it needed.
 *
 * Read from our own `CommitLog` rather than from Zoho. The duplicate this catches is almost
 * always a person re-submitting the same turn, and a per-task Zoho read would spend the
 * 100-calls-per-120-seconds budget on a check that runs before *every* confirmation card.
 * The cost is that hours logged in Zoho's own UI are invisible here: this misses some
 * duplicates, but it never warns about one that is not there.
 */
async function alreadyLoggedOn(
  db: PrismaClient,
  userId: string,
  entries: readonly DraftEntry[],
): Promise<ExistingLog[]> {
  const dates = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.date.status === 'resolved' ? [entry.date.date] : [],
      ),
    ),
  ]
  if (dates.length === 0) return []

  const rows = await db.commitLog.findMany({
    where: {
      userId,
      status: 'success',
      // Matches the `@@index([userId, logDate])`, and `log_date` is a DATE column, so these
      // are the same UTC midnights `commit.ts` writes.
      logDate: { in: dates.map((date) => new Date(`${date}T00:00:00.000Z`)) },
    },
    select: {
      id: true,
      projectId: true,
      taskId: true,
      logDate: true,
      description: true,
    },
  })

  return rows.map((row) => ({
    logId: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    date: row.logDate.toISOString().slice(0, 10),
    description: row.description,
  }))
}

/** What a conversational reply should put on screen alongside the sentence. */
async function replyUi(
  db: PrismaClient,
  input: { userId: string; timezone: string },
  intent: 'smalltalk' | 'week_summary' | 'undo' | 'refusal',
  now: Date,
): Promise<ChatUi> {
  if (intent === 'week_summary') return { kind: 'week' }
  if (intent !== 'undo') return { kind: 'none' }

  // Only what undo would actually accept: this app's own successful writes, from today.
  // Offering anything else would produce a button that refuses when tapped.
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const rows = await db.commitLog.findMany({
    where: { userId: input.userId, status: 'success', completedAt: { gte: since } },
    orderBy: { completedAt: 'desc' },
    take: 5,
    select: {
      id: true,
      projectName: true,
      taskName: true,
      logDate: true,
      hoursDecimal: true,
    },
  })

  const candidates: UndoCandidate[] = rows.map((row) => ({
    commitLogId: row.id,
    projectName: row.projectName,
    taskName: row.taskName,
    date: row.logDate.toISOString().slice(0, 10),
    hours: Number(row.hoursDecimal),
  }))

  return { kind: 'undo', candidates }
}

async function buildContext(
  db: PrismaClient,
  input: { userId: string; timezone: string; defaultBillable: boolean },
  now: Date,
): Promise<ResolveContext> {
  const [index, chargeCodes] = await Promise.all([
    loadProjectIndex(db, input.userId, { now }),
    loadChargeCodes(db),
  ])
  return {
    index,
    chargeCodes,
    timezone: input.timezone,
    now,
    defaultBillable: input.defaultBillable,
  }
}

/**
 * The conversation this message belongs to.
 *
 * Reused while it is still warm, so "make that 6 hours" finds yesterday's context if
 * yesterday was an hour ago — and a fresh one after a long gap, so Monday morning does not
 * open with Friday afternoon's half-finished entry in the window.
 */
async function openConversation(
  db: PrismaClient,
  userId: string,
  now: Date,
): Promise<string> {
  const cutoff = new Date(now.getTime() - CONVERSATION_IDLE_MS)
  const recent = await db.conversation.findFirst({
    where: { userId, lastMessageAt: { gte: cutoff } },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  })
  if (recent) return recent.id

  const created = await db.conversation.create({
    data: { userId, startedAt: now },
    select: { id: true },
  })
  return created.id
}

async function say(
  db: PrismaClient,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  now: Date,
  usage?: Usage | null,
  ui?: ChatUi,
): Promise<{ id: string }> {
  const message = await db.message.create({
    data: {
      conversationId,
      role,
      content,
      createdAt: now,
      ...(ui ? { uiPayload: ui as unknown as object } : {}),
      ...usageColumns(usage),
    },
    select: { id: true },
  })
  await db.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: now },
  })
  return message
}

/**
 * The turns the agent sees.
 *
 * Excludes the message just written, which is passed separately — including it twice would
 * have the model reading the user's sentence as both history and the current turn.
 */
async function history(
  db: PrismaClient,
  conversationId: string,
  throughMessageId: string,
): Promise<ChatMessage[]> {
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, role: true, content: true },
  })

  const upTo = rows.findIndex((row) => row.id === throughMessageId)
  const kept = upTo === -1 ? rows : rows.slice(0, upTo + 1)

  return windowConversation(
    kept.map((row) => ({ role: row.role as 'user' | 'assistant', content: row.content })),
  )
}
