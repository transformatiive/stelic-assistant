import { fetchDealsByIds, type CrmDeal } from '@/lib/zoho/crm'
import {
  listProjects,
  listTasks,
  type ZohoProject,
  type ZohoTask,
} from '@/lib/zoho/projects'
import type { ZohoClient } from '@/lib/zoho/client'
import { nameFragments } from './normalise'

/**
 * Building the project index (tasks 3.1–3.4).
 *
 * The index is what turns "8 hours on Clayco yesterday" into a project id and a task id. It
 * is built on the **service** credential, so it can be warmed before anyone has signed in
 * (AUTH-8, *Reads work before a user has ever signed in*).
 *
 * The expensive part is tasks: one call per project, 145 projects, against a 100-calls-per-
 * 120-seconds limit. So the task fetch is bounded and ordered, and the caller decides how
 * much of the portal to walk.
 */

export type ChargeCode = {
  taskId: string
  taskName: string
  tasklist?: string
  completed: boolean
}

export type IndexedProjectRow = {
  projectId: string
  projectName: string
  crmDealId: string | null
  dealName: string | null
  accountName: string | null
  aliases: string[]
  chargeCodes: ChargeCode[]
}

/**
 * A project nobody can log to is noise in the matcher and a wasted task fetch. Zoho reports
 * status as free text, so this excludes what is definitely finished rather than including
 * only what is definitely open — an unfamiliar status stays in the index.
 */
const CLOSED_STATUSES = new Set([
  'closed',
  'archived',
  'completed',
  'cancelled',
  'canceled',
])

export function isLoggable(project: ZohoProject): boolean {
  const status = project.status?.trim().toLowerCase()
  return !status || !CLOSED_STATUSES.has(status)
}

/**
 * The short names people actually say.
 *
 * `STE-100013 - Clayco: MS Data Center` is nobody's spoken reference to a job. `nameFragments`
 * strips the id prefix and splits on the separators Stelic's naming uses, so "Clayco" and
 * "MS Data Center" both become things the matcher can hit directly. The account and deal
 * names join them, because those are equally likely to be what someone says.
 */
export function aliasesFor(project: ZohoProject, deal: CrmDeal | undefined): string[] {
  const candidates = [
    ...nameFragments(project.name),
    ...(deal?.dealName ? nameFragments(deal.dealName) : []),
    ...(deal?.accountName ? [deal.accountName] : []),
  ]

  const seen = new Set<string>()
  const aliases: string[] = []
  for (const candidate of candidates) {
    const trimmed = candidate.trim()
    // A one- or two-character fragment matches everything and distinguishes nothing.
    if (trimmed.length < 3) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key) || key === project.name.trim().toLowerCase()) continue
    seen.add(key)
    aliases.push(trimmed)
  }
  return aliases
}

export function toChargeCodes(tasks: readonly ZohoTask[]): ChargeCode[] {
  return (
    tasks
      .filter((task) => task.name)
      .map((task) => ({
        taskId: task.id,
        taskName: task.name,
        tasklist: task.tasklist,
        completed: task.completed,
      }))
      // Open tasks first: when the bot offers chips, a finished task is the wrong first guess.
      .sort((a, b) => Number(a.completed) - Number(b.completed))
  )
}

export type BuildOptions = {
  /**
   * Cap on how many projects get their tasks fetched. Each is one call against a
   * 100-per-120s budget, so an unbounded walk of a large portal stalls behind backoff.
   * Projects are fetched in the order Zoho returns them, which is most-recent-first.
   */
  maxProjectsWithTasks?: number
  onProgress?: (done: number, total: number) => void
}

export type BuildResult = {
  rows: IndexedProjectRow[]
  /** Counts, for the log line and for telling the caller what it did not do. */
  stats: {
    projectsSeen: number
    projectsIndexed: number
    projectsWithTasksFetched: number
    dealsResolved: number
    dealsRequested: number
  }
}

export async function buildProjectIndex(
  clients: { projects: ZohoClient; crm: ZohoClient },
  options: BuildOptions = {},
): Promise<BuildResult> {
  const allProjects = await listProjects(clients.projects)
  const projects = allProjects.filter(isLoggable)

  // One batched CRM call for every deal at once, rather than one per project.
  const dealIds = projects
    .map((p) => p.crmDealId)
    .filter((id): id is string => Boolean(id))
  const deals = await fetchDealsByIds(clients.crm, dealIds)

  const limit = options.maxProjectsWithTasks ?? projects.length
  const rows: IndexedProjectRow[] = []
  let tasksFetched = 0

  for (const [position, project] of projects.entries()) {
    const deal = project.crmDealId ? deals.get(project.crmDealId) : undefined

    let chargeCodes: ChargeCode[] = []
    if (position < limit) {
      chargeCodes = toChargeCodes(await listTasks(clients.projects, project.id))
      tasksFetched += 1
    }

    rows.push({
      projectId: project.id,
      projectName: project.name,
      crmDealId: project.crmDealId ?? null,
      dealName: deal?.dealName ?? null,
      accountName: deal?.accountName ?? null,
      aliases: aliasesFor(project, deal),
      chargeCodes,
    })

    options.onProgress?.(position + 1, projects.length)
  }

  return {
    rows,
    stats: {
      projectsSeen: allProjects.length,
      projectsIndexed: rows.length,
      projectsWithTasksFetched: tasksFetched,
      dealsResolved: deals.size,
      dealsRequested: new Set(dealIds).size,
    },
  }
}
