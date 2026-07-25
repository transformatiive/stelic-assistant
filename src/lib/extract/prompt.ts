/**
 * The system prompt and the conversation window (tasks 4.3, 4.4).
 *
 * Two rules govern what goes in here. The prompt carries **no Zoho identifier, no rate and
 * no token** (design §4.1) — a leaked rate is a commercial problem and a leaked id invites
 * the model to guess one. And the recent projects are *hints*: they help the model quote the
 * user's wording back accurately, but the model never picks the project. That happens in the
 * deterministic matcher.
 */

export type PromptContext = {
  displayName?: string | null
  /** `YYYY-MM-DD` in the user's own timezone, computed by the caller with `todayIn`. */
  today: string
  timezone: string
  /** Names only — no ids, no rates. Capped by the caller at 8 (design §4.1). */
  recentProjects: { projectName: string; accountName?: string | null }[]
  /** Whether the app defaults an unstated entry to billable, so the model does not ask. */
  defaultBillable: boolean
}

export const MAX_PROJECT_HINTS = 8

export function buildSystemPrompt(context: PromptContext): string {
  const who = context.displayName?.trim()
  const hints = context.recentProjects
    .slice(0, MAX_PROJECT_HINTS)
    .map((p) =>
      p.accountName ? `- ${p.projectName} (${p.accountName})` : `- ${p.projectName}`,
    )

  return [
    'You help Stelic staff log time to Zoho Projects by chatting. You are brief and warm.',
    '',
    `Today is ${context.today} in the user's timezone (${context.timezone}).`,
    who ? `You are talking to ${who}.` : '',
    '',
    'RULES — these are not style preferences, they change what gets billed:',
    '- Never invent hours. If the user did not say how long, set hours to null.',
    '- Never invent a description. If they did not say what they did, set it to null.',
    '- Never invent or substitute a project. Copy their wording into project_query exactly',
    '  as they typed it, even if it is misspelled or abbreviated.',
    '- Never convert a date. Copy their wording into date_expression exactly — "yesterday",',
    '  "last Tuesday", "7/8". The app resolves it in their timezone.',
    '- Set billable only if they explicitly said so; otherwise null.',
    `- The app defaults unstated entries to ${context.defaultBillable ? 'billable' : 'non-billable'}, so do not ask about it.`,
    '- One entry per project-and-day. "8 hours on Clayco Monday and Tuesday" is two entries.',
    '- If they are asking a question, chatting, asking about their week, or undoing, use',
    '  reply_only. Do not record anything.',
    '',
    hints.length
      ? [
          'Projects this person has logged to recently, as hints for reading their wording.',
          'These are NOT a list to choose from — the app matches the project itself:',
          ...hints,
        ].join('\n')
      : 'You have no history for this person yet, so read their wording literally.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

/** Turns kept, and a character budget as a cheap stand-in for a token budget. */
export const MAX_TURNS = 12
export const MAX_HISTORY_CHARS = 8000

/**
 * The last few turns, newest-biased, within a budget (task 4.4).
 *
 * Trimmed from the **end backwards**: the most recent turns are the ones a follow-up like
 * "make that 6 hours" depends on, so dropping the oldest is the only safe direction. A single
 * turn longer than the whole budget is truncated rather than dropped, because dropping it
 * would silently remove the thing the user just said.
 */
export function windowConversation(
  history: readonly ChatMessage[],
  options: { maxTurns?: number; maxChars?: number } = {},
): ChatMessage[] {
  const maxTurns = options.maxTurns ?? MAX_TURNS
  const maxChars = options.maxChars ?? MAX_HISTORY_CHARS

  const recent = history.slice(-maxTurns)
  const kept: ChatMessage[] = []
  let used = 0

  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i]!
    const remaining = maxChars - used

    if (remaining <= 0) break

    if (message.content.length > remaining) {
      // Only worth keeping a fragment if it is the newest turn; an older half-message is
      // more confusing than absent. Marked so the model knows it is looking at a fragment.
      if (kept.length === 0) {
        kept.unshift({
          role: message.role,
          content: `…${message.content.slice(-remaining)}`,
        })
      }
      break
    }

    kept.unshift(message)
    used += message.content.length
  }

  return kept
}
