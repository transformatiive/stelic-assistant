import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from '@/lib/zoho/client'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'
import { createTask, findTaskByName } from '@/lib/zoho/projects'
import { createTimeLog } from '@/lib/zoho/timelogs'
import { idempotencyKey } from './idempotency'

/**
 * Writing a confirmed draft into Zoho (tasks 6.1–6.4, CHAT-10).
 *
 * Two rules shape everything here, and both exist because the failure mode of a timesheet is
 * not "nothing happened" — it is **hours logged twice**.
 *
 * 1. **Write the ledger row before the call, update it after.** If the process dies mid-call
 *    the row survives as `pending`, which says "a log may exist in Zoho for this". A row
 *    written afterwards would leave a created log with no record of it at all.
 *
 * 2. **An unparseable success is still a success.** Zoho accepted the write; only our handle
 *    on the new log is missing. Recording that as a failure invites a retry that books the
 *    hours a second time.
 *
 * Entries are committed one at a time, in order, and a failure on one does not abandon the
 * rest — four entries where the second fails should log three, not one. The exceptions are
 * rate limiting and an expired credential, which will hit every remaining entry identically;
 * those stop the run and the untried entries come back as `skipped`, honestly labelled, for
 * the retry-failed-only path.
 */

export type CommittableEntry = {
  /** The draft entry's own id, so a result can be matched back to a card. */
  entryId: string
  projectId: string
  projectName: string
  /**
   * `null` for a task the user asked to add (CHAT-7): the pipeline finds an existing task of
   * this name on the project — a retry after "task created, log failed", or one added in the
   * Zoho UI since the index refreshed — and creates it only when none exists.
   */
  taskId: string | null
  taskName: string
  /** ISO `YYYY-MM-DD` in the user's timezone. */
  date: string
  hours: number
  billable: boolean
  description: string
}

export type CommitFailure =
  'credential' | 'rate_limited' | 'zoho_error' | 'in_flight' | 'unknown'

export type EntryOutcome =
  | {
      entryId: string
      status: 'created'
      commitLogId: string
      /** `null` when Zoho accepted the write but its response could not be parsed. */
      zohoLogId: string | null
    }
  | {
      entryId: string
      status: 'duplicate'
      commitLogId: string
      zohoLogId: string | null
    }
  | {
      entryId: string
      status: 'failed'
      commitLogId: string | null
      reason: CommitFailure
      detail: string
    }
  | { entryId: string; status: 'skipped'; reason: CommitFailure; detail: string }

export type CommitResult = {
  outcomes: EntryOutcome[]
  created: number
  duplicates: number
  failed: number
  skipped: number
}

export type CommitInput = {
  userId: string
  draftId: string
  sourceMessageId: string
  /** The person's Zoho `zuid`, when known — see `createTimeLog`. */
  ownerZuid?: string | null
  entries: readonly CommittableEntry[]
  /**
   * Stamps the billing role onto a created log (task 6.12).
   *
   * Optional and best-effort: a log with no role is a reporting gap, and refusing to log
   * someone's hours because a custom field could not be written would be a far worse trade.
   */
  stampRole?: (entry: CommittableEntry, zohoLogId: string) => Promise<void>
}

export interface CommitLogger {
  info(event: string, fields: Record<string, unknown>): void
  warn(event: string, fields: Record<string, unknown>): void
}

const silent: CommitLogger = { info: () => {}, warn: () => {} }

