import type { PrismaClient } from '@/generated/prisma/client'

/**
 * Per-user rate limiting on the chat path (task 7.4, CHAT-14).
 *
 * Thirty requests a minute is far above anything a person typing can reach and far below what
 * a loop can. The thing being protected is not the server — it is the **model spend**, which
 * is real money per request and has no ceiling of its own.
 *
 * A fixed window rather than a sliding one. A sliding window is more accurate at the boundary
 * and needs either a sorted set per user or a row per request; a fixed window is one row and
 * one atomic increment, and the worst it allows is 60 requests across two adjacent seconds by
 * someone deliberately timing it. That is not the case worth engineering for.
 *
 * **The check runs before the model call, never after.** Counting after would mean a user at
 * the limit still pays for the request that tells them they are at the limit.
 */

export const CHAT_BUCKET = 'chat'
export const CHAT_LIMIT_PER_MINUTE = 30
export const WINDOW_MS = 60_000

export type RateLimitVerdict = {
  allowed: boolean
  /** How many remain in this window, floored at zero. */
  remaining: number
  /** Seconds until the window rolls over — what a `retry-after` header should carry. */
  resetSeconds: number
}

/**
 * Count this request against the user's window.
 *
 * The window start is quantised to the minute so every request in the same minute addresses
 * the same row, which is what makes the unique constraint on `(userId, bucket, windowStartedAt)`
 * do the concurrency work: two simultaneous requests cannot each create their own counter.
 */
export async function consumeChatQuota(
  db: PrismaClient,
  userId: string,
  options: { now?: Date; limit?: number; bucket?: string } = {},
): Promise<RateLimitVerdict> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? CHAT_LIMIT_PER_MINUTE
  const bucket = options.bucket ?? CHAT_BUCKET

  const windowStartedAt = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS)
  const resetSeconds = Math.max(
    1,
    Math.ceil((windowStartedAt.getTime() + WINDOW_MS - now.getTime()) / 1000),
  )

  // `upsert` with an increment, so the count is computed by the database rather than read,
  // added to, and written back — the read-modify-write would lose requests under concurrency,
  // which is exactly the condition a rate limit exists for.
  const row = await db.rateLimit.upsert({
    where: { userId_bucket_windowStartedAt: { userId, bucket, windowStartedAt } },
    create: { userId, bucket, windowStartedAt, count: 1 },
    update: { count: { increment: 1 } },
    select: { count: true },
  })

  return {
    allowed: row.count <= limit,
    remaining: Math.max(0, limit - row.count),
    resetSeconds,
  }
}

/**
 * Drop counters from windows that have rolled over.
 *
 * Called opportunistically rather than on a schedule: one row per user per minute of use is
 * not much, but left forever it is unbounded, and a background sweeper is a moving part that
 * can fail silently.
 */
export async function pruneRateLimits(
  db: PrismaClient,
  options: { now?: Date; olderThanMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 60 * 60_000))
  const { count } = await db.rateLimit.deleteMany({
    where: { windowStartedAt: { lt: cutoff } },
  })
  return count
}
