import type { ExtractedEntry } from '@/lib/extract/schema'
import type { ChargeCode } from '@/lib/index/build'
import { matchProject, type Candidate, type IndexedProject } from '@/lib/index/match'
import { validateDescription } from './description'
import { parseHours } from './hours'
import { resolveDate } from './date'
import { formatIso, todayIn } from './civil-date'

/**
 * Turning one extracted entry into a draft entry (design §4.2).
 *
 * Everything the model handed over is a *phrase*; everything here is a decision. The order
 * is fixed and each step is independent, so a missing description never prevents the project
 * from resolving — the bot can then ask one question instead of discovering problems one at
 * a time across three round trips.
 *
 * Three outcomes per slot, and the distinction matters:
 *
 * - **resolved** — usable.
 * - **unresolved** — we need to ask. The user can fix it.
 * - **blocked** — the answer is knowable and it is *no*. A future date is not a question,
 *   and asking one would imply it might be allowed.
 */

export type SlotName = 'project' | 'task' | 'date' | 'hours' | 'description'

export type ProjectSlot =
  | {
      status: 'resolved'
      projectId: string
      projectName: string
      accountName?: string | null
      why: string
    }
  | {
      status: 'unresolved'
      reason: 'missing' | 'ambiguous' | 'no_match'
      candidates: ProjectChoice[]
    }

export type ProjectChoice = {
  projectId: string
  projectName: string
  accountName?: string | null
  /** What the match hit on, so the bot can explain a chip rather than just offer it. */
  matchedText: string
}

export type TaskSlot =
  | { status: 'resolved'; taskId: string; taskName: string; why: string }
  | {
      status: 'unresolved'
      reason: 'none_available' | 'ambiguous' | 'unknown_project'
      candidates: ChargeCode[]
    }

export type DateSlot =
  | { status: 'resolved'; date: string }
  | { status: 'unresolved'; reason: 'missing' | 'unrecognised' }
  | { status: 'blocked'; reason: 'future'; date: string }

export type HoursSlot =
  | { status: 'resolved'; hours: number }
  | { status: 'unresolved'; reason: 'missing' | 'unrecognised' }
  | { status: 'blocked'; reason: 'too_small' | 'too_large'; hours: number }

export type DescriptionSlot =
  | { status: 'resolved'; description: string }
  | { status: 'unresolved'; reason: 'missing' | 'too_short' | 'filler' }

export type DraftEntry = {
  /** Stable within a draft, so an answer can name the entry it belongs to. */
  id: string
  /** The user's own words, kept for the confirmation card and for asking about the right thing. */
  said: { project: string; date: string | null }
  project: ProjectSlot
  task: TaskSlot
  date: DateSlot
  hours: HoursSlot
  description: DescriptionSlot
  billable: boolean
}

export type ResolveContext = {
  index: IndexedProject[]
  /** Charge codes per project id, from the index build. */
  chargeCodes: Map<string, ChargeCode[]>
  timezone: string
  /**
   * The instant the turn is being resolved at.
   *
   * Carried explicitly, and `today` derived from it, so the matcher's recency window and the
   * date resolver cannot disagree about what day it is. Two independent `new Date()` calls a
   * few milliseconds apart either side of midnight would log to different days.
   */
  now: Date
  defaultBillable: boolean
}

/** `YYYY-MM-DD` in the user's timezone, for the one instant this turn is resolving at. */
export function todayFor(context: Pick<ResolveContext, 'timezone' | 'now'>): string {
  return formatIso(todayIn(context.timezone, context.now))
}

function toChoice(candidate: Candidate): ProjectChoice {
  return {
    projectId: candidate.project.projectId,
    projectName: candidate.project.projectName,
    accountName: candidate.project.accountName,
    matchedText: candidate.matchedText,
  }
}

