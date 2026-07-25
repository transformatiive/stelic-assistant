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
    // Documented, but absent on every project of this portal — see `readCustomFields`.
    crm_deal_id: z.union([z.string(), z.number()]).optional(),
    /**
     * **Not** `{ label_name, value }` pairs, which is what the documentation suggests and
     * what this code originally assumed. Zoho Projects returns one single-key object per
     * field, with the *label itself* as the key:
     *
     *   [{ "CRM Deal ID": "7217638000000702236" }, { "Customer": "Google LLC" }]
     *
     * Verified against all 145 live projects on 2026-07-25. The old shape matched nothing,
     * so every project silently lost its deal id and its client name.
     */
    custom_fields: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough()

export type ZohoProject = {
  id: string
  name: string
  status?: string
  crmDealId?: string
  /**
   * The client, straight off the project.
   *
   * Present on every project of this portal, which makes the CRM round trip optional rather
   * than essential: the index gets its client name without `ZohoCRM.modules.READ` and
   * without a second API dependency.
   */
  customerName?: string
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

  const custom = readCustomFields(parsed.data.custom_fields)
  const dealId = text(parsed.data.crm_deal_id) ?? custom.get('crm deal id')

  return {
    id: id.data,
    name: parsed.data.name.trim(),
    status: parsed.data.status,
    crmDealId: dealId,
    customerName: custom.get('customer'),
  }
}

/**
 * Flatten `[{ "CRM Deal ID": "…" }, { "Customer": "…" }]` into a lookup.
 *
 * Keyed on the lowercased label because the labels are configured per portal and a rename
 * of case alone should not silently drop a field. Blank values are dropped rather than
 * stored, so a caller can treat "absent" and "empty" the same way.
 */
function readCustomFields(
  fields: Record<string, unknown>[] | undefined,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const field of fields ?? []) {
    for (const [label, raw] of Object.entries(field)) {
      const value = text(raw)
      if (value) out.set(label.trim().toLowerCase(), value)
    }
  }
  return out
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
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
