import type { PrismaClient } from '@/generated/prisma/client'
import type { Usage } from './openrouter'

/**
 * Gateway accounting (task 4.6).
 *
 * Cost is recorded against the assistant message that caused it, not aggregated into a
 * counter. That way "what did the bot cost last month" and "why was that turn expensive" are
 * the same query, and a cost spike can be traced to the conversation that produced it.
 *
 * Every field is optional on the way in: a degraded turn produced no model call, and a
 * provider may omit `cost`. Recording a partial row is better than recording nothing —
 * knowing a call happened is itself useful.
 */

export function usageColumns(usage: Usage | null | undefined) {
  if (!usage) return {}
  return {
    generationId: usage.generationId ?? null,
    modelRequested: usage.modelRequested,
    modelServed: usage.modelServed ?? null,
    promptTokens: usage.promptTokens ?? null,
    completionTokens: usage.completionTokens ?? null,
    // Prisma takes Decimal columns as a string, which also avoids float drift on a value
    // that gets summed across thousands of rows.
    costUsd: usage.costUsd === undefined ? null : String(usage.costUsd),
  }
}

export type MonthlyCost = {
  month: string
  calls: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}

/**
 * Spend per calendar month.
 *
 * Grouped in SQL rather than in JavaScript: this table grows by a row per turn, and pulling
 * a year of messages into memory to add up a column would be the wrong shape from the start.
 */
export async function monthlyCost(
  db: PrismaClient,
  options: { months?: number } = {},
): Promise<MonthlyCost[]> {
  const months = options.months ?? 12
  const rows = await db.$queryRaw<
    {
      month: string
      calls: bigint
      prompt_tokens: bigint | null
      completion_tokens: bigint | null
      cost_usd: string | null
    }[]
  >`
    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           count(*)                        AS calls,
           coalesce(sum(prompt_tokens), 0) AS prompt_tokens,
           coalesce(sum(completion_tokens), 0) AS completion_tokens,
           coalesce(sum(cost_usd), 0)::text    AS cost_usd
    FROM messages
    WHERE generation_id IS NOT NULL
      AND created_at >= date_trunc('month', now()) - make_interval(months => ${months})
    GROUP BY 1
    ORDER BY 1 DESC
  `

  return rows.map((row) => ({
    month: row.month,
    calls: Number(row.calls),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    costUsd: Number(row.cost_usd ?? 0),
  }))
}