/** Why the bot chose this project, in words a person can check. */
function explain(candidate: Candidate): string {
  const where =
    candidate.matchedField === 'account'
      ? 'the client name'
      : candidate.matchedField === 'deal'
        ? 'the deal name'
        : candidate.matchedField === 'alias'
          ? 'a short name for it'
          : 'the project name'
  const recent = candidate.recencyBoost > 0 ? ', and you logged to it recently' : ''
  return `matched ${where} (${candidate.matchedText})${recent}`
}

export function resolveProject(query: string, context: ResolveContext): ProjectSlot {
  const result = matchProject(query, context.index, todayFor(context))

  if (result.status === 'resolved') {
    return {
      status: 'resolved',
      projectId: result.match.project.projectId,
      projectName: result.match.project.projectName,
      accountName: result.match.project.accountName,
      why: explain(result.match),
    }
  }

  if (result.status === 'ambiguous') {
    return {
      status: 'unresolved',
      reason: 'ambiguous',
      candidates: result.candidates.map(toChoice),
    }
  }

  return { status: 'unresolved', reason: 'no_match', candidates: [] }
}

/**
 * Which task to log against.
 *
 * The PCCR chain in design §4.2 needs a CRM user id, which nothing resolves yet (task 2.5),
 * and a rate sheet, which the live probe found on only 22 of 145 projects. So this falls
 * back to the project's own task list: exactly one task resolves silently, several become
 * chips, none is a blocked entry with something to say rather than a shrug.
 *
 * A `charge_code_hint` the user actually said — "as scheduler" — narrows the list first. If
 * it narrows to one, that is a resolution the user themselves supplied.
 */
export function resolveTask(
  projectSlot: ProjectSlot,
  hint: string | null,
  context: ResolveContext,
): TaskSlot {
  if (projectSlot.status !== 'resolved') {
    return { status: 'unresolved', reason: 'unknown_project', candidates: [] }
  }

  const all = context.chargeCodes.get(projectSlot.projectId) ?? []
  if (all.length === 0) {
    return { status: 'unresolved', reason: 'none_available', candidates: [] }
  }

  const narrowed = hint ? narrowByHint(all, hint) : all
  const candidates = narrowed.length > 0 ? narrowed : all

  if (candidates.length === 1) {
    const only = candidates[0]!
    return {
      status: 'resolved',
      taskId: only.taskId,
      taskName: only.taskName,
      why:
        narrowed.length === 1 && hint
          ? `matched "${hint}" to ${only.taskName}`
          : `${only.taskName} is the only task you can log to on this project`,
    }
  }

  return { status: 'unresolved', reason: 'ambiguous', candidates: candidates.slice(0, 6) }
}

function narrowByHint(codes: readonly ChargeCode[], hint: string): ChargeCode[] {
  const needle = hint.trim().toLowerCase()
  if (!needle) return []
  return codes.filter(
    (code) =>
      code.taskName.toLowerCase().includes(needle) ||
      (code.tasklist ?? '').toLowerCase().includes(needle),
  )
}

let counter = 0
/** Ids only need to be unique within one draft; they are never shown or stored elsewhere. */
function nextEntryId(): string {
  counter += 1
  return `e${counter}`
}

export function resolveEntry(
  extracted: ExtractedEntry,
  context: ResolveContext,
  entryId: string = nextEntryId(),
): DraftEntry {
  const project = resolveProject(extracted.project_query, context)

  return {
    id: entryId,
    said: { project: extracted.project_query, date: extracted.date_expression },
    project,
    task: resolveTask(project, extracted.charge_code_hint, context),
    date: resolveDate(extracted.date_expression, {
      timeZone: context.timezone,
      now: context.now,
    }),
    hours: parseHours(extracted.hours),
    description: validateDescription(extracted.description),
    // Null means "not stated", which is the configured default — not false (design §4.2).
    billable: extracted.billable ?? context.defaultBillable,
  }
}

export function resolveEntries(
  extracted: readonly ExtractedEntry[],
  context: ResolveContext,
): DraftEntry[] {
  return extracted.map((entry, i) => resolveEntry(entry, context, `e${i + 1}`))
}
