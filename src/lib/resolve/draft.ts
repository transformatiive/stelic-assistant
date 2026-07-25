import type { PrismaClient } from '@/generated/prisma/client'
import { validateDescription } from './description'
import { parseHours } from './hours'
import { resolveDate } from './date'
import { resolveTask, type DraftEntry, type ResolveContext, type SlotName } from './entry'

/**
 * Storing a draft and applying answers to it (task 5.6).
 *
 * A draft is the conversation's working state between "I did 8 hours on Clayco" and the
 * commit. It expires, because a half-finished entry from three days ago is not something the
 * user still means — and confirming one silently would log time they have forgotten about.
 */

export const DRAFT_TTL_MS = 2 * 60 * 60 * 1000

export type StoredDraft = {
  id: string
  entries: DraftEntry[]
}

export async function saveDraft(
  db: PrismaClient,
  input: { conversationId: string; userId: string; entries: readonly DraftEntry[] },
  now: Date = new Date(),
): Promise<StoredDraft> {
  const draft = await db.draft.create({
    data: {
      conversationId: input.conversationId,
      userId: input.userId,
      entries: input.entries as unknown as object,
      expiresAt: new Date(now.getTime() + DRAFT_TTL_MS),
    },
    select: { id: true },
  })
  return { id: draft.id, entries: [...input.entries] }
}

export async function updateDraftEntries(
  db: PrismaClient,
  draftId: string,
  entries: readonly DraftEntry[],
): Promise<void> {
  await db.draft.update({
    where: { id: draftId },
    data: { entries: entries as unknown as object },
  })
}

/**
 * The user's live draft, if they have one.
 *
 * Expiry is checked here rather than swept by a job: a draft nobody comes back to costs one
 * row, and a background sweeper is a moving part that can fail silently.
 */
export async function loadPendingDraft(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<StoredDraft | null> {
  const draft = await db.draft.findFirst({
    where: { userId, status: 'pending', expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, entries: true },
  })
  if (!draft) return null
  return { id: draft.id, entries: draft.entries as unknown as DraftEntry[] }
}

export async function markDraftConfirmed(
  db: PrismaClient,
  draftId: string,
): Promise<void> {
  await db.draft.update({ where: { id: draftId }, data: { status: 'confirmed' } })
}

export async function discardDraft(db: PrismaClient, draftId: string): Promise<void> {
  await db.draft.update({ where: { id: draftId }, data: { status: 'cancelled' } })
}

/**
 * Apply one answer and re-resolve what it affects.
 *
 * Re-resolution is not a formality. Choosing a project changes which tasks exist, so a task
 * answered against the old project would be wrong; picking a project therefore clears and
 * recomputes the task slot. Nothing else cascades, so nothing else is touched — re-running
 * every slot would risk turning an already-answered field back into a question.
 */
export function applyAnswer(
  entries: readonly DraftEntry[],
  answer: { entryId: string; slot: SlotName; value: string },
  context: ResolveContext,
): DraftEntry[] {
  return entries.map((entry) => {
    if (entry.id !== answer.entryId) return entry

    switch (answer.slot) {
      case 'project': {
        const chosen = context.index.find((p) => p.projectId === answer.value)
        if (!chosen) return entry
        const project: DraftEntry['project'] = {
          status: 'resolved',
          projectId: chosen.projectId,
          projectName: chosen.projectName,
          accountName: chosen.accountName,
          why: 'you picked it',
        }
        // The task list belongs to the project, so it has to be recomputed, not kept.
        return { ...entry, project, task: resolveTask(project, null, context) }
      }

      case 'task': {
        const codes = context.chargeCodes.get(
          entry.project.status === 'resolved' ? entry.project.projectId : '',
        )
        const chosen = codes?.find((c) => c.taskId === answer.value)
        if (!chosen) return entry
        return {
          ...entry,
          task: {
            status: 'resolved',
            taskId: chosen.taskId,
            taskName: chosen.taskName,
            why: 'you picked it',
          },
        }
      }

      case 'date':
        return {
          ...entry,
          date: resolveDate(answer.value, {
            timeZone: context.timezone,
            now: context.now,
          }),
        }

      case 'hours':
        return { ...entry, hours: parseHours(answer.value) }

      case 'description':
        return { ...entry, description: validateDescription(answer.value) }
    }
  })
}
