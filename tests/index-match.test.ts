import { describe, expect, it } from 'vitest'
import {
  type IndexedProject,
  matchProject,
  recencyBoost,
  scoreProject,
} from '@/lib/index/match'
import { nameFragments, normaliseName, tokenCoverage } from '@/lib/index/normalise'

const TODAY = '2026-07-22'

/**
 * Shaped like the real portal: names carry the account, an em dash, sometimes a job number,
 * and a descriptive tail. Two Clayco projects exist so ambiguity is exercised for real.
 */
const INDEX: IndexedProject[] = [
  {
    projectId: '1',
    projectName: 'Clayco — MS Data Center',
    accountName: 'Clayco',
    dealName: 'MS DC Phase 2 Commissioning',
    lastLoggedAt: '2026-07-20',
  },
  {
    projectId: '2',
    projectName: 'Clayco — Warehouse 4',
    accountName: 'Clayco',
    dealName: 'Warehouse 4 Fit-Out',
    lastLoggedAt: null,
  },
  {
    projectId: '3',
    projectName: 'Google LLC — 1080 - Google: Capital Projects Dashboard',
    accountName: 'Google LLC',
    dealName: 'Capital Projects Dashboard',
    lastLoggedAt: '2026-06-01',
  },
  {
    projectId: '4',
    projectName: 'Turner Construction — Riverside Bridge',
    accountName: 'Turner Construction',
    dealName: 'Riverside Bridge Rehab',
    aliases: ['riverside'],
    lastLoggedAt: null,
  },
  {
    projectId: '5',
    projectName: 'STE-100013 - Mortenson Airport Expansion',
    accountName: 'Mortenson',
    dealName: 'Airport Expansion Ph1',
    lastLoggedAt: null,
  },
]

const match = (q: string, index = INDEX) => matchProject(q, index, TODAY)

describe('normalisation', () => {
  it('strips job-number prefixes', () => {
    expect(normaliseName('STE-100013 - Mortenson Airport Expansion')).toBe(
      'mortenson airport expansion',
    )
    expect(normaliseName('1080 - Capital Projects')).toBe('capital projects')
  })

  it('strips accents and punctuation', () => {
    expect(normaliseName('Café  Réno—Phase 1')).toBe('cafe reno phase 1')
  })

  it('breaks a compound name into the parts a user might say', () => {
    const parts = nameFragments('Google LLC — 1080 - Google: Capital Projects Dashboard')
    expect(parts).toContain('google llc')
    expect(parts.some((p) => p.includes('capital projects dashboard'))).toBe(true)
  })

  it('scores token coverage on whole and prefix words', () => {
    expect(tokenCoverage('clayco', 'clayco ms data center')).toBe(1)
    expect(tokenCoverage('data center', 'clayco ms data center')).toBe(1)
    expect(tokenCoverage('clayco turner', 'clayco ms data center')).toBe(0.5)
  })
})

describe('recencyBoost', () => {
  it('is strongest today and gone after the window', () => {
    expect(recencyBoost(TODAY, TODAY)).toBeCloseTo(0.1)
    expect(recencyBoost('2026-05-01', TODAY)).toBe(0)
    expect(recencyBoost(null, TODAY)).toBe(0)
  })

  it('decays with age', () => {
    const recent = recencyBoost('2026-07-20', TODAY)
    const older = recencyBoost('2026-06-25', TODAY)
    expect(recent).toBeGreaterThan(older)
    expect(older).toBeGreaterThan(0)
  })

  it('never outweighs the text score enough to invent a match', () => {
    expect(recencyBoost(TODAY, TODAY)).toBeLessThan(0.15)
  })
})

