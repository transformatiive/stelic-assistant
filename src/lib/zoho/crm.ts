import { z } from 'zod'
import { ZohoHttpError } from './errors'
import type { ZohoClient } from './client'

/**
 * Zoho CRM reads (task 3.2, design §5).
 *
 * Only what the project index needs: given the `crm_deal_id` on a project, the deal's name
 * and the account it belongs to. Those two strings are what let someone say "the Clayco job"
 * instead of "STE-100013".
 */

const dealSchema = z
  .object({
    id: z.string(),
    Deal_Name: z.string().optional(),
    Account_Name: z
      .object({ id: z.string().optional(), name: z.string().optional() })
      .partial()
      .nullish(),
  })
  .passthrough()

export type CrmDeal = {
  id: string
  dealName?: string
  accountName?: string
}

export function readDeal(raw: unknown): CrmDeal | null {
  const parsed = dealSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    id: parsed.data.id,
    dealName: parsed.data.Deal_Name?.trim() || undefined,
    accountName: parsed.data.Account_Name?.name?.trim() || undefined,
  }
}

/** CRM's `ids` filter takes a comma-separated list; 100 is the documented per-call ceiling. */
const CRM_ID_BATCH = 100

/**
 * Fetch deals by id, in batches.
 *
 * Returned as a map because the caller has projects, not deals, and needs to look each one
 * up. Ids CRM does not recognise are simply absent from the map rather than an error — a
 * project pointing at a deleted deal should lose its client name, not fail the whole index.
 */
export async function fetchDealsByIds(
  client: ZohoClient,
  dealIds: readonly string[],
): Promise<Map<string, CrmDeal>> {
  const unique = [...new Set(dealIds.filter((id) => id.trim()))]
  const found = new Map<string, CrmDeal>()

  for (let i = 0; i < unique.length; i += CRM_ID_BATCH) {
    const batch = unique.slice(i, i + CRM_ID_BATCH)

    let body: { data?: unknown[] } | undefined
    try {
      body = await client.requestJson<{ data?: unknown[] } | undefined>('Deals', {
        query: { ids: batch.join(','), fields: 'id,Deal_Name,Account_Name' },
      })
    } catch (error) {
      // 204 means none of this batch exists. Anything else is a real failure and should not
      // be swallowed — a systematically broken CRM read must not look like "no clients".
      if (error instanceof ZohoHttpError && error.status === 204) continue
      throw error
    }

    for (const raw of body?.data ?? []) {
      const deal = readDeal(raw)
      if (deal) found.set(deal.id, deal)
    }
  }

  return found
}
