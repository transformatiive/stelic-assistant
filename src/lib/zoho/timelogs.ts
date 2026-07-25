import { z } from 'zod'
import type { ZohoClient } from './client'

/**
 * Time-log writes and reads against Zoho Projects (tasks 6.3, 6.7, design §5).
 *
 * These are the only calls in the app that *change* anything in the portal, and they run on
 * the signed-in person's own credential — a log's owner is whose utilisation, approval queue
 * and invoice line it becomes, so it cannot be a service account (§2).
 *
 * Verified live on 2026-07-25:
 *
 * | Purpose | Call | Result |
 * |---|---|---|
 * | create | `POST projects/{p}/tasks/{t}/logs/` form-encoded | `201` |
 * | delete | `DELETE projects/{p}/tasks/{t}/logs/{id}/` | `200` |
 * | read   | `GET projects/{p}/tasks/{t}/logs/` | `200`, or `204` with no body |
 */

/** Zoho's two accepted values. There is no boolean. */
export const BILLABLE = 'Billable'
export const NON_BILLABLE = 'Non Billable'

export type TimeLog = {
  /** From `id_string`. Never `id` — the numeric form is precision-corrupted (§5). */
  id: string
  /** ISO `YYYY-MM-DD`, converted back from Zoho's `MM-DD-YYYY`. */
  date: string | null
  hours: number
  billable: boolean
  notes: string
  ownerZuid: string | null
  ownerName: string | null
  taskId: string | null
  /** Present on the week read, which is where a log has to name itself to a person. */
  taskName: string | null
  projectId: string | null
  projectName: string | null
  /** `api` for anything this app wrote. The undo guard reads it (task 6.7). */
  addedVia: string | null
  approvalStatus: string | null
}

/**
 * `YYYY-MM-DD` → `MM-DD-YYYY`.
 *
 * The portal is US-format (`task_date_format: MM-dd-yyyy`), and the two formats are
 * indistinguishable for the first twelve days of a month: sending `07-08-2026` when Zoho
 * expects `MM-DD` books 8 July, and sending it when it expects `DD-MM` books 7 August. There
 * is no error either way — just the wrong day on someone's invoice. So the conversion is
 * explicit and tested rather than left to a date library's locale.
 */
export function formatZohoDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new RangeError(`not an ISO date: ${iso}`)
  const [, year, month, day] = match
  return `${month}-${day}-${year}`
}

/** `MM-DD-YYYY` → `YYYY-MM-DD`, for reading Zoho's answer back. */
export function parseZohoDate(value: string): string | null {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, month, day, year] = match
  return `${year}-${month}-${day}`
}

/**
 * Decimal hours → `hh:mm`.
 *
 * Rounded to the nearest minute, because that is the resolution Zoho stores: it answers with
 * `hours`, `minutes` and `total_minutes`, and a third of an hour is 20 minutes, not 0.333 of
 * one. Rounding here rather than letting Zoho truncate means the number the user confirmed
 * and the number stored differ by at most half a minute, in a known direction.
 */
export function formatZohoHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0)
    throw new RangeError(`not usable hours: ${hours}`)
  const totalMinutes = Math.round(hours * 60)
  const hh = Math.floor(totalMinutes / 60)
  const mm = totalMinutes % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

const logSchema = z
  .object({
    id_string: z.string().optional(),
    id: z.unknown().optional(),
    log_date: z.string().optional(),
    hours: z.union([z.string(), z.number()]).optional(),
    minutes: z.union([z.string(), z.number()]).optional(),
    total_minutes: z.union([z.string(), z.number()]).optional(),
    bill_status: z.string().optional(),
    notes: z.string().optional(),
    owner_id: z.union([z.string(), z.number()]).optional(),
    owner_name: z.string().optional(),
    added_via: z.string().optional(),
    approval_status: z.string().optional(),
    task: z
      .object({ id_string: z.string().optional(), name: z.string().optional() })
      .partial()
      .optional(),
    project: z
      .object({ id_string: z.string().optional(), name: z.string().optional() })
      .partial()
      .optional(),
  })
  .passthrough()

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function readTimeLog(raw: unknown): TimeLog | null {
  const parsed = logSchema.safeParse(raw)
  if (!parsed.success) return null

  const data = parsed.data
  // Only `id_string`. A numeric `id` past `Number.MAX_SAFE_INTEGER` would address a
  // different log, and this id is what `undo` deletes with.
  const id = typeof data.id_string === 'string' ? data.id_string.trim() : ''
  if (!id) return null

  const total = numeric(data.total_minutes)
  const hoursPart = numeric(data.hours) ?? 0
  const minutesPart = numeric(data.minutes) ?? 0

  return {
    id,
    date: data.log_date ? parseZohoDate(data.log_date) : null,
    hours: (total ?? hoursPart * 60 + minutesPart) / 60,
    // Anything that is not exactly `Non Billable` is billable, which is also Zoho's own
    // default (`timesheet.default_billing_status`).
    billable: (data.bill_status ?? BILLABLE).trim().toLowerCase() !== 'non billable',
    notes: data.notes ?? '',
    ownerZuid: data.owner_id === undefined ? null : String(data.owner_id),
    ownerName: data.owner_name ?? null,
    taskId: data.task?.id_string ?? null,
    taskName: data.task?.name ?? null,
    projectId: data.project?.id_string ?? null,
    projectName: data.project?.name ?? null,
    addedVia: data.added_via ?? null,
    approvalStatus: data.approval_status ?? null,
  }
}

