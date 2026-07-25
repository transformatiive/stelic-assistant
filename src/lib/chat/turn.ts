import type { PrismaClient } from '@/generated/prisma/client'
import type { Extractor, Usage } from '@/lib/extract/openrouter'
import type { ExtractedEntry } from '@/lib/extract/schema'
import {
  classifyExtractionFailure,
  logExtractionFailure,
  type DegradedOutcome,
} from '@/lib/extract/degraded'
import {
  buildSystemPrompt,
  windowConversation,
  type ChatMessage,
} from '@/lib/extract/prompt'
import { usageColumns } from '@/lib/extract/usage'
import {
  buildContinuationSystemPrompt,
  type ContinuationClassifier,
  type ContinuationDecision,
} from './continuation'
import { loadChargeCodes, loadProjectIndex } from '@/lib/index/store'
import {
  resolveEntries,
  todayFor,
  type DraftEntry,
  type ResolveContext,
  type SlotName,
} from '@/lib/resolve/entry'
import {
  applyAnswer,
  loadPendingDraft,
  saveDraft,
  updateDraftEntries,
  type StoredDraft,
} from '@/lib/resolve/draft'
import { nextQuestion, type Question } from '@/lib/resolve/slots'
import { warningsForDraft } from '@/lib/resolve/warnings'
import { log } from '@/lib/observability/log'
import { checkScope } from './scope'
import {
  questionText,
  questionUi,
  toCardEntry,
  totalHours,
  type ChatUi,
  type UndoCandidate,
} from './ui'

/** Used when no classifier is supplied — every reply is treated as a fresh message, exactly
 * the behaviour before continuation classification existed. Tests that don't care about a
 * pending draft can omit the parameter entirely. */
const ALWAYS_NEW_MESSAGE: ContinuationClassifier = {
  async classify() {
    return { decision: { intent: 'new_message' }, usage: { modelRequested: 'none' } }
  },
}

/**
 * One turn of the conversation (task 7.1, design §4).
 *
 * The order is deliberate and each step is cheap before the expensive one:
 *
 *   scope check → persist what they said → classify a pending draft → extract
 *     → **resolve deterministically** → respond
 *
 * The scope check comes first because an out-of-scope question should cost nothing. Persisting
 * the user's message comes before the model call because a turn that fails should still leave
 * a record of what they typed — otherwise a degraded turn loses the thing they said.
 *
 * When a draft is already waiting on an answer, a small, cheap model call decides whether this
 * reply belongs to it — answering the pending slot, or correcting any other value already in
 * the draft — before the more expensive full-sentence extraction ever runs. Only a message the
 * classifier calls unrelated (or a classifier failure) reaches the ordinary extraction path.
 *
 * **The model extracts; deterministic code decides.** Nothing the model returns becomes a
 * project, a date or a number of hours without going through the resolver, and nothing
 * reaches Zoho without a confirmation tap. That boundary is what makes prompt injection
 * uninteresting: the widest a crafted message can get is a draft card the user has to look at.
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
  extractor: Extractor,
  input: ChatTurnInput,
  classifier: ContinuationClassifier = ALWAYS_NEW_MESSAGE,
): Promise<ChatTurnResult> {
  const now = input.now ?? new Date()
  const conversationId = await openConversation(db, input.userId, now)
  const userMessage = await say(db, conversationId, 'user', input.message, now)

  // Before anything expensive, and before the model is given the chance to answer in its own
  // words: a refusal is the app's sentence, not a generated one.
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

  // A draft is already waiting on an answer: let the classifier decide whether this reply
  // belongs to it — answering the pending slot, or correcting any other value already in the
  // draft — before treating it as a brand-new message (CHAT-7). This is what lets "oh i meant
  // Turner" or "actually make it 6 hours" work as corrections rather than restarting the whole
  // extraction from scratch.
  const pendingDraft = await loadPendingDraft(db, input.userId, now)
  const pendingQuestion = pendingDraft ? nextQuestion(pendingDraft.entries) : null
  if (pendingDraft && pendingQuestion) {
    const continued = await continueDraft(
      db,
      classifier,
      conversationId,
      userMessage.id,
      pendingDraft,
      pendingQuestion,
      context,
      input,
      now,
    )
    if (continued) return continued
    // The classifier said this is unrelated, or the classifier itself failed — either way,
    // fall through and treat the message as a fresh one, exactly as before this existed.
  }

  let extraction
  let usage: Usage | null = null
  try {
    const result = await extractor.extract({
      systemPrompt: buildSystemPrompt({
        displayName: input.displayName,
        today: todayFor(context),
        timezone: input.timezone,
        recentProjects: recentProjectHints(context),
        defaultBillable: input.defaultBillable,
      }),
      messages: await history(db, conversationId, userMessage.id),
      userKey: input.userKey,
    })
    extraction = result.extraction
    usage = result.usage
  } catch (error) {
    const outcome = classifyExtractionFailure(error)
    logExtractionFailure(error, outcome)
    return guidedForm(db, conversationId, input, context, outcome, now)
  }

  if (extraction.kind === 'reply_only') {
    const assistant = await say(
      db,
      conversationId,
      'assistant',
      extraction.reply,
      now,
      usage,
    )
    return {
      conversationId,
      messageId: assistant.id,
      reply: extraction.reply,
      ui: await replyUi(db, input, extraction.intent, now),
    }
  }

  const entries = resolveEntries(extraction.entries, context)
  const draft = await saveDraft(
    db,
    { conversationId, userId: input.userId, entries },
    now,
  )
  const { reply, ui } = present(draft.id, entries, extraction.reply, input, context)

  const assistant = await say(db, conversationId, 'assistant', reply, now, usage, ui)
  return { conversationId, messageId: assistant.id, reply, ui }
}

/**
 * Whether this turn's message answers or corrects the draft already waiting on one, and if so,
 * applying it (CHAT-7).
 *
 * Returns `null` when the classifier says the message is unrelated, or when the classifier
 * itself fails — both mean "treat this as an ordinary fresh message", so the caller falls
 * through to the ordinary extraction path rather than getting a special error turn out of a
 * model that is not essential to answering at all (CHAT-13 applies here too).
 *
 * Every update still goes through `applyAnswer`, the exact same deterministic resolver a chip
 * tap uses — the classifier only ever supplies the user's own words for a slot, never a
 * resolved project id or calendar date, so a wrong classification can produce a wrong follow-up
 * question but never a wrong Zoho entry.
 */
