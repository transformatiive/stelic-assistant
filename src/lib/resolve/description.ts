/**
 * The description guard (task 5.3).
 *
 * A description is mandatory and ends up on an invoice, so "work" is not an answer. This
 * rejects anything that is only filler, however many filler words are strung together
 * (CHAT-4).
 */

export const MIN_DESCRIPTION_LENGTH = 5

/** Words that carry no information about what was done. */
const FILLER = new Set([
  'work',
  'worked',
  'working',
  'stuff',
  'things',
  'misc',
  'miscellaneous',
  'general',
  'various',
  'other',
  'admin',
  'na',
  'n/a',
  'none',
  'nothing',
  'tbd',
  'tba',
  'x',
  'test',
  'asdf',
  'day',
  'hours',
  'time',
  'on',
  'the',
  'a',
  'and',
  'some',
  'it',
])

export type DescriptionResolution =
  | { status: 'resolved'; description: string }
  | { status: 'unresolved'; reason: 'missing' | 'too_short' | 'filler' }

export function normaliseDescription(input: string): string {
  return input.trim().replace(/\s+/g, ' ')
}

export function validateDescription(
  input: string | null | undefined,
): DescriptionResolution {
  if (input === null || input === undefined)
    return { status: 'unresolved', reason: 'missing' }

  const description = normaliseDescription(input)
  if (description === '') return { status: 'unresolved', reason: 'missing' }
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    return { status: 'unresolved', reason: 'too_short' }
  }

  const words = description
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter(Boolean)

  // Every word is filler → it says nothing, regardless of how long it is.
  if (words.length > 0 && words.every((w) => FILLER.has(w))) {
    return { status: 'unresolved', reason: 'filler' }
  }
  // Punctuation only, e.g. "....." or "-----".
  if (words.length === 0) return { status: 'unresolved', reason: 'filler' }

  return { status: 'resolved', description }
}