export async function commitEntries(
  db: PrismaClient,
  client: ZohoClient,
  input: CommitInput,
  options: { now?: () => Date; logger?: CommitLogger } = {},
): Promise<CommitResult> {
  const now = options.now ?? (() => new Date())
  const logger = options.logger ?? silent
  const outcomes: EntryOutcome[] = []

  let halted: { reason: CommitFailure; detail: string } | null = null

  for (const entry of input.entries) {
    if (halted) {
      outcomes.push({ entryId: entry.entryId, status: 'skipped', ...halted })
      continue
    }

    // A new task has no id yet, so the booking is keyed (and the ledger row written) under a
    // name-derived placeholder — stable across retries, which is what the double-book guard
    // hangs on. The real id replaces it the moment the task exists.
    const claimedTaskId = entry.taskId ?? `new:${entry.taskName.trim().toLowerCase()}`

    const key = idempotencyKey({
      userId: input.userId,
      projectId: entry.projectId,
      taskId: claimedTaskId,
      logDate: entry.date,
      hours: entry.hours,
      description: entry.description,
    })

    const claim = await claimRow(db, key, input, entry, claimedTaskId, now())

    if (claim.kind === 'settled') {
      outcomes.push(claim.outcome)
      continue
    }

    const commitLogId = claim.commitLogId

    try {
      let taskId = entry.taskId
      if (taskId === null) {
        // Find-or-create, in that order: a retry after "task created, log failed" must reuse
        // the first attempt's task, and a same-named task added in the Zoho UI since the
        // index refreshed should be used rather than duplicated.
        const existing = await findTaskByName(client, entry.projectId, entry.taskName)
        const task =
          existing ?? (await createTask(client, entry.projectId, entry.taskName))
        taskId = task.id
        logger.info(existing ? 'commit.task_reused' : 'commit.task_created', {
          commitLogId,
          projectId: entry.projectId,
          taskId,
        })
        // The ledger row now names the real task, which is also what undo deletes against.
        await db.commitLog.update({ where: { id: commitLogId }, data: { taskId } })
      }

      const result = await createTimeLog(client, {
        projectId: entry.projectId,
        taskId,
        date: entry.date,
        hours: entry.hours,
        billable: entry.billable,
        notes: entry.description,
        ownerZuid: input.ownerZuid,
      })

      await db.commitLog.update({
        where: { id: commitLogId },
        data: {
          status: 'success',
          zohoLogId: result.log?.id ?? null,
          zohoResponse: result.raw as object,
          errorMessage: null,
          completedAt: now(),
        },
      })

      if (!result.log) {
        // Loud, because it means undo is unavailable for this entry and the parser needs a
        // shape it has not seen. Not an error for the user: their hours are logged.
        logger.warn('commit.log_id_unreadable', {
          commitLogId,
          projectId: entry.projectId,
        })
      } else if (input.stampRole) {
        // After the row says `success`, and swallowing its own failure. The hours are in
        // Zoho either way; the role is metadata for the invoice pipeline's benefit, and
        // nothing about it is worth turning a logged day into a failed one. The entry carries
        // the *resolved* task id — for a just-created task, the one Zoho assigned.
        try {
          await input.stampRole({ ...entry, taskId }, result.log.id)
        } catch (error) {
          logger.warn('commit.role_stamp_failed', {
            commitLogId,
            error: error instanceof Error ? error.name : 'unknown',
          })
        }
      }

      outcomes.push({
        entryId: entry.entryId,
        status: 'created',
        commitLogId,
        zohoLogId: result.log?.id ?? null,
      })
    } catch (error) {
      const { reason, detail } = describe(error)

      await db.commitLog.update({
        where: { id: commitLogId },
        data: { status: 'failed', errorMessage: detail, completedAt: now() },
      })

      logger.warn('commit.entry_failed', { commitLogId, reason })
      outcomes.push({
        entryId: entry.entryId,
        status: 'failed',
        commitLogId,
        reason,
        detail,
      })

      // These do not vary per entry, so trying the rest would spend a locked-out quota or a
      // dead token fifteen more times and report fifteen identical failures.
      if (reason === 'rate_limited' || reason === 'credential')
        halted = { reason, detail }
    }
  }

  const result: CommitResult = {
    outcomes,
    created: outcomes.filter((o) => o.status === 'created').length,
    duplicates: outcomes.filter((o) => o.status === 'duplicate').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    skipped: outcomes.filter((o) => o.status === 'skipped').length,
  }

  logger.info('commit.finished', {
    userId: input.userId,
    draftId: input.draftId,
    created: result.created,
    duplicates: result.duplicates,
    failed: result.failed,
    skipped: result.skipped,
  })

  return result
}

