import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from '@/lib/zoho/client'
import type { DraftEntry } from '@/lib/resolve/entry'
import { blockedReason, entryState } from '@/lib/resolve/slots'
import {
  commitEntries,
  type CommitLogger,
  type CommittableEntry,
  type EntryOutcome,
} from './commit'

/**
 * Confirming and cancelling a draft (tasks 6.5, 6.6).
 *
 * **The draft is re-read from the database and the request body is never consulted.** A
 * confirmation is a tap on a card, not a submission of data: everything that will be written
 * was resolved server-side when the card was built, and accepting entry data from the client
 * would let a crafted request log eight hours to any project in the portal under someone
 * else's name. So the route takes an id and nothing else.
 *
 * A draft is committed **as far as it can go**. An entry that is still missing an answer, or
 * blocked outright, does not hold back the ones beside it — CHAT-3 requires exactly that: a
 * project with no task at all must not stop the rest of the day being logged.
 */

export type ConfirmRefusal =
  'not_found' | 'expired' | 'cancelled' | 'nothing_ready' | 'no_source_message'

export type SkippedEntry = {
  entryId: string
  state: 'needs_answer' | 'blocked'
  /** Present for blocked entries, where the answer is knowable and it is no. */
  reason: string | null
}

export type ConfirmResult =
  | {
      ok: true
      draftId: string
      /** Whether the draft is finished, or still has entries waiting on an answer. */
      draftStatus: 'confirmed' | 'pending'
      outcomes: EntryOutcome[]
      notCommitted: SkippedEntry[]
      created: number
      duplicates: number
      failed: number
      skipped: number
    }
  | { ok: false; refusal: ConfirmRefusal }

export type ConfirmInput = {
  userId: string
  draftId: string
  /** The person's Zoho `zuid`, so the log's owner is explicit in the request. */
  zohoUserId?: string | null
  now?: Date
  logger?: CommitLogger
}

export async function confirmDraft(
  db: PrismaClient,
  client: ZohoClient,
  input: ConfirmInput,
): Promise<ConfirmResult> {
  const now = input.now ?? new Date()

  // Scoped by `userId`, not merely checked afterwards: a draft belonging to someone else is
  // indistinguishable from one that does not exist, which is what it should look like.
  const draft = await db.draft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: {
      id: true,
      status: true,
      entries: true,
      expiresAt: true,
      conversationId: true,
      createdAt: true,
    },
  })
  if (!draft) return { ok: false, refusal: 'not_found' }
  if (draft.status === 'cancelled') return { ok: false, refusal: 'cancelled' }

  if (draft.status === 'pending' && draft.expiresAt <= now) {
    // A half-finished entry from three days ago is not something the user still means, and
    // confirming it silently would log time they have forgotten about.
    await db.draft.update({ where: { id: draft.id }, data: { status: 'expired' } })
    return { ok: false, refusal: 'expired' }
  }
  if (draft.status === 'expired') return { ok: false, refusal: 'expired' }

  const entries = draft.entries as unknown as DraftEntry[]
  const ready: DraftEntry[] = []
  const notCommitted: SkippedEntry[] = []

  for (const entry of entries) {
    const state = entryState(entry)
    if (state === 'ready') ready.push(entry)
    else notCommitted.push({ entryId: entry.id, state, reason: blockedReason(entry) })
  }

  if (ready.length === 0) return { ok: false, refusal: 'nothing_ready' }

  const sourceMessageId = await sourceMessageFor(
    db,
    draft.conversationId,
    draft.createdAt,
  )
  if (!sourceMessageId) return { ok: false, refusal: 'no_source_message' }

  const result = await commitEntries(
    db,
    client,
    {
      userId: input.userId,
      draftId: draft.id,
      sourceMessageId,
      ownerZuid: input.zohoUserId,
      entries: ready.map(toCommittable),
    },
    { now: () => now, logger: input.logger },
  )

  // Finished only when there is nothing left to do — an entry still awaiting an answer, or
  // one that failed and can be retried, means the draft stays open. A second confirmation
  // costs nothing: the already-written entries come back as duplicates without a Zoho call.
  const settled = notCommitted.length === 0 && result.failed === 0 && result.skipped === 0
  if (settled && draft.status === 'pending') {
    await db.draft.update({ where: { id: draft.id }, data: { status: 'confirmed' } })
  }

  return {
    ok: true,
    draftId: draft.id,
    draftStatus: settled ? 'confirmed' : 'pending',
    outcomes: result.outcomes,
    notCommitted,
    created: result.created,
    duplicates: result.duplicates,
    failed: result.failed,
    skipped: result.skipped,
  }
}

/**
 * A ready entry, flattened into what the pipeline writes.
 *
 * Every field is read off a `resolved` slot, so the narrowing is exhaustive rather than
 * defensive — `entryState` has already established there is nothing unresolved here.
 */
function toCommittable(entry: DraftEntry): CommittableEntry {
  if (
    entry.project.status !== 'resolved' ||
    entry.task.status !== 'resolved' ||
    entry.date.status !== 'resolved' ||
    entry.hours.status !== 'resolved' ||
    entry.description.status !== 'resolved'
  ) {
    throw new Error(`entry ${entry.id} is not ready`)
  }

  return {
    entryId: entry.id,
    projectId: entry.project.projectId,
    projectName: entry.project.projectName,
    taskId: entry.task.taskId,
    taskName: entry.task.taskName,
    date: entry.date.date,
    hours: entry.hours.hours,
    billable: entry.billable,
    description: entry.description.description,
  }
}

/**
 * The message this draft came from.
 *
 * `CommitLog.sourceMessageId` is the audit trail's link back to what the person actually
 * typed, so it is the last thing they said *before the draft existed* — not merely the most
 * recent message, which by confirm time could be an answer to a clarifying question.
 */
async function sourceMessageFor(
  db: PrismaClient,
  conversationId: string,
  draftCreatedAt: Date,
): Promise<string | null> {
  const message = await db.message.findFirst({
    where: { conversationId, role: 'user', createdAt: { lte: draftCreatedAt } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  return message?.id ?? null
}

export type CancelResult =
  | { ok: true; alreadyCancelled: boolean }
  | { ok: false; refusal: 'not_found' | 'already_committed' }

/**
 * Cancelling a draft.
 *
 * Idempotent, because the failure mode of a cancel button is a double tap and the second one
 * should not produce an error. A confirmed draft is refused rather than cancelled: cancelling
 * does not undo anything, and pretending otherwise would leave someone believing hours had
 * been removed from Zoho when they had not. Undo is a different action (task 6.7).
 */
export async function cancelDraft(
  db: PrismaClient,
  input: { userId: string; draftId: string },
): Promise<CancelResult> {
  const draft = await db.draft.findFirst({
    where: { id: input.draftId, userId: input.userId },
    select: { id: true, status: true },
  })
  if (!draft) return { ok: false, refusal: 'not_found' }
  if (draft.status === 'confirmed') return { ok: false, refusal: 'already_committed' }
  if (draft.status === 'cancelled') return { ok: true, alreadyCancelled: true }

  await db.draft.update({ where: { id: draft.id }, data: { status: 'cancelled' } })
  return { ok: true, alreadyCancelled: false }
}
