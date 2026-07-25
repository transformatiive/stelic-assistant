import type { DraftEntry, SlotName } from './entry'

/**
 * Whether an entry can be committed, and why not.
 *
 * This file used to also decide **which question to ask next** — a fixed
 * project → task → date → hours → description walk that owned the conversation and could
 * only accept an answer shaped like the slot it happened to be on. The model owns the
 * conversation now (`lib/chat/agent.ts`), and that walk is gone rather than merely unused:
 * leaving it here would be leaving a second, worse controller one import away.
 *
 * What remains is the part that was never a matter of judgement. A blocked slot cannot be
 * logged whoever is asking, and an unresolved one means the entry is not finished.
 */

/** Every slot an entry has. Order carries no meaning any more — only membership does. */
const SLOTS: readonly SlotName[] = [
  'project',
  'task',
  'date',
  'hours',
  'description',
] as const

export type EntryState = 'ready' | 'needs_answer' | 'blocked'

export function entryState(entry: DraftEntry): EntryState {
  if (SLOTS.some((slot) => entry[slot].status === 'blocked')) return 'blocked'
  return SLOTS.some((slot) => entry[slot].status === 'unresolved')
    ? 'needs_answer'
    : 'ready'
}

/**
 * Why an entry cannot be committed, in a sentence.
 *
 * Only for blocked slots — an unresolved one is something to ask about, not to explain.
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
