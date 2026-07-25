import { matchProject } from '@/lib/index/match'
import { parseHours } from '@/lib/resolve/hours'
import { resolveDate } from '@/lib/resolve/date'
import { validateDescription } from '@/lib/resolve/description'
import { todayFor, type DraftEntry, type ResolveContext } from '@/lib/resolve/entry'

/**
 * What the agent can do (CHAT-7, rewritten).
 *
 * The model runs the conversation; these are the only ways it can touch anything real. Two
 * are lookups it may call as often as it likes, and three end the turn.
 *
 * The boundary that matters has not moved: **the model never invents an identifier and never
 * resolves a date, an hours figure or a description itself.** It searches for a project and
 * gets ids back; it proposes entries by id and in the user's own words, and this file turns
 * those words into values — with the same resolvers the old slot machine used. A proposal
 * that fails validation is handed back to the model as a problem to ask about, not silently
 * dropped, which is what makes "I couldn't work out the date from ''" impossible now.
 */

export const AGENT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_projects',
      description:
        'Find projects the user might mean, by any wording — project name, client name, ' +
        'or an abbreviation. Call this before proposing any entry; you cannot know a ' +
        'project id any other way. Call it again with different wording if the first ' +
        'search is unconvincing.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: "The user's wording for the project, or part of it.",
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_charge_codes',
      description:
        'The tasks (charge codes) that already exist on a project. Time is logged against ' +
        'one of these, or against a new task you name in propose_entries.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'A project id returned by search_projects.',
          },
        },
        required: ['project_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ask_user',
      description:
        'Ask for something you genuinely need and cannot work out. Ends your turn. Offer ' +
        'options when there is a finite set worth tapping — they are shown as buttons and ' +
        'tapping one sends that exact text back. Never ask about something the user has ' +
        'already told you.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'One question, in your own words. Refer to what they said — "which Clayco ' +
              'project?" beats "which project?".',
          },
          options: {
            type: 'array',
            description:
              'Up to 6 tappable replies, each the literal text that will be sent back. ' +
              'Omit or leave empty when there is no finite set (a date, a duration, a ' +
              'description of the work).',
            items: { type: 'string' },
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'propose_entries',
      description:
        'Put one or more time entries on a confirmation card for the user to check and ' +
        'confirm. Nothing is written to Zoho until they tap confirm. One entry per project ' +
        'and day: "8h on Clayco Monday and Tuesday" is two entries. If anything you send ' +
        'is unusable you get the problems back and can ask about them.',
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                project_id: {
                  type: 'string',
                  description: 'From search_projects. Never guessed.',
                },
                task_id: {
                  type: ['string', 'null'],
                  description:
                    'From list_charge_codes. Null when using new_task_name instead.',
                },
                new_task_name: {
                  type: ['string', 'null'],
                  description:
                    'A task to add to the project, when the user wants one that does not ' +
                    'exist yet. Null when task_id is set. It is created on confirm.',
                },
                date: {
                  type: 'string',
                  description:
                    "The day, in the user's own words — 'yesterday', 'sat jul 25th', " +
                    "'7/8'. Do not convert it; it is resolved in their timezone.",
                },
                hours: { type: 'number', description: 'Decimal hours.' },
                description: {
                  type: 'string',
                  description:
                    'What they did, in their words. This goes on an invoice, so it must ' +
                    'say something — never "work" or "stuff".',
                },
                billable: {
                  type: ['boolean', 'null'],
                  description: 'Only when stated. Null uses the configured default.',
                },
              },
              required: [
                'project_id',
                'task_id',
                'new_task_name',
                'date',
                'hours',
                'description',
                'billable',
              ],
              additionalProperties: false,
            },
          },
          reply: {
            type: 'string',
            description:
              'A short sentence to show above the card. Do not list the entries back — ' +
              'the card shows them.',
          },
        },
        required: ['entries', 'reply'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'say',
      description:
        'Reply without recording anything, and end your turn. Use for ordinary ' +
        'conversation, for confirming you understood, and to decline anything that is not ' +
        'recording time.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          intent: {
            type: 'string',
            enum: ['smalltalk', 'week_summary', 'undo', 'refusal'],
            description:
              'week_summary opens their week; undo offers what can be removed; refusal is ' +
              'for anything outside recording time.',
          },
        },
        required: ['message', 'intent'],
        additionalProperties: false,
      },
    },
  },
]

/** How many projects a search hands back. Enough to choose from, few enough to read. */
export const SEARCH_LIMIT = 6

export type ProjectHit = {
  project_id: string
  name: string
  client?: string | undefined
}

/**
 * The project search, deterministic exactly as before — the model chooses *what* to search
 * for and *which* hit to use, but the scoring is the same matcher, and the ids come from the
 * index rather than from the model's imagination.
 */
