import { trigramSimilarity } from '@/lib/index/normalise'
import { daysBetween, parseIso } from './civil-date'
import type { DraftEntry } from './entry'

/**
 * Warnings shown on the confirmation card (task 5.7, design §4.4).
 *
 * Warnings, not blocks. Each one describes something that is *probably* a mistake and might
 * be perfectly deliberate — logging the same task twice in a day is normal, and so is
 * catching up on a fortnight of timesheets. The user confirms or edits; nothing is refused.
 *
 * **There is deliberately no daily-total warning.** The daily cap was abandoned as a policy
 * (open question 4), so this must not sum a user's day and warn on it. Reintroducing it as a
 * "helpful" warning would resurrect an abandoned rule through the back door.
 */

export type Warning =
  | { kind: 'possible_duplicate'; message: string; existingLogId?: string }
  | { kind: 'backdated'; message: string; days: number }

/** Above this, two descriptions are close enough that one of them is probably a re-entry. */
export const DUPLICATE_SIMILARITY = 0.8

export type ExistingLog = {
  projectId: string
  taskId: string
  /** `YYYY-MM-DD`. */
  date: string
  description: string
  logId?: string
}

/**
 * A duplicate is same user, same project, same task, same day, and a description that reads
 * like the same work. Same-day-same-task alone is not enough — two hours of drafting in the
 * morning and three in the afternoon are two honest entries.
 */
export function findDuplicate(
  entry: DraftEntry,
  existing: readonly ExistingLog[],
): ExistingLog | null {
  if (
    entry.project.status !== 'resolved' ||
    entry.task.status !== 'resolved' ||
    entry.date.status !== 'resolved' ||
    entry.description.status !== 'resolved'
  ) {
    return null
  }

  for (const log of existing) {
    if (log.projectId !== entry.project.projectId) continue
    if (log.taskId !== entry.task.taskId) continue
    if (log.date !== entry.date.date) continue
    if (
      trigramSimilarity(log.description, entry.description.description) >=
      DUPLICATE_SIMILARITY
    ) {
      return log
    }
  }
  return null
}

export function warningsFor(
  entry: DraftEntry,
  options: {
    today: string
    backdateWarnDays: number
    existingLogs?: readonly ExistingLog[]
  },
): Warning[] {
  const warnings: Warning[] = []

  const duplicate = findDuplicate(entry, options.existingLogs ?? [])
  if (duplicate) {
    warnings.push({
      kind: 'possible_duplicate',
      message: 'You already have a very similar entry on this task for that day.',
      existingLogId: duplicate.logId,
    })
  }

  if (entry.date.status === 'resolved') {
    const logDate = parseIso(entry.date.date)
    const today = parseIso(options.today)
    if (logDate && today) {
      // Positive means the log is in the past. A future date is blocked upstream, not warned.
      const days = daysBetween(logDate, today)
      if (days > options.backdateWarnDays) {
        warnings.push({
          kind: 'backdated',
          message: `That is ${days} days ago.`,
          days,
        })
      }
    }
  }

  return warnings
}

export function warningsForDraft(
  entries: readonly DraftEntry[],
  options: {
    today: string
    backdateWarnDays: number
    existingLogs?: readonly ExistingLog[]
  },
): Map<string, Warning[]> {
  const out = new Map<string, Warning[]>()
  for (const entry of entries) {
    const warnings = warningsFor(entry, options)
    if (warnings.length > 0) out.set(entry.id, warnings)
  }
  return out
}
