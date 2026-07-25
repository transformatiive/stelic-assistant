import { z } from 'zod'
import type { ZohoClient } from './client'

/**
 * Typed reads against Zoho Projects (task 3.1, design §5).
 *
 * **Every identifier here is a string taken from `id_string`.** Zoho returns both `id` and
 * `id_string`, and the numeric one exceeds `Number.MAX_SAFE_INTEGER`, so `JSON.parse`
 * silently corrupts it — the spike observed `id: 2620762000000790000` against
 * `id_string: "2620762000000790022"`. A corrupted id does not fail loudly; it addresses the
 * wrong record. `identifier()` below refuses to fall back to `id` when `id_string` is
 * present, so that class of bug cannot reappear by accident.
 */

/** Zoho caps a page well below this; 200 is what the spike used against 145 projects. */
export const PAGE_SIZE = 200

/** A page loop has to end even if Zoho keeps answering. 50 pages is far past any real portal. */
const MAX_PAGES = 50

const identifier = z
  .object({ id_string: z.string().min(1).optional(), id: z.unknown().optional() })
  .transform((raw, ctx) => {
    if (raw.id_string) return raw.id_string
    // No `id_string` at all: fall back, but only for values that survived parsing intact.
    if (typeof raw.id === 'string' && raw.id) return raw.id
    if (typeof raw.id === 'number' && Number.isSafeInteger(raw.id)) return String(raw.id)
    ctx.addIssue({ code: 'custom', message: 'no usable id_string' })
    return z.NEVER
  })

const projectSchema = z
  .object({
    id_string: z.string().optional(),
    id: z.unknown().optional(),
    name: z.string().default(''),
    status: z.string().optional(),
    // Set on Stelic projects created from a CRM deal; the join key for §5's CRM lookups.
    crm_deal_id: z.union([z.string(), z.number()]).optional(),
    custom_fields: z
      .array(z.object({ label_name: z.string().optional(), value: z.unknown() }))
      .optional(),
  })
  .passthrough()

export type ZohoProject = {
  id: string
  name: string
  status?: string
  crmDealId?: string
}

export type ZohoTask = {
  id: string
  name: string
  tasklist?: string
  /** Zoho's own completion flag. A closed task is still loggable, but ranks lower. */
  completed: boolean
}

function readProject(raw: unknown): ZohoProject | null {
  const parsed = projectSchema.safeParse(raw)
  if (!parsed.success) return null
  const id = identifier.safeParse(parsed.data)
  if (!id.success) return null

  const dealId = parsed.data.crm_deal_id ?? readCustomField(parsed.data.custom_fields)
  return {
    id: id.data,
    name: parsed.data.name.trim(),
    status: parsed.data.status,
    crmDealId: dealId === undefined ? undefined : String(dealId).trim() || undefined,
  }
}

/** Some portals carry the deal id as a custom field rather than the documented column. */
function readCustomField(
  fields: { label_name?: string; value?: unknown }[] | undefined,
): string | undefined {
  const match = fields?.find((f) => /crm.*deal|deal.*id/i.test(f.label_name ?? ''))
  const value = match?.value
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof value === 'number') return String(value)
  return undefined
}

const taskSchema = z
  .object({
    id_string: z.string().optional(),
    id: z.unknown().optional(),
    name: z.string().default(''),
    completed: z.boolean().optional(),
    status: z.object({ type: z.string().optional() }).partial().optional(),
    tasklist: z.object({ name: z.string().optional() }).partial().optional(),
  })
  .passthrough()

function readTask(raw: unknown): ZohoTask | null {
  const parsed = taskSchema.safeParse(raw)
  if (!parsed.success) return null
  const id = identifier.safeParse(parsed.data)
  if (!id.success) return null

  return {
    id: id.data,
    name: parsed.data.name.trim(),
    tasklist: parsed.data.tasklist?.name?.trim() || undefined,
    completed: parsed.data.completed ?? parsed.data.status?.type === 'closed',
  }
}

/**
 * Walk a Zoho list endpoint to exhaustion.
 *
 * Zoho pages with a 1-based `index` and a `range`, and signals the end by returning fewer
 * rows than asked for — there is no total and no cursor. A `204` (empty body) also ends it:
 * `requestJson` yields undefined for those, and the logs endpoint really does answer `204`.
 */
async function readAllPages<T>(
  client: ZohoClient,
  path: string,
  key: string,
  read: (raw: unknown) => T | null,
  extraQuery: Record<string, string | number> = {},
): Promise<T[]> {
  const out: T[] = []

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await client.requestJson<Record<string, unknown> | undefined>(path, {
      query: { index: page * PAGE_SIZE + 1, range: PAGE_SIZE, ...extraQuery },
    })

    const rows = body?.[key]
    if (!Array.isArray(rows) || rows.length === 0) break

    for (const raw of rows) {
      const item = read(raw)
      // A row we cannot identify is skipped, not guessed at, and not fatal to the page.
      if (item) out.push(item)
    }

    if (rows.length < PAGE_SIZE) break
  }

  return out
}

export function listProjects(client: ZohoClient): Promise<ZohoProject[]> {
  return readAllPages(client, 'projects/', 'projects', readProject)
}

export function listTasks(client: ZohoClient, projectId: string): Promise<ZohoTask[]> {
  return readAllPages(client, `projects/${projectId}/tasks/`, 'tasks', readTask)
}

/** Exported for the tests, which assert the id discipline directly. */
export const _internal = { readProject, readTask, readAllPages }
