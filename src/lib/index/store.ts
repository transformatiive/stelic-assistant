import type { PrismaClient } from '@/generated/prisma/client'
import type { IndexedProject } from './match'
import type { ChargeCode, IndexedProjectRow } from './build'

/**
 * Persisting the project index (task 3.4).
 *
 * **The index is shared, not per user.** It was originally one copy per person, which quietly
 * made a scheduled rebuild impossible: 145 projects is 145 Zoho calls, and against a
 * 100-per-120-seconds limit fifteen people would take three quarters of an hour per run.
 * Nothing in the portal differs between users; the only thing that did was recency, which is
 * now derived from `CommitLog` when the index is read.
 */

/** How long an index is trusted before a refresh is due. */
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
      where: { projectId: row.projectId },
      create: { projectId: row.projectId, ...data },
      update: data,
    })
  }

  // Anything not in this build is gone from the portal, or newly closed. Leaving it behind
  // would let the matcher keep offering a project nobody can log to.
  const { count } = await db.projectIndex.deleteMany({
    where: { projectId: { notIn: rows.map((r) => r.projectId) } },
  })

  return { written: rows.length, removed: count }
}

/**
 * The index in the shape the matcher takes, with this user's recency folded in.
 *
 * Recency is computed here rather than stored, which is what lets the index be shared. It
 * comes from `CommitLog` — this app's own record of what it wrote — because Zoho's
 * portal-wide range read does not work: both documented forms return `6891 "Given URL is
 * wrong"` (design §5, task 6.11), and the verified per-task alternative would mean walking
 * every task of 145 projects for a signal that only breaks ties.
 *
 * So recency starts empty for a new user and sharpens with use. The consequence is bounded by
 * design: the matcher caps recency at 0.10, below the 0.15 resolve gap, so its absence can
 * cost a tie-break and never a correct match.
 */
export async function loadProjectIndex(
  db: PrismaClient,
  userId: string,
  options: { recencyWindowDays?: number; now?: Date } = {},
): Promise<IndexedProject[]> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - (options.recencyWindowDays ?? 60) * 86_400_000)

  const [rows, recent] = await Promise.all([
    db.projectIndex.findMany({
      select: {
        projectId: true,
        projectName: true,
        accountName: true,
        dealName: true,
        aliases: true,
      },
    }),
    db.commitLog.groupBy({
      by: ['projectId'],
      where: { userId, status: 'success', logDate: { gte: since } },
      _max: { logDate: true },
    }),
  ])

  const lastLogged = new Map<string, string>()
  for (const row of recent) {
    const date = row._max?.logDate
    // The matcher compares civil dates, not instants — a log belongs to a day, not a moment.
    if (date) lastLogged.set(row.projectId, date.toISOString().slice(0, 10))
  }

  return rows.map((row) => ({
    projectId: row.projectId,
    projectName: row.projectName,
    accountName: row.accountName,
    dealName: row.dealName,
    aliases: row.aliases,
    lastLoggedAt: lastLogged.get(row.projectId) ?? null,
  }))
}

/** Charge codes per project, for the resolver. */
export async function loadChargeCodes(
  db: PrismaClient,
): Promise<Map<string, ChargeCode[]>> {
  const rows = await db.projectIndex.findMany({
    select: { projectId: true, chargeCodes: true },
  })
  return new Map(
    rows.map((row) => [row.projectId, row.chargeCodes as unknown as ChargeCode[]]),
  )
}

/**
 * Whether the index needs rebuilding.
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
  now: Date = new Date(),
): Promise<boolean> {
  const newest = await db.projectIndex.findFirst({
    orderBy: { refreshedAt: 'desc' },
    select: { refreshedAt: true },
  })
  if (!newest) return true

  const age = now.getTime() - newest.refreshedAt.getTime()
  if (age > INDEX_TTL_MS) return true
  if (age < INDEX_MIN_RETRY_MS) return false

  return !(await hasAnyChargeCodes(db))
}

/**
 * Does a single project in the index have a task to log against?
 *
 * Asked as an existence check rather than by loading the index: the answer is one boolean and
 * the index is hundreds of rows carrying a JSON column each.
 */
async function hasAnyChargeCodes(db: PrismaClient): Promise<boolean> {
  const rows = await db.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM project_indexes
      WHERE jsonb_array_length(charge_codes) > 0
    ) AS "exists"
  `
  return rows[0]?.exists ?? false
}
