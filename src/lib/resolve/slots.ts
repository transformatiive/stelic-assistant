import type { DraftEntry, SlotName } from './entry'

/**
 * Which question to ask next (task 5.5, design §4.3).
 *
 * One at a time, entry by entry, most-blocking first. The order is not cosmetic: the task
 * list depends on the project, so asking about hours before the project is settled risks
 * asking twice. And a person answering "which project?" then "which task?" is following a
 * thread; a person answering "how many hours?" then "which project?" is filling in a form.
 *
 * A **blocked** slot is not a question. A future date has no answer the user could give that
 * makes it acceptable, so it is reported and the entry is dropped from the commit — asking
 * would imply it might be allowed.
 */

/** Project first because task depends on it; description last because it blocks nothing. */
export const SLOT_ORDER: readonly SlotName[] = [
  'project',
  'task',
  'date',
  'hours',
  'description',
] as const

export type Question = {
  entryId: string
  slot: SlotName
  /** Present only where a finite candidate set exists. Free text is always accepted too. */
  chips: { value: string; label: string; hint?: string }[]
}

export type EntryState = 'ready' | 'needs_answer' | 'blocked'

export function unresolvedSlots(entry: DraftEntry): SlotName[] {
  return SLOT_ORDER.filter((slot) => entry[slot].status === 'unresolved')
}

export function blockedSlots(entry: DraftEntry): SlotName[] {
  return SLOT_ORDER.filter((slot) => entry[slot].status === 'blocked')
}

export function entryState(entry: DraftEntry): EntryState {
  if (blockedSlots(entry).length > 0) return 'blocked'
  return unresolvedSlots(entry).length > 0 ? 'needs_answer' : 'ready'
}

/**
 * The next question across the whole draft.
 *
 * Entries are walked in order and finished one at a time. Jumping between entries — "which
 * project for Monday? and for Tuesday? and how long on Monday?" — is how a two-entry
 * conversation becomes confusing.
 */
export function nextQuestion(entries: readonly DraftEntry[]): Question | null {
  for (const entry of entries) {
    if (entryState(entry) !== 'needs_answer') continue
    const slot = unresolvedSlots(entry)[0]
    if (!slot) continue
    return { entryId: entry.id, slot, chips: chipsFor(entry, slot) }
  }
  return null
}

export function chipsFor(entry: DraftEntry, slot: SlotName): Question['chips'] {
  if (slot === 'project' && entry.project.status === 'unresolved') {
    return entry.project.candidates.map((c) => ({
      value: c.projectId,
      label: c.projectName,
      // The client name disambiguates two projects with similar names better than an id.
      hint: c.accountName ?? undefined,
    }))
  }

  if (slot === 'task' && entry.task.status === 'unresolved') {
    return entry.task.candidates.map((c) => ({
      value: c.taskId,
      label: c.taskName,
      // The tasklist, never a rate — a rate on a chip is a rate on a screenshot.
      hint: c.tasklist,
    }))
  }

  // Dates, hours and descriptions have no finite candidate set worth guessing at.
  return []
}

/** Everything that can be committed, in order. */
export function readyEntries(entries: readonly DraftEntry[]): DraftEntry[] {
  return entries.filter((entry) => entryState(entry) === 'ready')
}

export function isDraftReady(entries: readonly DraftEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entryState(entry) === 'ready')
}

/**
 * Why an entry cannot be committed, in a sentence.
 *
 * Only for blocked slots — an unresolved one becomes a question, not an explanation.
 */
export function blockedReason(entry: DraftEntry): string | null {
  if (entry.date.status === 'blocked') {
    return `${entry.date.date} is in the future, and Zoho does not accept future time.`
  }
  if (entry.hours.status === 'blocked') {
    return entry.hours.reason === 'too_large'
      ? `${entry.hours.hours} hours is more than a day.`
      : `${entry.hours.hours} hours is less than the 15-minute minimum.`
  }
  return null
}
