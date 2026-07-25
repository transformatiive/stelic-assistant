import {
  dropFillerWords,
  fuzzyTokenCoverage,
  nameFragments,
  normalise,
  tokenCoverage,
  trigramSimilarity,
} from './normalise'

/**
 * Project matching (task 3.5, CHAT-2).
 *
 * A wrong match here silently bills the wrong client, so this is deliberately deterministic
 * and explainable: every result carries the field it matched on, which is what lets the bot
 * say "I matched *Clayco* to *Clayco — MS Data Center* because you logged to it last week"
 * rather than just asserting an answer.
 */

export type IndexedProject = {
  projectId: string
  projectName: string
  accountName?: string | null
  dealName?: string | null
  aliases?: string[]
  /** ISO date of this user's most recent log on the project, if any. */
  lastLoggedAt?: string | null
}

export type MatchedField = 'project' | 'account' | 'deal' | 'alias'

export type Candidate = {
  project: IndexedProject
  score: number
  baseScore: number
  recencyBoost: number
  matchedField: MatchedField
  matchedText: string
}

export type MatchResult =
  | { status: 'resolved'; match: Candidate; runnerUp: Candidate | null }
  | { status: 'ambiguous'; candidates: Candidate[] }
  | { status: 'no_match' }

/** Thresholds from `design.md` §4.2. */
export const RESOLVE_SCORE = 0.85
export const RESOLVE_GAP = 0.15
export const CANDIDATE_FLOOR = 0.45
export const MAX_CANDIDATES = 4
export const MAX_RECENCY_BOOST = 0.1
export const RECENCY_WINDOW_DAYS = 60

/**
 * Recency nudges ties apart; it must not manufacture a match on its own. Full boost for
 * something logged today, decaying to nothing at 60 days.
 */
export function recencyBoost(
  lastLoggedAt: string | null | undefined,
  today: string,
): number {
  if (!lastLoggedAt) return 0
  const last = Date.parse(`${lastLoggedAt}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(last) || Number.isNaN(now)) return 0
  const days = (now - last) / 86_400_000
  if (days < 0 || days > RECENCY_WINDOW_DAYS) return 0
  return MAX_RECENCY_BOOST * (1 - days / RECENCY_WINDOW_DAYS)
}

/**
 * Three views of "did they name this thing", combined by taking the best rather than
 * averaging — averaging lets a strong signal be dragged under the threshold by the two that
 * happen not to apply.
 *
 * - exact/prefix coverage: "clayco data center" naming all three words
 * - fuzzy coverage: "clacyo" and "mortensen", where the intent is obvious and the spelling is not
 * - trigram, discounted: substring overlap the word-based measures miss
 */
function fieldScore(query: string, value: string | null | undefined): number {
  if (!value) return 0
  let best = 0
  for (const fragment of nameFragments(value)) {
    const combined = Math.max(
      tokenCoverage(query, fragment),
      fuzzyTokenCoverage(query, fragment),
      // Trigram similarity works on character runs, not words, so it would otherwise still
      // see "project" shared between "etoe project" and every candidate that embeds this
      // portal's own naming convention. Stripped on both sides, symmetrically.
      trigramSimilarity(dropFillerWords(query), dropFillerWords(fragment)) * 0.9,
    )
    if (combined > best) best = combined
  }
  return best
}

export function scoreProject(
  query: string,
  project: IndexedProject,
  today: string,
): Candidate | null {
  const normalisedQuery = normalise(query)
  if (normalisedQuery === '') return null

  const fields: Array<{ field: MatchedField; text: string | null | undefined }> = [
    { field: 'project', text: project.projectName },
    { field: 'account', text: project.accountName },
    { field: 'deal', text: project.dealName },
    ...(project.aliases ?? []).map((a) => ({ field: 'alias' as const, text: a })),
  ]

  let bestScore = 0
  let bestField: MatchedField = 'project'
  let bestText = project.projectName

  for (const { field, text } of fields) {
    const score = fieldScore(normalisedQuery, text)
    if (score > bestScore) {
      bestScore = score
      bestField = field
      bestText = text ?? project.projectName
    }
  }

  if (bestScore === 0) return null

  const boost = recencyBoost(project.lastLoggedAt, today)
  return {
    project,
    baseScore: Number(bestScore.toFixed(4)),
    recencyBoost: Number(boost.toFixed(4)),
    score: Number(Math.min(bestScore + boost, 1).toFixed(4)),
    matchedField: bestField,
    matchedText: bestText,
  }
}

export function matchProject(
  query: string,
  index: IndexedProject[],
  today: string,
): MatchResult {
  const scored = index
    .map((project) => scoreProject(query, project, today))
    .filter((c): c is Candidate => c !== null)
    .sort(
      (a, b) =>
        b.score - a.score || a.project.projectName.localeCompare(b.project.projectName),
    )

  const best = scored[0]
  if (!best || best.score < CANDIDATE_FLOOR) return { status: 'no_match' }

  const runnerUp = scored[1] ?? null
  const gap = runnerUp ? best.score - runnerUp.score : Infinity

  if (best.score >= RESOLVE_SCORE && gap >= RESOLVE_GAP) {
    return { status: 'resolved', match: best, runnerUp }
  }

  return {
    status: 'ambiguous',
    candidates: scored.filter((c) => c.score >= CANDIDATE_FLOOR).slice(0, MAX_CANDIDATES),
  }
}