type Claim =
  { kind: 'claimed'; commitLogId: string } | { kind: 'settled'; outcome: EntryOutcome }

/**
 * Take ownership of one booking, or discover somebody already has.
 *
 * The unique constraint on `idempotency_key` is what makes a double tap safe: the second
 * insert loses, and losing is how we learn the booking already exists rather than by asking
 * Zoho. What happens next depends on how the first attempt ended:
 *
 * - **success** — already logged. Report it, do not call Zoho.
 * - **pending** — a call is in flight, or a previous one died mid-call. Either way a second
 *   call could double-book, so it is reported rather than retried. A human undoing the
 *   orphan is recoverable; two invoiced logs are not.
 * - **failed** or **undone** — nothing is in Zoho. Reclaim the row and try again; `undone`
 *   is a person deliberately re-logging something they removed.
 */
async function claimRow(
  db: PrismaClient,
  key: string,
  input: CommitInput,
  entry: CommittableEntry,
  claimedTaskId: string,
  at: Date,
): Promise<Claim> {
  const data = {
    draftId: input.draftId,
    userId: input.userId,
    idempotencyKey: key,
    projectId: entry.projectId,
    projectName: entry.projectName,
    taskId: claimedTaskId,
    taskName: entry.taskName,
    logDate: new Date(`${entry.date}T00:00:00.000Z`),
    hoursDecimal: entry.hours,
    billable: entry.billable,
    description: entry.description,
    sourceMessageId: input.sourceMessageId,
  }

  try {
    const row = await db.commitLog.create({ data, select: { id: true } })
    return { kind: 'claimed', commitLogId: row.id }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  const existing = await db.commitLog.findUnique({
    where: { idempotencyKey: key },
    select: { id: true, status: true, zohoLogId: true },
  })

  // Gone between the insert and the read — a cancelled draft cascading. Treating it as
  // unknown is safer than a third attempt at the same race.
  if (!existing) {
    return {
      kind: 'settled',
      outcome: {
        entryId: entry.entryId,
        status: 'failed',
        commitLogId: null,
        reason: 'unknown',
        detail: 'That entry could not be claimed. Try again.',
      },
    }
  }

  if (existing.status === 'success') {
    return {
      kind: 'settled',
      outcome: {
        entryId: entry.entryId,
        status: 'duplicate',
        commitLogId: existing.id,
        zohoLogId: existing.zohoLogId,
      },
    }
  }

  if (existing.status === 'pending') {
    return {
      kind: 'settled',
      outcome: {
        entryId: entry.entryId,
        status: 'failed',
        commitLogId: existing.id,
        reason: 'in_flight',
        detail: 'That entry is already being logged. Give it a moment.',
      },
    }
  }

  await db.commitLog.update({
    where: { id: existing.id },
    data: {
      ...data,
      status: 'pending',
      errorMessage: null,
      zohoLogId: null,
      zohoResponse: undefined,
      completedAt: null,
      createdAt: at,
    },
  })
  return { kind: 'claimed', commitLogId: existing.id }
}

/** Prisma's unique-constraint code, without importing its runtime error class. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/**
 * A failure the user can act on, with nothing in it that a log or a screen should not carry.
 *
 * Zoho's error bodies quote back the notes and can name a client, so the body never reaches
 * either — only the status, and only where it helps someone diagnose.
 */
function describe(error: unknown): { reason: CommitFailure; detail: string } {
  if (error instanceof ZohoRateLimitError) {
    return {
      reason: 'rate_limited',
      detail:
        'Zoho is rate limiting right now. Nothing was logged for this one — try again shortly.',
    }
  }
  if (error instanceof ZohoAuthError) {
    return {
      reason: 'credential',
      detail: 'Your Zoho sign-in has expired. Sign in again and retry.',
    }
  }
  if (error instanceof ZohoHttpError) {
    return { reason: 'zoho_error', detail: `Zoho rejected this entry (${error.status}).` }
  }
  return { reason: 'unknown', detail: 'This entry could not be logged.' }
}
