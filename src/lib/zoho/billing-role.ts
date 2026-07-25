import { z } from 'zod'
import type { ZohoClient } from './client'

/**
 * The billing role for a person on a project (task 6.12, TRNSF-914).
 *
 * Spike 1.4(b) proved `stampRoleOnTimelog` does not fire for API-created logs — a log this
 * app writes comes back with `custom_fields: []`.
 *
 * **This is cosmetic, and it is worth being clear about that.** TRNSF-914: *"The stamped role
 * is for display/review only; billing still resolves independently by (user, project) at
 * invoice time (TRNSF-867), so the two can never silently diverge."* What has to be right on
 * the log is the **owner**, and it is — every log is written on the person's own credential
 * and carries an explicit `owner=<zuid>`. Role and rate are derived downstream from that.
 *
 * So an unstamped log is not an unbillable log. This exists so a PM reading the Zoho grid can
 * see the role without cross-referencing, and nothing more.
 *
 * ## Where the role actually lives, verified 2026-07-25
 *
 * **Not** in a "CRM Resource Subform". TRNSF-914 describes one and the Deals module has no
 * subform field at all — checked against the live CRM metadata, `data_type: subform` matches
 * nothing. Building against that description would have produced a lookup that never
 * resolved.
 *
 * It lives in the **`Project_Charge_Code_Rates`** module, one row per role per deal:
 *
 * | Field | Meaning |
 * |---|---|
 * | `Deal` | lookup to the project's CRM deal |
 * | `Resource` | **userlookup** — the person |
 * | `Labor_Category` | the role label, e.g. `Project Controls Analyst V` |
 *
 * Queried with `GET Project_Charge_Code_Rates/search?criteria=((Deal:equals:…)and(Resource:equals:…))`.
 * A plain list of the module answers `400 REQUIRED_PARAM_MISSING (fields)`; the search
 * endpoint does not need it.
 *
 * ## Today it resolves to nothing, and that is correct
 *
 * On the deal probed, 18 PCCR rows exist and **`Resource` is null on every one** — they are
 * rate-card rows per labor category, not per-person assignments. So the (deal, resource)
 * query returns `204`.
 *
 * That is the empty case TRNSF-914 itself specifies: *"Empty/no-row case: field left blank."*
 * This code therefore returns `null` and the caller stamps nothing. Guessing a role from the
 * rate rows on the deal would put a wrong labor category on an invoice, which is worse than
 * a blank one — the blank is visible and a wrong role is not.
 */

const roleRowSchema = z
  .object({
    id: z.string().optional(),
    Labor_Category: z.string().nullable().optional(),
  })
  .passthrough()

export type BillingRole = {
  /** The label to stamp, e.g. `Project Controls Analyst V`. */
  label: string
  /** The PCCR record it came from, for the log line. */
  recordId: string | null
}

/**
 * The role this person bills as on this project, or `null`.
 *
 * **No rate ever leaves this function.** The PCCR row carries `Hourly_Bill_Rate` and
 * `Hourly_Cost_Rate`, and a rate on a time log is a rate in a screenshot. Only the label is
 * read.
 */
export async function resolveBillingRole(
  client: ZohoClient,
  input: { crmDealId: string; crmUserId: string },
): Promise<BillingRole | null> {
  const criteria = `((Deal:equals:${input.crmDealId})and(Resource:equals:${input.crmUserId}))`

  const body = await client.requestJson<{ data?: unknown[] } | undefined>(
    'Project_Charge_Code_Rates/search',
    { query: { criteria } },
  )

  // `204` with no body is the ordinary answer when nobody is assigned — `requestJson` yields
  // undefined for it, which is a no-match rather than a failure.
  const [first] = body?.data ?? []
  if (first === undefined) return null

  const parsed = roleRowSchema.safeParse(first)
  if (!parsed.success) return null

  const label = parsed.data.Labor_Category?.trim()
  if (!label) return null

  return { label, recordId: parsed.data.id ?? null }
}
