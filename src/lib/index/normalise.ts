/**
 * Text normalisation and similarity for project matching (task 3.5).
 *
 * Real project names look like `Google LLC — 1080 - Google: Capital Projects Dashboard` and
 * `STE-100013 - Mortenson Airport Expansion` (both observed in the live portal). Users say
 * "google" or "mortenson". Normalising both sides to the same shape is what makes that
 * comparison possible.
 */

/** Leading job/deal codes, matched against the *normalised* text: `ste 100013`, `1080`. */
const ID_PREFIX = /^(?:[a-z]{2,5} ?\d{3,}|\d{3,})\s+/

export function stripAccents(input: string): string {
  return input.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

export function normalise(input: string): string {
  return stripAccents(input)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

/** Normalise, then drop a leading id code. Lowercasing must happen first. */
export function normaliseName(input: string): string {
  return normalise(input).replace(ID_PREFIX, '').trim()
}

/**
 * Split a name into the parts a user might actually say. Both the stripped and unstripped
 * forms are kept, so a project legitimately starting with a number is never lost to the
 * prefix rule.
 */
export function nameFragments(input: string): string[] {
  const segments = input.split(/[—–\-:|]/).map(normaliseName)
  const all = [normalise(input), normaliseName(input), ...segments]
  return Array.from(new Set(all.filter((s) => s.length >= 2)))
}

/**
 * Words that discriminate nothing at this portal, because its own naming convention embeds
 * them in almost every project — "1020 - Project Farma", "1001 - Project Sabal" — so matching
 * on the word alone once inflated every project in the index into the same ambiguous bucket,
 * regardless of what the rest of the query actually named ("etoe project" matching four
 * unrelated projects that share nothing with "etoe"). Filtered only from the token list scored
 * for coverage, not from the name itself, so a project still displays under its full title.
 */
const FILLER_WORDS = new Set(['project'])

export function tokens(input: string): string[] {
  const norm = normalise(input)
  if (norm === '') return []
  return norm.split(' ').filter((word) => !FILLER_WORDS.has(word))
}

/**
 * The same filtering as {@link tokens}, rejoined to a string — for {@link trigramSimilarity},
 * which compares character runs rather than words and so would not otherwise see the filler
 * word removed at all. Scoped to project matching in `lib/index/match.ts`; the plain
 * {@link trigramSimilarity} stays untouched for its other caller (duplicate-description
 * warnings), where "project" is ordinary content, not naming-convention noise.
 */
export function dropFillerWords(input: string): string {
  return tokens(input).join(' ')
}

export function trigrams(input: string): Set<string> {
  const padded = ` ${normalise(input)} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3))
  return out
}

/** Sørensen–Dice over trigrams. Good on phrases, weak on single short words. */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a)
  const tb = trigrams(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const g of ta) if (tb.has(g)) shared += 1
  return (2 * shared) / (ta.size + tb.size)
}

/**
 * Jaro–Winkler, which is what actually catches the typos people make in a client name:
 * transpositions and a shared prefix. Trigram Dice scores `clacyo` against `clayco` at only
 * ~0.33, which would lose a real match; Jaro–Winkler scores it ~0.96.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (a.length === 0 || b.length === 0) return 0

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatched = new Array<boolean>(a.length).fill(false)
  const bMatched = new Array<boolean>(b.length).fill(false)

  let matches = 0
  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - window)
    const end = Math.min(i + window + 1, b.length)
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue
      aMatched[i] = true
      bMatched[j] = true
      matches += 1
      break
    }
  }
  if (matches === 0) return 0

  let transpositions = 0
  let k = 0
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue
    while (!bMatched[k]) k += 1
    if (a[i] !== b[k]) transpositions += 1
    k += 1
  }

  const m = matches
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3

  let prefix = 0
  for (let i = 0; i < Math.min(4, a.length, b.length); i += 1) {
    if (a[i] !== b[i]) break
    prefix += 1
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Below this, a Jaro–Winkler score is coincidence between unrelated words, not a typo. */
export const TYPO_THRESHOLD = 0.87

/** Fraction of the query's words present in the candidate, exact or prefix. */
export function tokenCoverage(query: string, candidate: string): number {
  const q = tokens(query)
  if (q.length === 0) return 0
  const c = tokens(candidate)
  if (c.length === 0) return 0
  let hits = 0
  for (const word of q) {
    if (
      c.some((other) => other === word || (word.length >= 4 && other.startsWith(word)))
    ) {
      hits += 1
    }
  }
  return hits / q.length
}

/**
 * Like {@link tokenCoverage} but tolerant of misspelling: each query word scores its best
 * match among the candidate's words, and anything below {@link TYPO_THRESHOLD} scores zero
 * so unrelated words cannot accumulate a passing total.
 */
export function fuzzyTokenCoverage(query: string, candidate: string): number {
  const q = tokens(query)
  if (q.length === 0) return 0
  const c = tokens(candidate)
  if (c.length === 0) return 0

  let total = 0
  for (const word of q) {
    let best = 0
    for (const other of c) {
      if (other === word) {
        best = 1
        break
      }
      if (word.length >= 4 && other.startsWith(word)) {
        best = Math.max(best, 0.95)
        continue
      }
      const jw = jaroWinkler(word, other)
      if (jw >= TYPO_THRESHOLD) best = Math.max(best, jw)
    }
    total += best
  }
  return total / q.length
}
