import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from '@/lib/zoho/client'
import { resolveCrmUserId } from '@/lib/zoho/crm-users'
import { log } from '@/lib/observability/log'

/**
 * Warm the CRM user id for a signed-in person (task 2.5).
 *
 * Called post-response from `GET /api/me` via Next.js `after()`, so it never adds latency
 * to the chat. The resolution runs once, stores the result, and every subsequent call to
 * `resolveCrmUserId` returns immediately from the cache on the `User` row.
 *
 * This is not a failure mode for the chat: the CRM id is used only by the billing-role
 * stamper, which is a best-effort enrichment. A user whose id has not yet been resolved can
 * still log time; the stamper will resolve it on demand when it first runs.
 */
export async function warmCrmUserId(
  db: PrismaClient,
  crm: ZohoClient,
  user: { id: string; zohoUserId: string | null; crmUserId: string | null },
): Promise<void> {
  if (user.crmUserId) return // already cached — nothing to do

  try {
    await resolveCrmUserId(db, crm, user)
  } catch (err) {
    // Non-fatal: a temporarily unavailable service credential, a Zoho rate limit, or a
    // network hiccup should not surface to the user. The next `/api/me` call will retry.
    log.info('crm.user_warm_failed', {
      userId: user.id,
      error: err instanceof Error ? err.name : 'unknown',
    })
  }
}