export function searchProjects(query: string, context: ResolveContext): ProjectHit[] {
  const result = matchProject(query, context.index, todayFor(context))
  const hits =
    result.status === 'resolved'
      ? [result.match, ...(result.runnerUp ? [result.runnerUp] : [])]
      : result.status === 'ambiguous'
        ? result.candidates
        : []

  return hits.slice(0, SEARCH_LIMIT).map((candidate) => ({
    project_id: candidate.project.projectId,
    name: candidate.project.projectName,
    client: candidate.project.accountName ?? undefined,
  }))
}

export function listChargeCodes(
  projectId: string,
  context: ResolveContext,
): { task_id: string; name: string; tasklist?: string | undefined }[] {
  return (context.chargeCodes.get(projectId) ?? []).map((code) => ({
    task_id: code.taskId,
    name: code.taskName,
    // The tasklist, never a rate — a rate in a tool result is a rate in the model's context.
    tasklist: code.tasklist,
  }))
}

export type ProposedEntry = {
  project_id: string
  task_id?: string | null
  new_task_name?: string | null
  date: string
  hours: number
  description: string
  billable?: boolean | null
}

export type ProposalResult =
  | { ok: true; entries: DraftEntry[] }
  /** Handed back to the model, which asks the user about it in its own words. */
  | { ok: false; problems: string[] }

/**
 * Turn the model's proposal into draft entries, or into problems it has to resolve.
 *
 * Every value goes through the resolver that owns it — the model's `date` string is words,
 * not a date, until `resolveDate` says otherwise in the user's timezone. A blocked value (a
 * future date, 30 hours) is a problem, not a card: the old design put those on the card
 * marked "blocked", which meant the user had to notice. Telling the model instead means it
 * asks, which is what a person would do.
 */
export function buildEntries(
  proposed: readonly ProposedEntry[],
  context: ResolveContext,
): ProposalResult {
  const entries: DraftEntry[] = []
  const problems: string[] = []

  proposed.forEach((raw, i) => {
    const where = proposed.length > 1 ? ` (entry ${i + 1})` : ''

    const project = context.index.find((p) => p.projectId === raw.project_id)
    if (!project) {
      problems.push(
        `project_id "${raw.project_id}" is not a real project${where}. Use search_projects and take an id from its results.`,
      )
      return
    }

    const codes = context.chargeCodes.get(project.projectId) ?? []
    const chosen = raw.task_id ? codes.find((c) => c.taskId === raw.task_id) : undefined
    if (raw.task_id && !chosen) {
      problems.push(
        `task_id "${raw.task_id}" is not a charge code on ${project.projectName}${where}. Call list_charge_codes, or set new_task_name to add one.`,
      )
      return
    }
    const newTaskName = raw.new_task_name?.trim()
    if (!chosen && !newTaskName) {
      problems.push(
        `no task for ${project.projectName}${where}. Pick a task_id from list_charge_codes, or set new_task_name.`,
      )
      return
    }

    const date = resolveDate(raw.date, { timeZone: context.timezone, now: context.now })
    if (date.status === 'unresolved') {
      problems.push(`the date "${raw.date}"${where} could not be read. Ask which day.`)
      return
    }
    if (date.status === 'blocked') {
      problems.push(
        `${date.date}${where} is in the future, and Zoho does not accept future time. Ask which day they meant.`,
      )
      return
    }

    const hours = parseHours(raw.hours)
    if (hours.status !== 'resolved') {
      problems.push(
        hours.status === 'blocked'
          ? `${hours.hours} hours${where} is ${hours.reason === 'too_large' ? 'more than a day' : 'under the 15-minute minimum'}. Ask how long it actually took.`
          : `the hours${where} could not be read. Ask how long it took.`,
      )
      return
    }

    const description = validateDescription(raw.description)
    if (description.status !== 'resolved') {
      problems.push(
        description.reason === 'filler'
          ? `the description${where} says nothing that would make sense on an invoice. Ask what they actually did.`
          : `the description${where} is too short. Ask what they did.`,
      )
      return
    }

    entries.push({
      id: `e${entries.length + 1}`,
      said: { project: project.projectName, date: raw.date },
      project: {
        status: 'resolved',
        projectId: project.projectId,
        projectName: project.projectName,
        accountName: project.accountName,
        why: 'you chose it',
      },
      task: chosen
        ? {
            status: 'resolved',
            taskId: chosen.taskId,
            taskName: chosen.taskName,
            why: 'you chose it',
          }
        : {
            status: 'resolved',
            taskId: null,
            taskName: newTaskName!,
            why: 'a new task, added to the project when you confirm',
          },
      date,
      hours,
      description,
      billable: raw.billable ?? context.defaultBillable,
    })
  })

  return problems.length > 0 ? { ok: false, problems } : { ok: true, entries }
}
