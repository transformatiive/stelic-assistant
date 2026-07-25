import type { DraftEntry, SlotName } from '@/lib/resolve/entry'
import type { Warning } from '@/lib/resolve/warnings'
import { blockedReason, chipsFor, entryState, type EntryState } from '@/lib/resolve/slots'

/**
 * What the client renders (tasks 7.1, 7.2, design §4.3).
 *
 * **The server decides what is shown.** The browser gets a payload describing a question or a
 * card, not the draft's internals — no project ids to pick from beyond the ones offered, no
 * slot machinery, no way to invent an option that was never on the screen. A chip's value is
 * only ever something the server put there.
 *
 * The wording lives here rather than in the model, because these are the sentences that have
 * to be right every time. A model asked to phrase "which project?" will eventually phrase it
 * as something else.
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
      draftId: string
      entryId: string
      slot: SlotName
      /** Empty where no finite candidate set exists — dates, hours, descriptions. */
      chips: Chip[]
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

/**
 * The question for one unresolved slot.
 *
 * Phrased against what the *user actually said* where that helps — "I couldn't find a project
 * matching 'clyaco'" is a better question than "which project?", because it tells them what
 * went wrong as well as what to do.
 */
export function questionText(entry: DraftEntry, slot: SlotName): string {
  switch (slot) {
    case 'project': {
      if (entry.project.status !== 'unresolved') return 'Which project?'
      if (entry.project.reason === 'ambiguous') {
        return `"${entry.said.project}" matches more than one project. Which one?`
      }
      if (entry.project.reason === 'no_match') {
        return `I couldn't find a project matching "${entry.said.project}". Which one did you mean?`
      }
      return 'Which project was that on?'
    }

    case 'task': {
      if (entry.task.status !== 'unresolved') return 'Which charge code?'
      if (entry.task.reason === 'none_available') {
        // No list to choose from — but no dead end either: Zoho lets anyone add a task, so
        // typing a name here creates one on confirm (CHAT-3's gap, closed by CHAT-7).
        return 'That project has no charge codes yet. Type what you worked on and I’ll add it as a new task when you confirm.'
      }
      return 'Which charge code? Tap one, or type a new task to add to the project.'
    }

    case 'date':
      return entry.date.status === 'unresolved' && entry.date.reason === 'unrecognised'
        ? `I couldn't work out the date from "${entry.said.date ?? ''}". Which day was it?`
        : 'Which day was that?'

    case 'hours':
      return 'How long did that take?'

    case 'description':
      if (entry.description.status === 'unresolved') {
        if (entry.description.reason === 'filler') {
          // The reason matters: this text goes on an invoice, and "work" does not survive a
          // client reading it.
          return 'That goes on the invoice, so it needs to say what you actually did. What was it?'
        }
        if (entry.description.reason === 'too_short') {
          return 'A little more detail — what did you work on?'
        }
      }
      return 'What did you work on?'
  }
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

export function questionUi(
  draftId: string,
  entry: DraftEntry,
  slot: SlotName,
): Extract<ChatUi, { kind: 'question' }> {
  return {
    kind: 'question',
    draftId,
    entryId: entry.id,
    slot,
    chips: chipsFor(entry, slot),
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
