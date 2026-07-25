/**
 * Recorded-shape OpenRouter responses (task 4.7).
 *
 * Shaped exactly as the gateway returns them — `choices[0].message.tool_calls[0].function
 * .arguments` as a JSON *string*, `usage` alongside — so the parser is exercised on the real
 * envelope rather than on a convenient object. The eight cases are the ones task 4.7 names.
 */

export function completion(
  toolName: string,
  args: unknown,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    id: 'gen-01JABCDEF',
    model: 'anthropic/claude-sonnet-5',
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: toolName,
                arguments: typeof args === 'string' ? args : JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 812, completion_tokens: 96, cost: 0.00214 },
    ...overrides,
  })
}

const entry = (over: Record<string, unknown> = {}) => ({
  project_query: 'clayco',
  date_expression: 'yesterday',
  hours: 8,
  description: 'schedule updates and progress meeting',
  billable: null,
  charge_code_hint: null,
  ...over,
})

export const FIXTURES = {
  /** "8 hours on Clayco yesterday, schedule updates and progress meeting" */
  singleEntry: completion('submit_time_entries', {
    entries: [entry()],
    reply: 'Got it — one entry to review.',
  }),

  /** "4 on Clayco and 4 on the Google job today" */
  twoProjectsOneSentence: completion('submit_time_entries', {
    entries: [
      entry({ project_query: 'clayco', date_expression: 'today', hours: 4 }),
      entry({ project_query: 'the Google job', date_expression: 'today', hours: 4 }),
    ],
    reply: 'Two entries for today.',
  }),

  /** "8 hours on Clayco Monday, Tuesday and Wednesday" — one entry per day, not one of 24 */
  oneProjectThreeDays: completion('submit_time_entries', {
    entries: [
      entry({ date_expression: 'Monday' }),
      entry({ date_expression: 'Tuesday' }),
      entry({ date_expression: 'Wednesday' }),
    ],
    reply: 'Three days on Clayco.',
  }),

  /** "8 hours on Clayco yesterday" — no description; must be null, never invented */
  missingDescription: completion('submit_time_entries', {
    entries: [entry({ description: null })],
    reply: 'What were you working on?',
  }),

  /** "worked on Clayco yesterday" — no duration; must be null, never estimated */
  missingHours: completion('submit_time_entries', {
    entries: [entry({ hours: null })],
    reply: 'How long did that take?',
  }),

  /** "how many hours did I log this week?" */
  pureQuestion: completion('reply_only', {
    reply: 'Let me pull your week.',
    intent: 'week_summary',
  }),

  /** "asdkjhasd" — nothing to record, so reply_only rather than an invented entry */
  gibberish: completion('reply_only', {
    reply: "I didn't catch that — what did you work on?",
    intent: 'smalltalk',
  }),

  /** Arguments that are not JSON at all. */
  malformedToolCall: completion('submit_time_entries', 'entries: [ this is not json'),

  /** Schema-valid JSON, invalid content: the model invented a resolved date and zero hours. */
  schemaViolation: completion('submit_time_entries', {
    entries: [{ ...entry(), hours: 0 }],
    reply: 'Recorded.',
  }),

  /** `tool_choice: "required"` ignored by a provider — prose instead of a tool call. */
  noToolCall: JSON.stringify({
    id: 'gen-x',
    model: 'anthropic/claude-sonnet-5',
    choices: [
      { message: { role: 'assistant', content: 'Sure, I logged that for you.' } },
    ],
    usage: { prompt_tokens: 700, completion_tokens: 12, cost: 0.001 },
  }),

  /** A 200 carrying an upstream error, which OpenRouter does. */
  errorInBody: JSON.stringify({ error: { message: 'insufficient credits', code: 402 } }),
}
