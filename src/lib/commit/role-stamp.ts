import type { PrismaClient } from '@/generated/prisma/client'
import type { ZohoClient } from '@/lib/zoho/client'
import type { CommittableEntry } from './commit'
import { resolveBillingRole } from '@/lib/zoho/billing-role'
import { resolveCrmUserId } from '@/lib/zoho/crm-users'
import { stampCustomField } from '@/lib/zoho/timelogs'

/**
 * Stamping `billing_role` onto the logs this app creates (task 6.12, TRNSF-914).
 *
 * Assembled here rather than inside the commit pipeline because it needs three things the
 * pipeline has no business knowing about: a CRM client, the project index (for the deal id),
 * and the portal's custom-field column name.
 *
 * **Nothing here affects billing.** The invoice pipeline resolves role and rate itself from
 * (user, project) at invoice time (TRNSF-867); this only writes a copy onto the log so a PM
 * reading the Zoho grid does not have to cross-reference. What billing actually needs is the
 * log's **owner**, which the commit pipeline sets explicitly and always.
 *
 * **Every step can legitimately produce nothing**, and each of them is the documented empty
 * case rather than a fault:
 *
 * - no `BILLING_ROLE_FIELD` configured → the column name is not derivable from the label,
 *   and writing to a guessed field would corrupt someone else's data
 * - no CRM user for this person → they have a Projects account and no CRM record
 * - no deal on the project → 7 of the 145 live projects have no CRM deal id
 * - no PCCR row for (deal, person) → **this is every project today**: the rows exist per
 *   labor category with `Resource` unpopulated, so nobody is assigned a role yet
 *
 * TRNSF-914's own acceptance criteria say the field is left blank in that case, so that is
 * what happens. Deriving a role from the deal's rate rows instead would put a plausible and
 * unverified labor category on an invoice, and a wrong role is worse than a missing one
 * because nobody looks twice at it.
 */

export type RoleStamper = (entry: CommittableEntry, zohoLogId: string) => Promise<void>

export type RoleStampDeps = {
  db: PrismaClient
  /** Reads CRM users and the PCCR module. */
  crm: ZohoClient
  /** Writes the field back onto the log — the person's own credential. */
  projects: ZohoClient
  user: { id: string; zohoUserId: string | null; crmUserId: string | null }
  /** The Zoho column name, e.g. `UDF_CHAR1`. Absent means do nothing. */
  field?: string | undefined
  logger?: { info(event: string, fields: Record<string, unknown>): void }
}

export function createRoleStamper(deps: RoleStampDeps): RoleStamper | undefined {
  if (!deps.field) return undefined
  const field = deps.field
  const log = deps.logger ?? {
    info: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  }

  // One lookup per commit, not per entry: the CRM user id is the same for every line, and a
  // ten-entry draft should not read the whole company ten times.
  let crmUserId: Promise<string | null> | null = null

  return async (entry, zohoLogId) => {
    crmUserId ??= resolveCrmUserId(deps.db, deps.crm, deps.user)
    const userId = await crmUserId
    if (!userId) return

    const project = await deps.db.projectIndex.findUnique({
      where: { projectId: entry.projectId },
      select: { crmDealId: true },
    })
    if (!project?.crmDealId) return

    const role = await resolveBillingRole(deps.crm, {
      crmDealId: project.crmDealId,
      crmUserId: userId,
    })
    if (!role) {
      // Expected today, and worth counting: when somebody starts assigning resources in CRM
      // this line stops appearing, which is how we will know it began working.
      log.info('role.unassigned', { projectId: entry.projectId })
      return
    }

    await stampCustomField(deps.projects, {
      projectId: entry.projectId,
      taskId: entry.taskId,
      logId: zohoLogId,
      field,
      value: role.label,
    })
    log.info('role.stamped', { projectId: entry.projectId, recordId: role.recordId })
  }
}
