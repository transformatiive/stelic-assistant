import { z } from 'zod'

/**
 * The only two things the model is allowed to say (task 4.2, design §4.1).
 *
 * `tool_choice: "required"` means every turn comes back as one of these, never as prose the
 * app has to interpret. The validation below runs before anything downstream sees the
 * result, so a malformed tool call is a *failed extraction* — handled, degraded — rather
 * than a half-populated draft that looks fine until it bills the wrong client.
 *
 * Note what the model does **not** decide: it never sees the project index in full and never
 * returns a project id, a task id or a resolved date. It returns the user's own words, and
 * the deterministic resolver in §4.2 turns those into identifiers. That boundary is the
 * whole reason a wrong guess by the model cannot silently become a wrong time log.
 */

/** Zoho's own per-entry ceiling; anything beyond it is a parse error, not a long day. */
const MAX_HOURS = 24
const MIN_HOURS = 0.25

export const entrySchema = z.object({
  /**
   * The user's wording, verbatim — "clayco", not "STE-100013 - Clayco: MS Data Center".
   * The model guessing at the real project name would defeat the matcher, which is built to
   * score a human phrase against the index and explain what it matched on.
   */
  project_query: z.string().trim().min(1),

  /** Also verbatim — "yesterday", "last tuesday". Resolved downstream, in the user's timezone. */
  date_expression: z.string().trim().min(1).nullable(),

  /** Decimal hours. Null when the user did not say — never a default, never a guess. */
  hours: z.number().positive().max(MAX_HOURS).nullable(),

  description: z.string().trim().nullable(),

  /** Only when explicitly stated. Null means "use the configured default", not "false". */
  billable: z.boolean().nullable(),

  /** e.g. "as scheduler" — a hint for the charge-code chain, only if the user said it. */
  charge_code_hint: z.string().trim().nullable(),
})

export type ExtractedEntry = z.infer<typeof entrySchema>

export const submitTimeEntriesSchema = z.object({
  entries: z.array(entrySchema).min(1),
  reply: z.string().trim().min(1),
})

export const REPLY_INTENTS = ['question', 'week_summary', 'undo', 'smalltalk'] as const

export const replyOnlySchema = z.object({
  reply: z.string().trim().min(1),
  intent: z.enum(REPLY_INTENTS),
})

export type SubmitTimeEntries = z.infer<typeof submitTimeEntriesSchema>
export type ReplyOnly = z.infer<typeof replyOnlySchema>

export type Extraction =
  | ({ kind: 'submit_time_entries' } & SubmitTimeEntries)
  | ({ kind: 'reply_only' } & ReplyOnly)

/**
 * The same two shapes in OpenAI function format, which is what OpenRouter forwards.
 *
 * Written out by hand rather than generated from the Zod schemas. A generator would produce
 * `anyOf`/`$ref` constructs that some providers silently mishandle, and the descriptions here
 * are doing real work — they are the only place the model is told to quote the user rather
 * than interpret them.
 */
export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'submit_time_entries',
      description:
        'Record one or more timesheet entries the user described. Use this whenever the ' +
        'user is telling you about work they did, even if details are missing — leave a ' +
        'field null rather than guessing it.',
      parameters: {
        type: 'object',
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                project_query: {
                  type: 'string',
                  description:
                    'The project as the user referred to it, copied verbatim from their message. Do not expand abbreviations, correct spelling, or substitute a full project name.',
                },
                date_expression: {
                  type: ['string', 'null'],
                  description:
                    "The date as the user expressed it, copied verbatim — 'yesterday', 'last Tuesday', '7/8'. Do not convert it to a calendar date. Null if they did not say.",
                },
                hours: {
                  type: ['number', 'null'],
                  description:
                    'Hours as a decimal number. Null if the user did not state a duration. Never estimate.',
                },
                description: {
                  type: ['string', 'null'],
                  description:
                    'What the user said they did, in their own words. Null if they did not say. Never invent or embellish.',
                },
                billable: {
                  type: ['boolean', 'null'],
                  description:
                    'Only true or false if the user explicitly said so. Null otherwise.',
                },
                charge_code_hint: {
                  type: ['string', 'null'],
                  description:
                    "A role or charge code the user named, e.g. 'as scheduler'. Null otherwise.",
                },
              },
              required: [
                'project_query',
                'date_expression',
                'hours',
                'description',
                'billable',
                'charge_code_hint',
              ],
              additionalProperties: false,
            },
          },
          reply: {
            type: 'string',
            description:
              'A short, warm sentence acknowledging what you captured. Do not list the entries back — the app renders them.',
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
      name: 'reply_only',
      description:
        'Answer without recording anything: a question, a request to see the week, an undo, ' +
        'or ordinary conversation.',
      parameters: {
        type: 'object',
        properties: {
          reply: { type: 'string' },
          intent: { type: 'string', enum: [...REPLY_INTENTS] },
        },
        required: ['reply', 'intent'],
        additionalProperties: false,
      },
    },
  },
]

export type ParseResult =
  { status: 'ok'; extraction: Extraction } | { status: 'invalid'; reason: string }

/**
 * Validate a tool call into something the rest of the app can trust.
 *
 * Every failure returns `invalid` with a reason rather than throwing: the caller's answer to
 * a bad extraction is the guided form (CHAT-13), not a 500. The reason is for the log — it
 * is how we find out that a model has started drifting from the schema.
 */
export function parseToolCall(name: string, rawArguments: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(rawArguments)
  } catch {
    return { status: 'invalid', reason: 'arguments were not valid JSON' }
  }

  if (name === 'submit_time_entries') {
    const parsed = submitTimeEntriesSchema.safeParse(json)
    if (!parsed.success) {
      return { status: 'invalid', reason: describeIssues(parsed.error) }
    }
    return { status: 'ok', extraction: { kind: 'submit_time_entries', ...parsed.data } }
  }

  if (name === 'reply_only') {
    const parsed = replyOnlySchema.safeParse(json)
    if (!parsed.success) {
      return { status: 'invalid', reason: describeIssues(parsed.error) }
    }
    return { status: 'ok', extraction: { kind: 'reply_only', ...parsed.data } }
  }

  return { status: 'invalid', reason: `unknown tool ${name}` }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

/**
 * Hours below a quarter of an hour are almost always a unit slip — someone meaning minutes.
 * Rather than silently rounding 15 up to 0.25 or down to nothing, the entry keeps the value
 * and the resolver treats it as unresolved, so the bot asks.
 */
export function hoursLookImplausible(hours: number | null): boolean {
  return hours !== null && hours < MIN_HOURS
}
