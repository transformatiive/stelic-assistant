import type { PrismaClient } from '@/generated/prisma/client'
import type { IndexedProject } from './match'
import type { IndexedProjectRow } from './build'

/**
 * Persisting the project index (task 3.4).
 *
 * The index is per user, because recency is per user — the same portal ranks differently for
 * a designer and a project manager. Everything except `lastLoggedAt` is identical across
 * users, and duplicating it costs a few hundred rows per person; that is cheap next to the
 * join it would otherwise take on every message.
 */

/** How long an index is trusted before a refresh is due (task 3.4: hourly). */
export const INDEX_TTL_MS = 60 * 60 * 1000

/**
 * Floor between rebuilds, whatever else is true.
 *
 * Without it, the "no charge codes" rule below would rebuild on every page load for a portal
 * that genuinely has no tasks anywhere — turning a rare edge case into a rate-limit problem.
 */
export const INDEX_MIN_RETRY_MS = 5 * 60 * 1000

export async function saveProjectIndex(
  db: PrismaClient,
  userId: string,
  rows: readonly IndexedProjectRow[],
  now: Date = new Date(),
): Promise<{ written: number; removed: number }> {
  for (const row of rows) {
    const data = {
      projectName: row.projectName,
      projectIdString: row.projectId,
      crmDealId: row.crmDealId,
      dealName: row.dealName,
      accountName: row.accountName,
      aliases: row.aliases,
      chargeCodes: row.chargeCodes,
      refreshedAt: now,
    }
    await db.projectIndex.upsert({
      where: { userId_projectId: { userId, projectId: row.projectId } },
      // `lastLoggedAt` is deliberately absent from both branches: it is this user's own
      // history, computed separately, and a portal refresh must not wipe it.
      create: { userId, projectId: row.projectId, ...data },
      update: data,
    })
  }

  // Anything not in this build is gone from the portal, or newly closed. Leaving it behind
  // would let the matcher keep offering a project nobody can log to.
  const { count } = await db.projectIndex.deleteMany({
    where: { userId, projectId: { notIn: rows.map((r) => r.projectId) } },
  })

  return { written: rows.length, removed: count }
}

/**
 * This user's most recent log per project (task 3.3).
 *
 * Derived from `CommitLog` — this app's own record of what it wrote — rather than from Zoho.
 * The portal-wide range read that would give the full 60-day history is not available: both
 * documented forms return `6891 "Given URL is wrong"` (design §5, task 6.11). The verified
 * alternative is a per-task read, and walking every task of 145 projects is far outside a
 * 100-calls-per-120-seconds budget for a signal that only breaks ties.
 *
 * So recency starts empty for a new user and sharpens as they use the bot. That is a real
 * limitation with a real consequence — someone's first week gets no recency nudge — and it
 * is the right trade until 6.11 establishes a contract. It is not silently degraded: the
 * matcher caps recency at 0.10, below the 0.15 resolve gap, so its absence can only cost a
 * tie-break, never a correct match.
 */
export async function refreshRecency(
  db: PrismaClient,
  userId: string,
  windowDays = 60,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - windowDays * 86_400_000)

  const recent = await db.commitLog.groupBy({
    by: ['projectId'],
    where: { userId, status: 'success', logDate: { gte: since } },
    _max: { logDate: true },
  })

  let updated = 0
  for (const row of recent) {
    const lastLoggedAt = row._max?.logDate
    if (!lastLoggedAt) continue
    const { count } = await db.projectIndex.updateMany({
      where: { userId, projectId: row.projectId },
      data: { lastLoggedAt },
    })
    updated += count
  }
  return updated
}

/** The index in the shape the matcher takes. */
export async function loadProjectIndex(
  db: PrismaClient,
  userId: string,
): Promise<IndexedProject[]> {
  const rows = await db.projectIndex.findMany({
    where: { userId },
    select: {
      projectId: true,
      projectName: true,
      accountName: true,
      dealName: true,
      aliases: true,
      lastLoggedAt: true,
    },
  })

  return rows.map((row) => ({
    projectId: row.projectId,
    projectName: row.projectName,
    accountName: row.accountName,
    dealName: row.dealName,
    aliases: row.aliases,
    // The matcher compares civil dates, not instants — a log belongs to a day, not a moment.
    lastLoggedAt: row.lastLoggedAt ? row.lastLoggedAt.toISOString().slice(0, 10) : null,
  }))
}

/**
 * Whether the index needs rebuilding (task 3.4: build on login, refresh hourly).
 *
 * Age is not the only way an index goes bad. A rebuild in which **every** task read failed
 * produces an index that is fresh by timestamp and useless in substance — it can match a
 * project but has no charge code to log against. That happened live: 145 projects indexed,
 * 145 task reads rejected, and the next hour spent trusting the result.
 *
 * So an index with no charge codes anywhere is treated as stale, subject to a five-minute
 * floor so a portal that genuinely has no tasks does not rebuild on every page load.
 */
export async function isIndexStale(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const newest = await db.projectIndex.findFirst({
    where: { userId },
    orderBy: { refreshedAt: 'desc' },
    select: { refreshedAt: true },
  })
  if (!newest) return true

  const age = now.getTime() - newest.refreshedAt.getTime()
  if (age > INDEX_TTL_MS) return true
  if (age < INDEX_MIN_RETRY_MS) return false

  return !(await hasAnyChargeCodes(db, userId))
}

/**
 * Does a single project in the index have a task to log against?
 *
 * Asked as an existence check rather than by loading the index: the answer is one boolean and
 * the index is hundreds of rows carrying a JSON column each.
 */
async function hasAnyChargeCodes(db: PrismaClient, userId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM project_indexes
      WHERE user_id = ${userId}
        AND jsonb_array_length(charge_codes) > 0
    ) AS "exists"
  `
  return rows[0]?.exists ?? false
}
