import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from '@/lib/zoho/client'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'
import { deleteTimeLog } from '@/lib/zoho/timelogs'
import { formatIso, parseIso, todayIn, compare } from '@/lib/resolve/civil-date'

/**
 * Undo (tasks 6.7, 6.10, CHAT-11).
 *
 * The app deletes **only what it created, only on the day it created it**. Everything else is
 * a correction, and corrections happen in Zoho Projects where there is an audit trail and a
 * person who meant to make them.
 *
 * "What it created" means a `CommitLog` row of its own with a Zoho log id in it. That is a
 * stronger guarantee than asking Zoho, because `added_via: "api"` would also match anything
 * else built against the same portal.
 *
 * **The guard does not key off `approval_status`.** Spike 1.4 found that every API-created log
 * comes back `Approved` with no human approving anything — the portal has approval disabled
 * entirely. Refusing on that field would disable undo completely, which is exactly the kind of
 * plausible-looking guard that would have shipped without the spike.
 */

export type UndoRefusal =
  | 'not_found'
  | 'not_today'
  | 'already_undone'
  | 'never_created'
  | 'no_log_id'
  | 'billed'
  | 'zoho_error'

export type UndoResult =
  | { ok: true; commitLogId: string; zohoLogId: string; alreadyUndone: false }
  | { ok: true; commitLogId: string; zohoLogId: string | null; alreadyUndone: true }
  | { ok: false; refusal: UndoRefusal; message: string }

export type UndoInput = {
  userId: string
  commitLogId: string
  /** The person's own zone — a day is only a day somewhere (task 5.10). */
  timezone: string
  /** ISO `YYYY-MM-DD`; undo refuses on or before it. Unset means no lock. */
  billingLockedThrough?: string | undefined
  now?: Date
}

const MESSAGES: Record<UndoRefusal, string> = {
  not_found: 'I have no record of logging that.',
  not_today:
    'I can only undo something on the day I logged it. Corrections after that happen in Zoho Projects.',
  already_undone: 'That one is already removed.',
  never_created: 'That entry never reached Zoho, so there is nothing to remove.',
  no_log_id:
    'Zoho did not tell me which log it created, so I cannot safely delete it. Remove it in Zoho Projects.',
  billed:
    'That day has already been invoiced. Removing it now has to go through billing.',
  zoho_error: 'Zoho would not delete that log. Nothing was changed.',
}

export async function undoEntry(
  db: PrismaClient,
  client: ZohoClient,
  input: UndoInput,
): Promise<UndoResult> {
  const now = input.now ?? new Date()

  // Scoped by `userId`: someone else's log is indistinguishable from one that does not exist.
  const row = await db.commitLog.findFirst({
    where: { id: input.commitLogId, userId: input.userId },
    select: {
      id: true,
      status: true,
      zohoLogId: true,
      projectId: true,
      taskId: true,
      logDate: true,
      completedAt: true,
      createdAt: true,
    },
  })
  if (!row) return refuse('not_found')

  // Idempotent, because the failure mode of an undo button is a double tap.
  if (row.status === 'undone') {
    return {
      ok: true,
      commitLogId: row.id,
      zohoLogId: row.zohoLogId,
      alreadyUndone: true,
    }
  }
  if (row.status !== 'success') return refuse('never_created')
  if (!row.zohoLogId) return refuse('no_log_id')

  // Same calendar day *as the commit*, in the person's own zone. Not the log's date:
  // backdating yesterday's hours this morning is undoable this morning.
  const committedAt = row.completedAt ?? row.createdAt
  const today = todayIn(input.timezone, now)
  if (formatIso(todayIn(input.timezone, committedAt)) !== formatIso(today)) {
    return refuse('not_today')
  }

  if (isBilled(row.logDate, input.billingLockedThrough)) return refuse('billed')

  try {
    await deleteTimeLog(client, {
      projectId: row.projectId,
      taskId: row.taskId,
      logId: row.zohoLogId,
    })
  } catch (error) {
    // The row is left `success`, which is what it still is — the log is in Zoho. Marking it
    // undone here would lose track of a log that was never deleted.
    console.warn(
      JSON.stringify({
        event: 'undo.failed',
        commitLogId: row.id,
        status: error instanceof ZohoHttpError ? error.status : null,
        kind:
          error instanceof ZohoRateLimitError
            ? 'rate_limited'
            : error instanceof ZohoAuthError
              ? 'credential'
              : 'http',
      }),
    )
    return refuse('zoho_error')
  }

  await db.commitLog.update({
    where: { id: row.id },
    data: { status: 'undone', completedAt: now },
  })

  return { ok: true, commitLogId: row.id, zohoLogId: row.zohoLogId, alreadyUndone: false }
}

/**
 * Is this log's date inside a period the invoice pipeline has already billed?
 *
 * Read from configuration, never from the billing database — this app has no business
 * connecting to it (design §2). The consequence of getting it wrong runs one way: deleting an
 * invoiced log orphans a pointer in `invoiced_logs`, and nothing downstream notices.
 */
function isBilled(logDate: Date, lockedThrough: string | undefined): boolean {
  if (!lockedThrough) return false
  const boundary = parseIso(lockedThrough)
  if (!boundary) return false
  // The stored column is a `date`, so its UTC components *are* the civil date.
  const logged = {
    year: logDate.getUTCFullYear(),
    month: logDate.getUTCMonth() + 1,
    day: logDate.getUTCDate(),
  }
  return compare(logged, boundary) <= 0
}

function refuse(refusal: UndoRefusal): UndoResult {
  return { ok: false, refusal, message: MESSAGES[refusal] }
}