async function continueDraft(
  db: PrismaClient,
  classifier: ContinuationClassifier,
  conversationId: string,
  throughMessageId: string,
  draft: StoredDraft,
  question: Question,
  context: ResolveContext,
  input: ChatTurnInput,
  now: Date,
): Promise<ChatTurnResult | null> {
  let decision: ContinuationDecision
  let usage: Usage | null = null
  try {
    const result = await classifier.classify({
      systemPrompt: buildContinuationSystemPrompt({
        displayName: input.displayName,
        today: todayFor(context),
        timezone: input.timezone,
        entries: draft.entries,
        pending: { entryId: question.entryId, slot: question.slot },
      }),
      messages: await history(db, conversationId, throughMessageId),
      userKey: input.userKey,
    })
    decision = result.decision
    usage = result.usage
  } catch (error) {
    logExtractionFailure(error, classifyExtractionFailure(error))
    return null
  }

  if (decision.intent === 'new_message') return null

  const updated = decision.updates.reduce(
    (entries, update) => applyAnswer(entries, update, context),
    draft.entries,
  )
  await updateDraftEntries(db, draft.id, updated)

  const { reply, ui } = present(draft.id, updated, null, input, context)
  const assistant = await say(db, conversationId, 'assistant', reply, now, usage, ui)
  return { conversationId, messageId: assistant.id, reply, ui }
}

/**
 * Answering one slot from a chip tap (task 7.2).
 *
 * No model call: the value is a server-issued id and the slot is already known, so a round
 * trip would add latency and cost for nothing. It also means chip taps keep working when the
 * gateway is down, which is the whole point of the guided form. A typed reply, which is not
 * unambiguous the way a chip is, goes through `runChatTurn`'s continuation classifier instead.
 */
export type ChatActionInput = {
  userId: string
  draftId: string
  entryId: string
  slot: SlotName
  value: string
  timezone: string
  now?: Date
  defaultBillable: boolean
  backdateWarnDays: number
  /** What the user sees in the transcript for their tap. */
  echo?: string
}

export type ChatActionResult =
  | { ok: true; conversationId: string; messageId: string; reply: string; ui: ChatUi }
  | { ok: false; reply: string; ui: ChatUi }

const STALE_REPLY = 'That option is no longer available.'

export async function runChatAction(
  db: PrismaClient,
  input: ChatActionInput,
): Promise<ChatActionResult> {
  const now = input.now ?? new Date()

  const draft = await db.draft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: {
      id: true,
      conversationId: true,
      status: true,
      entries: true,
      expiresAt: true,
    },
  })

  // Stale-action guard (task 7.3, PWA-4 "Stale options"). Someone scrolling back and tapping
  // an old chip must not silently rewrite an answered slot — or worse, resurrect a draft they
  // already cancelled. Nothing is changed and nothing reaches Zoho.
  if (!draft || draft.status !== 'pending' || draft.expiresAt <= now) {
    return stale(db, input, now, draft?.conversationId)
  }

  const entries = draft.entries as unknown as DraftEntry[]
  const target = entries.find((entry) => entry.id === input.entryId)
  // Already answered, or answered and then re-resolved into a different shape. Either way the
  // chip the user tapped belongs to a question that is over.
  if (!target || target[input.slot].status !== 'unresolved') {
    return stale(db, input, now, draft.conversationId)
  }

  const context = await buildContext(db, input, now)
  const updated = applyAnswer(
    entries,
    { entryId: input.entryId, slot: input.slot, value: input.value },
    context,
  )
  await updateDraftEntries(db, draft.id, updated)

  if (input.echo) await say(db, draft.conversationId, 'user', input.echo, now)

  const { reply, ui } = present(draft.id, updated, null, input, context)
  const assistant = await say(db, draft.conversationId, 'assistant', reply, now, null, ui)

  return {
    ok: true,
    conversationId: draft.conversationId,
    messageId: assistant.id,
    reply,
    ui,
  }
}

