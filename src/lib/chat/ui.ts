import type { DraftEntry } from '@/lib/resolve/entry'
import type { Warning } from '@/lib/resolve/warnings'
import { blockedReason, entryState, type EntryState } from '@/lib/resolve/slots'

/**
 * What the client renders (tasks 7.1, 7.2, design §4.3).
 *
 * **The server decides what is shown.** The browser gets a payload describing a question or a
 * card, not the draft's internals — no project ids, no slot machinery, no way to act on
 * anything the server did not put on screen.
 *
 * The agent writes its own questions now (`agent.ts`); what is fixed here is the *card*,
 * because that is the screen between a sentence and an invoice line and its wording has to be
 * right every time.
 */

export type Chip = { value: string; label: string; hint?: string | undefined }

export type CardEntry = {
  entryId: string
  state: EntryState
  projectName: string | null
  taskName: string | null
  /** The task does not exist in Zoho yet — it is created when this card is confirmed. */
  taskIsNew: boolean
  date: string | null
  hours: number | null
  description: string | null
  billable: boolean
  /** Why the bot chose this project and task, in words a person can check. */
  why: { project?: string; task?: string }
  warnings: Warning[]
  /** Present for a blocked entry, where the answer is knowable and it is no. */
  blocked: string | null
}

export type ChatUi =
  | { kind: 'none' }
  | {
      kind: 'question'
      /**
       * Suggested replies, chosen by the agent. Tapping one sends that literal text as an
       * ordinary message — there is no typed slot value any more, because there is no slot
       * machine to feed. A chip is a shortcut for typing, nothing more, which is why typing
       * and tapping can no longer diverge (they were two code paths, and one of them broke).
       */
      options: string[]
    }
  | { kind: 'confirmation'; draftId: string; entries: CardEntry[]; totalHours: number }
  /** "What did I log this week?" — the client fetches `/api/entries/week` itself. */
  | { kind: 'week' }
  | { kind: 'undo'; candidates: UndoCandidate[] }

export type UndoCandidate = {
  commitLogId: string
  projectName: string
  taskName: string
  date: string
  hours: number
}

export function toCardEntry(
  entry: DraftEntry,
  warnings: readonly Warning[] = [],
): CardEntry {
  return {
    entryId: entry.id,
    state: entryState(entry),
    projectName: entry.project.status === 'resolved' ? entry.project.projectName : null,
    taskName: entry.task.status === 'resolved' ? entry.task.taskName : null,
    taskIsNew: entry.task.status === 'resolved' && entry.task.taskId === null,
    date: entry.date.status === 'resolved' ? entry.date.date : null,
    hours: entry.hours.status === 'resolved' ? entry.hours.hours : null,
    description:
      entry.description.status === 'resolved' ? entry.description.description : null,
    billable: entry.billable,
    why: {
      ...(entry.project.status === 'resolved' ? { project: entry.project.why } : {}),
      ...(entry.task.status === 'resolved' ? { task: entry.task.why } : {}),
    },
    warnings: [...warnings],
    blocked: blockedReason(entry),
  }
}

/**
 * The total on the card.
 *
 * Only resolved hours count. Showing a total that silently omits an unanswered entry would
 * be worse than showing none — someone checking "did I log eight hours today" would get a
 * confident wrong answer.
 */
export function totalHours(entries: readonly DraftEntry[]): number {
  const sum = entries.reduce(
    (total, entry) => total + (entry.hours.status === 'resolved' ? entry.hours.hours : 0),
    0,
  )
  return Math.round(sum * 100) / 100
}