describe('matchProject', () => {
  it('resolves an exact project name', () => {
    const result = match('Clayco — MS Data Center')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('1')
  })

  it('resolves a client name when only one project belongs to it', () => {
    const result = match('mortenson')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.match.project.projectId).toBe('5')
      // The word appears in both the account and the project name, so either attribution is
      // honest; what matters is that the text it reports back actually contains the match.
      expect(result.match.matchedText.toLowerCase()).toContain('mortenson')
    }
  })

  it('resolves via the deal name', () => {
    const result = match('riverside bridge rehab')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('4')
  })

  it('resolves via an alias', () => {
    const result = match('riverside')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('4')
  })

  it('survives a misspelling', () => {
    const result = match('mortensen airport')
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('5')
  })

  it('asks when a client has two projects and the user named only the client', () => {
    const result = match('clayco')
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      const ids = result.candidates.map((c) => c.project.projectId)
      expect(ids).toContain('1')
      expect(ids).toContain('2')
    }
  })

  it('distinguishes the two Clayco projects once the user says more', () => {
    const dc = match('clayco data center')
    expect(dc.status).toBe('resolved')
    if (dc.status === 'resolved') expect(dc.match.project.projectId).toBe('1')

    const wh = match('clayco warehouse')
    expect(wh.status).toBe('resolved')
    if (wh.status === 'resolved') expect(wh.match.project.projectId).toBe('2')
  })

  it('offers at most four options', () => {
    const crowded: IndexedProject[] = Array.from({ length: 8 }, (_, i) => ({
      projectId: `c${i}`,
      projectName: `Clayco — Site ${i}`,
      accountName: 'Clayco',
    }))
    const result = matchProject('clayco', crowded, TODAY)
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous')
      expect(result.candidates.length).toBeLessThanOrEqual(4)
  })

  it('returns no match for something absent, rather than the nearest thing', () => {
    expect(match('bechtel').status).toBe('no_match')
    expect(match('zzzzzz').status).toBe('no_match')
  })

  it('returns no match for an empty query', () => {
    expect(match('')).toEqual({ status: 'no_match' })
    expect(match('   ')).toEqual({ status: 'no_match' })
  })

  it('explains itself: every candidate names the field it matched on', () => {
    const result = match('clayco')
    if (result.status === 'ambiguous') {
      for (const c of result.candidates) {
        expect(['project', 'account', 'deal', 'alias']).toContain(c.matchedField)
        expect(c.matchedText.length).toBeGreaterThan(0)
      }
    }
  })

  it('does not let recency alone resolve an otherwise tied pair', () => {
    const tied: IndexedProject[] = [
      {
        projectId: 'a',
        projectName: 'Acme — Site One',
        accountName: 'Acme',
        lastLoggedAt: TODAY,
      },
      {
        projectId: 'b',
        projectName: 'Acme — Site Two',
        accountName: 'Acme',
        lastLoggedAt: null,
      },
    ]
    const result = matchProject('acme', tied, TODAY)
    // The maximum boost (0.1) is smaller than the required gap (0.15) by design, so a
    // recently-used project cannot silently win a genuine ambiguity.
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      const boosted = result.candidates.find((c) => c.project.projectId === 'a')!
      const unboosted = result.candidates.find((c) => c.project.projectId === 'b')!
      expect(boosted.recencyBoost).toBeGreaterThan(0)
      expect(unboosted.recencyBoost).toBe(0)
      expect(boosted.baseScore).toBe(unboosted.baseScore)
    }
  })

  it('catches a single-word misspelling of a client name', () => {
    const result = match('clacyo')
    // Two Clayco projects, so the right answer is to ask — but it must recognise the word
    // at all, which trigram similarity alone does not (it scores clacyo/clayco at ~0.33).
    expect(result.status).toBe('ambiguous')
    if (result.status === 'ambiguous') {
      expect(result.candidates.map((c) => c.project.projectId).sort()).toEqual(['1', '2'])
    }
  })

  it('resolves a misspelling when only one project can be meant', () => {
    const single: IndexedProject[] = [INDEX[0]!, INDEX[3]!, INDEX[4]!]
    const result = matchProject('clacyo', single, TODAY)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('1')
  })

  it('is deterministic for equal scores', () => {
    const a = match('clayco')
    const b = match('clayco')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('scores a project against nothing when the query is empty', () => {
    expect(scoreProject('', INDEX[0]!, TODAY)).toBeNull()
  })
})