/**
 * Find the log in whatever envelope Zoho wrapped it in.
 *
 * The read endpoint answers `{ timelogs: { tasklogs: [...] } }`; the create endpoint's
 * envelope was not captured in the spike. Rather than guess one shape and have the parser
 * silently match nothing — which is exactly how the index lost every client name — this
 * tries the shapes in order and gives up rather than inventing an id.
 */
function extractLogs(body: unknown): unknown[] {
  if (!body || typeof body !== 'object') return []
  const root = body as Record<string, unknown>

  const timelogs = root.timelogs
  if (Array.isArray(timelogs)) return timelogs
  if (timelogs && typeof timelogs === 'object') {
    const tasklogs = (timelogs as Record<string, unknown>).tasklogs
    if (Array.isArray(tasklogs)) return tasklogs
  }
  if (Array.isArray(root.tasklogs)) return root.tasklogs
  if (Array.isArray(root.timelog)) return root.timelog
  // A bare log object, which is what some Projects endpoints answer with.
  if (typeof root.id_string === 'string') return [root]
  return []
}

export type CreateTimeLogInput = {
  projectId: string
  taskId: string
  /** ISO `YYYY-MM-DD`. Converted at the boundary, never earlier. */
  date: string
  hours: number
  billable: boolean
  notes: string
  /**
   * The owner's `zuid`.
   *
   * Optional: writing on the person's own credential already makes them the owner. It is
   * sent when known so the intent is explicit in the request rather than implied by which
   * token happened to be used.
   */
  ownerZuid?: string | null
}

export type CreateTimeLogResult = {
  /**
   * `null` when Zoho accepted the write but the response could not be parsed.
   *
   * **This is a success, not a failure.** The log exists in the portal; only our handle on
   * it is missing. Reporting it as a failure would invite a retry that double-books, which
   * is the one outcome a timesheet must never produce. Undo is what degrades — it refuses
   * rather than deleting a log it cannot name.
   */
  log: TimeLog | null
  raw: unknown
}

export async function createTimeLog(
  client: ZohoClient,
  input: CreateTimeLogInput,
): Promise<CreateTimeLogResult> {
  const body = await client.requestJson<unknown>(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/`,
    {
      method: 'POST',
      form: {
        date: formatZohoDate(input.date),
        hours: formatZohoHours(input.hours),
        bill_status: input.billable ? BILLABLE : NON_BILLABLE,
        notes: input.notes,
        ...(input.ownerZuid ? { owner: input.ownerZuid } : {}),
      },
    },
  )

  const [first] = extractLogs(body)
  return { log: first === undefined ? null : readTimeLog(first), raw: body }
}

export async function deleteTimeLog(
  client: ZohoClient,
  input: { projectId: string; taskId: string; logId: string },
): Promise<void> {
  await client.requestText(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/${input.logId}/`,
    { method: 'DELETE' },
  )
}

/**
 * Every log on one task.
 *
 * `204` with an empty body when there are none — `requestJson` yields undefined for that,
 * which `extractLogs` reads as an empty list rather than an error.
 */
