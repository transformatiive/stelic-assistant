import type { ZohoClient } from '@/lib/zoho/client'
import { listWeekLogs, type TimeLog } from '@/lib/zoho/timelogs'
import {
  addDays,
  formatIso,
  parseIso,
  startOfWeek,
  todayIn,
  type CivilDate,
} from '@/lib/resolve/civil-date'

/**
 * "What did I log this week?" (tasks 6.8, 6.11, CHAT-12).
 *
 * **The week runs Sunday to Saturday**, because the portal's `startday_of_week` is `sunday`.
 * A week view that disagreed with the grid people check their hours against would be worse
 * than having none — the same seven days showing two different totals is the kind of thing
 * that makes someone stop trusting the whole app.
 *
 * All seven days are always present, including the empty ones. A week that silently omits
 * Thursday reads as "nothing to see"; a Thursday showing `0h` reads as "you logged nothing
 * on Thursday", which is the question being asked.
 */

export type WeekEntry = {
  logId: string
  projectId: string | null
  projectName: string | null
  taskId: string | null
  taskName: string | null
  hours: number
  billable: boolean
  description: string
}

export type WeekDay = {
  /** ISO `YYYY-MM-DD`. */
  date: string
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number
  hours: number
  entries: WeekEntry[]
}

export type WeekView = {
  /** ISO `YYYY-MM-DD` — the Sunday. */
  weekStart: string
  /** ISO `YYYY-MM-DD` — the Saturday. */
  weekEnd: string
  days: WeekDay[]
  totalHours: number
}

export type WeekInput = {
  /** The person's Zoho zuid. `users_list` takes the zuid, not the zpuid — see `listWeekLogs`. */
  zuid: string
  timezone: string
  /** Any date inside the wanted week, ISO. Defaults to today where the person is. */
  date?: string | undefined
  now?: Date
}

export async function readWeek(client: ZohoClient, input: WeekInput): Promise<WeekView> {
  const anchor = resolveAnchor(input)
  const start = startOfWeek(anchor)

  const groups = await listWeekLogs(client, { zuid: input.zuid, date: formatIso(start) })
  const byDate = new Map(groups.map((group) => [group.date, group]))

  const days: WeekDay[] = []
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDays(start, offset)
    const iso = formatIso(day)
    const group = byDate.get(iso)
    days.push({
      date: iso,
      // Sunday is ISO 7, so the week starts at 7 and runs 1..6. That is what the portal
      // means by a Sunday week, however odd it looks written down.
      weekday: ((offset + 6) % 7) + 1,
      // Zoho's own per-day total, not a re-sum of the entries: if the two ever disagree,
      // the portal's number is the one the person will see in the grid.
      hours: group?.hours ?? 0,
      entries: (group?.logs ?? []).map(toEntry),
    })
  }

  return {
    weekStart: formatIso(start),
    weekEnd: formatIso(addDays(start, 6)),
    days,
    totalHours: round(days.reduce((sum, day) => sum + day.hours, 0)),
  }
}

/**
 * Which week to read.
 *
 * An unparseable date falls back to today rather than failing: the caller is a chat message,
 * and refusing the whole question over a malformed parameter helps nobody.
 */
function resolveAnchor(input: WeekInput): CivilDate {
  const requested = input.date ? parseIso(input.date) : null
  return requested ?? todayIn(input.timezone, input.now ?? new Date())
}

function toEntry(log: TimeLog): WeekEntry {
  return {
    logId: log.id,
    projectId: log.projectId,
    projectName: log.projectName,
    taskId: log.taskId,
    taskName: log.taskName,
    hours: round(log.hours),
    billable: log.billable,
    description: log.notes,
  }
}

/** Two decimals, so a sum of thirds does not surface as `7.999999999999999`. */
function round(hours: number): number {
  return Math.round(hours * 100) / 100
}
