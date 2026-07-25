import { z } from 'zod'
import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from './client'
import { log } from '@/lib/observability/log'

/**
 * Which CRM user is this person (task 2.5)?
 *
 * Three systems, three ids for the same human: Projects has a `zuid`, Projects also has a
 * `zpuid`, and CRM has its own record id. The **zuid is the one that crosses systems**, so
 * that is what this matches on — not the email, which differs by domain between the sign-in
 * account and the CRM record and would silently match nobody.
 *
 * Worth noting against the Projects API: `GET projects/users/` answers `403 Invalid OAuth
 * scope` for this credential and there is no workaround at project scope (design §5). The
 * **CRM** users endpoint has no such problem — verified live, 16 active users returned.
 */

const userSchema = z.object({
  id: z.string(),
  zuid: z.union([z.string(), z.number()]).optional(),
  email: z.string().optional(),
  full_name: z.string().optional(),
})

export type CrmUser = {
  /** The CRM record id, which is what a lookup field wants. */
  id: string
  zuid: string | null
  email: string | null
  fullName: string | null
}

export async function listCrmUsers(client: ZohoClient): Promise<CrmUser[]> {
  const body = await client.requestJson<{ users?: unknown[] }>('users', {
    query: { type: 'ActiveUsers' },
  })

  return (body?.users ?? []).flatMap((raw) => {
    const parsed = userSchema.safeParse(raw)
    if (!parsed.success) return []
    return [
      {
        id: parsed.data.id,
        zuid: parsed.data.zuid === undefined ? null : String(parsed.data.zuid),
        email: parsed.data.email ?? null,
        fullName: parsed.data.full_name ?? null,
      },
    ]
  })
}

/**
 * Resolve and remember this person's CRM id.
 *
 * Cached on the `User` row because it never changes and the lookup costs a call that returns
 * the whole company. Returns what is already stored without asking, so the common path is
 * free.
 */
export async function resolveCrmUserId(
  db: PrismaClient,
  client: ZohoClient,
  user: { id: string; zohoUserId: string | null; crmUserId: string | null },
): Promise<string | null> {
  if (user.crmUserId) return user.crmUserId
  if (!user.zohoUserId) return null

  const users = await listCrmUsers(client)
  const match = users.find((candidate) => candidate.zuid === user.zohoUserId)
  if (!match) {
    // Not an error: somebody can have a Zoho Projects account and no CRM record. The
    // consequence is a blank billing role, which is the documented empty case.
    log.info('crm.user_unmatched', { userId: user.id, candidates: users.length })
    return null
  }

  await db.user.update({ where: { id: user.id }, data: { crmUserId: match.id } })
  return match.id
}