export async function listTaskLogs(
  client: ZohoClient,
  input: { projectId: string; taskId: string },
): Promise<TimeLog[]> {
  const body = await client.requestJson<unknown>(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/`,
  )
  return extractLogs(body)
    .map(readTimeLog)
    .filter((log): log is TimeLog => log !== null)
}

/**
 * One person's logs for the week containing a date (tasks 6.8, 6.11).
 *
 * **The path has no trailing slash, and that is the whole contract.** `logs/` answers
 * `6891 "Given URL is wrong"`; `logs` answers `200`. Every documented parameter shape was
 * tried against the trailing-slash form and all of them failed, which is what made this look
 * like an unavailable endpoint for two rounds of investigation. It was a slash.
 *
 * Verified live on 2026-07-25:
 *
 * - `users_list` takes the **zuid**, not the zpuid. A zpuid returns `204` — an empty week
 *   rather than an error, so getting it wrong looks like "you logged nothing" and would have
 *   been very hard to notice. `User.zohoUserId` is the zuid.
 * - `component_type` and `users_list` are **required**; omitting either gives
 *   `6831 "Input Parameter Missing"`. `bill_status` is optional.
 * - `view_type=custom_date` does not work in any form tried, so an arbitrary range is not
 *   available — a week at a time is what the API offers, which is what CHAT-12 asks for.
 * - No logs in the week gives `204` with an empty body.
 *
 * Zoho groups by day and totals each day itself, which is exactly the shape the week view
 * needs — so this returns the grouping rather than flattening and regrouping it.
 */
export type DayLogs = {
  /** ISO `YYYY-MM-DD`. */
  date: string
  /** Zoho's own `hh:mm` total for the day, converted. */
  hours: number
  logs: TimeLog[]
}

export async function listWeekLogs(
  client: ZohoClient,
  input: {
    /** The person's Zoho zuid. */
    zuid: string
    /** Any date inside the wanted week, ISO `YYYY-MM-DD`. */
    date: string
  },
): Promise<DayLogs[]> {
  const body = await client.requestJson<unknown>('logs', {
    query: {
      users_list: input.zuid,
      view_type: 'week',
      date: formatZohoDate(input.date),
      bill_status: 'All',
      component_type: 'task',
    },
  })

  return readDayGroups(body)
}

/** `hh:mm` → decimal hours. Zoho totals each day in this form. */
export function parseZohoHours(value: string): number {
  const match = /^(\d+):(\d{1,2})$/.exec(value.trim())
  if (!match) return 0
  return Number(match[1]) + Number(match[2]) / 60
}

const dayGroupSchema = z
  .object({
    date: z.string().optional(),
    total_hours: z.string().optional(),
    tasklogs: z.array(z.unknown()).optional(),
  })
  .passthrough()

function readDayGroups(body: unknown): DayLogs[] {
  if (!body || typeof body !== 'object') return []
  const timelogs = (body as Record<string, unknown>).timelogs
  if (!timelogs || typeof timelogs !== 'object') return []
  const days = (timelogs as Record<string, unknown>).date
  if (!Array.isArray(days)) return []

  const out: DayLogs[] = []
  for (const raw of days) {
    const parsed = dayGroupSchema.safeParse(raw)
    if (!parsed.success || !parsed.data.date) continue
    const date = parseZohoDate(parsed.data.date)
    if (!date) continue

    const logs = (parsed.data.tasklogs ?? [])
      .map(readTimeLog)
      .filter((log): log is TimeLog => log !== null)
      // The day's date lives on the group, not the log — each log carries only the day it
      // was *created*, which for a backdated entry is a different day entirely.
      .map((log) => ({ ...log, date }))

    out.push({
      date,
      hours: parsed.data.total_hours ? parseZohoHours(parsed.data.total_hours) : 0,
      logs,
    })
  }
  return out
}

/**
 * Stamp a value onto a created log's custom field (task 6.12).
 *
 * The **parameter name is configuration, not a guess.** Zoho Projects addresses a custom
 * field on a write by its internal column name (`UDF_CHAR1` and friends), which is not
 * derivable from the label and differs per portal layout. This app already learned what
 * guessing a Zoho field shape costs: the index silently lost the client name from all 145
 * projects for exactly that reason.
 *
 * So the caller passes the name, it comes from `BILLING_ROLE_FIELD`, and when that is unset
 * nothing is stamped at all — an unroled log is a reporting gap, whereas a value written to
 * the wrong field is corruption in someone else's data.
 */
export async function stampCustomField(
  client: ZohoClient,
  input: {
    projectId: string
    taskId: string
    logId: string
    /** The Zoho column name for the field, e.g. `UDF_CHAR1`. */
    field: string
    value: string
  },
): Promise<void> {
  await client.requestText(
    `projects/${input.projectId}/tasks/${input.taskId}/logs/${input.logId}/`,
    { method: 'POST', form: { [input.field]: input.value } },
  )
}

/** Exported for the tests, which assert the envelope handling directly. */
export const _internal = { extractLogs, readDayGroups }