/**
 * Refuse a stale action, and re-state the current question rather than leaving a dead end.
 *
 * The user tapped something; they are owed an answer about where the conversation actually
 * is, not just a "no".
 */
async function stale(
  db: PrismaClient,
  input: ChatActionInput,
  now: Date,
  conversationId: string | undefined,
): Promise<ChatActionResult> {
  log.info('chat.stale_action', { userId: input.userId, slot: input.slot })

  const live = await loadPendingDraft(db, input.userId, now)
  if (!live) return { ok: false, reply: STALE_REPLY, ui: { kind: 'none' } }

  const question = nextQuestion(live.entries)
  if (!question) {
    const context = await buildContext(db, input, now)
    const { reply, ui } = present(live.id, live.entries, null, input, context)
    return { ok: false, reply: `${STALE_REPLY} ${reply}`, ui }
  }

  const entry = live.entries.find((e) => e.id === question.entryId)!
  const reply = `${STALE_REPLY} ${questionText(entry, question.slot)}`
  if (conversationId) await say(db, conversationId, 'assistant', reply, now)
  return { ok: false, reply, ui: questionUi(live.id, entry, question.slot) }
}

/**
 * The reply and the UI for a draft, whichever state it is in.
 *
 * One question at a time, in entry order — jumping between entries ("which project for
 * Monday? and for Tuesday? and how long on Monday?") is how a two-entry conversation becomes
 * confusing. Only when nothing is left to ask does the confirmation card appear.
 */
function present(
  draftId: string,
  entries: readonly DraftEntry[],
  modelReply: string | null,
  input: { backdateWarnDays: number; timezone: string },
  context: ResolveContext,
): { reply: string; ui: ChatUi } {
  const question = nextQuestion(entries)
  if (question) {
    const entry = entries.find((e) => e.id === question.entryId)!
    return {
      reply: questionText(entry, question.slot),
      ui: questionUi(draftId, entry, question.slot),
    }
  }

  const warnings = warningsForDraft(entries, {
    today: todayFor(context),
    backdateWarnDays: input.backdateWarnDays,
  })

  return {
    // The model's sentence when there is one — it quotes the user back, which reads better
    // than anything fixed. The card underneath is what they actually check.
    reply: modelReply ?? 'Here’s what I have.',
    ui: {
      kind: 'confirmation',
      draftId,
      entries: entries.map((entry) => toCardEntry(entry, warnings.get(entry.id) ?? [])),
      totalHours: totalHours(entries),
    },
  }
}

/**
 * The model is unavailable, so ask the slots one at a time instead (CHAT-13).
 *
 * A blank draft rather than a special mode: the same resolver, the same draft, the same
 * commit pipeline with the same guarantees. The only difference is that no model was involved
 * in reading the first message — and the user's words are not thrown away, they become the
 * project query, which the deterministic matcher can often resolve on its own.
 */
async function guidedForm(
  db: PrismaClient,
  conversationId: string,
  input: ChatTurnInput,
  context: ResolveContext,
  outcome: DegradedOutcome,
  now: Date,
): Promise<ChatTurnResult> {
  const blank: ExtractedEntry = {
    project_query: input.message.trim() || '?',
    date_expression: null,
    hours: null,
    description: null,
    billable: null,
    charge_code_hint: null,
  }

  const entries = resolveEntries([blank], context)
  const draft = await saveDraft(
    db,
    { conversationId, userId: input.userId, entries },
    now,
  )
  const { reply: question, ui } = present(draft.id, entries, null, input, context)

  const reply = `${outcome.message} ${question}`
  const assistant = await say(db, conversationId, 'assistant', reply, now, null, ui)

  return {
    conversationId,
    messageId: assistant.id,
    reply,
    ui,
    degraded: outcome.reason,
  }
}

/** What a `reply_only` turn should put on screen alongside the sentence. */
async function replyUi(
  db: PrismaClient,
  input: { userId: string; timezone: string },
  intent: 'question' | 'week_summary' | 'undo' | 'smalltalk',
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
 * Project hints for the prompt — **names only**.
 *
 * Recently logged first, because those are the words the person is most likely to use. No
 * ids, no rates, no client identifiers beyond the account name that already appears in the
 * project's own title (design §4.1).
 */
function recentProjectHints(
  context: ResolveContext,
): { projectName: string; accountName?: string | null }[] {
  return [...context.index]
    .sort((a, b) => (b.lastLoggedAt ?? '').localeCompare(a.lastLoggedAt ?? ''))
    .slice(0, 8)
    .map((project) => ({
      projectName: project.projectName,
      accountName: project.accountName,
    }))
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
 * The turns the model sees.
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
