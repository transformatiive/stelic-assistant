import { describe, expect, it } from 'vitest'
import type { IndexedProjectRow } from '@/lib/index/build'
import {
  INDEX_MIN_RETRY_MS,
  INDEX_TTL_MS,
  isIndexStale,
  loadProjectIndex,
  saveProjectIndex,
} from '@/lib/index/store'
import { matchProject } from '@/lib/index/match'
import { FakeDb } from './support/fake-db'

const NOW = new Date('2026-07-25T12:00:00Z')
const TODAY = '2026-07-25'

function row(overrides: Partial<IndexedProjectRow> = {}): IndexedProjectRow {
  return {
    projectId: 'p1',
    projectName: 'STE-1 - Clayco: MS DC',
    crmDealId: 'd1',
    dealName: 'MS Data Center',
    accountName: 'Clayco',
    aliases: ['Clayco', 'MS DC'],
    chargeCodes: [{ taskId: 't1', taskName: 'Design', completed: false }] as
      { taskId: string; taskName: string; completed: boolean }[] | null,
    ...overrides,
  }
}

describe('saveProjectIndex', () => {
  it('writes a row per project', async () => {
    const db = new FakeDb()
    const result = await saveProjectIndex(
      db.client,
      [row(), row({ projectId: 'p2', projectName: 'Other' })],
      NOW,
    )
    expect(result).toEqual({ written: 2, removed: 0 })
    expect(db.projectIndexes).toHaveLength(2)
  })

  it('removes projects that have left the portal or closed', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row(), row({ projectId: 'p2' })], NOW)
    const result = await saveProjectIndex(db.client, [row()], NOW)

    expect(result.removed).toBe(1)
    expect(db.projectIndexes.map((r) => r.projectId)).toEqual(['p1'])
  })

  it('stores one copy of the portal, not one per person', async () => {
    // A per-user index made a scheduled rebuild impossible: 145 Zoho calls each, against a
    // 100-per-120-seconds limit.
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row(), row({ projectId: 'p2' })], NOW)
    await saveProjectIndex(db.client, [row(), row({ projectId: 'p2' })], NOW)

    expect(db.projectIndexes).toHaveLength(2)
  })

  it('updates a renamed project in place', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    await saveProjectIndex(db.client, [row({ projectName: 'Renamed' })], NOW)

    expect(db.projectIndexes).toHaveLength(1)
    expect(db.projectIndexes[0]!.projectName).toBe('Renamed')
  })
})

describe('recency, folded in at read time', () => {
  // Recency is computed rather than stored, which is what lets the index be shared: nothing
  // in the portal differs between users, and a per-user copy made a scheduled rebuild
  // impossible at 145 Zoho calls each.
  it('takes each project’s most recent successful log', async () => {
    const db = new FakeDb()
    await saveProjectIndex(
      db.client,
      [row(), row({ projectId: 'p2', projectName: 'Second', aliases: ['Second'] })],
      NOW,
    )
    db.commitLogs.push(
      {
        userId: 'u1',
        projectId: 'p1',
        status: 'success',
        logDate: new Date('2026-07-10'),
      },
      {
        userId: 'u1',
        projectId: 'p1',
        status: 'success',
        logDate: new Date('2026-07-22'),
      },
      {
        userId: 'u1',
        projectId: 'p2',
        status: 'success',
        logDate: new Date('2026-07-01'),
      },
    )

    const index = await loadProjectIndex(db.client, 'u1', { now: NOW })
    expect(index.find((p) => p.projectId === 'p1')?.lastLoggedAt).toBe('2026-07-22')
    expect(index.find((p) => p.projectId === 'p2')?.lastLoggedAt).toBe('2026-07-01')
  })

  it('is per user, over one shared index', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'success',
      logDate: new Date('2026-07-22'),
    })

    const mine = await loadProjectIndex(db.client, 'u1', { now: NOW })
    const theirs = await loadProjectIndex(db.client, 'u2', { now: NOW })

    expect(mine[0]!.lastLoggedAt).toBe('2026-07-22')
    expect(theirs[0]!.lastLoggedAt).toBeNull()
    // Same projects either way — only the recency differs.
    expect(mine.map((p) => p.projectId)).toEqual(theirs.map((p) => p.projectId))
  })

  it('ignores a failed commit — an attempt is not a log', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'failed',
      logDate: new Date('2026-07-22'),
    })
    expect(
      (await loadProjectIndex(db.client, 'u1', { now: NOW }))[0]!.lastLoggedAt,
    ).toBeNull()
  })

  it('ignores logs older than the window', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'success',
      logDate: new Date('2026-01-01'),
    })
    expect(
      (await loadProjectIndex(db.client, 'u1', { now: NOW }))[0]!.lastLoggedAt,
    ).toBeNull()
  })

  it('hands the matcher a civil date, not an instant', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'success',
      logDate: new Date('2026-07-22T23:30:00Z'),
    })
    expect((await loadProjectIndex(db.client, 'u1', { now: NOW }))[0]!.lastLoggedAt).toBe(
      '2026-07-22',
    )
  })

  it('is empty for a new user, which the matcher tolerates by design', async () => {
    // Zoho's portal-wide range read returns 6891 (design §5, task 6.11), so recency starts
    // from this app's own writes. The matcher caps recency below the resolve gap, so its
    // absence can only cost a tie-break — never a correct match.
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)

    const index = await loadProjectIndex(db.client, 'u1', { now: NOW })
    expect(index[0]!.lastLoggedAt).toBeNull()
    expect(matchProject('clayco', index, TODAY).status).toBe('resolved')
  })

  it('round-trips into a working match', async () => {
    const db = new FakeDb()
    await saveProjectIndex(
      db.client,
      [
        row(),
        row({ projectId: 'p2', projectName: 'STE-2 - Google: Ads', aliases: ['Google'] }),
      ],
      NOW,
    )
    const result = matchProject(
      'google',
      await loadProjectIndex(db.client, 'u1', { now: NOW }),
      TODAY,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('p2')
  })
})

describe('isIndexStale', () => {
  it('is stale when there is no index at all', async () => {
    expect(await isIndexStale(new FakeDb().client, NOW)).toBe(true)
  })

  it('is fresh just inside the TTL and stale just outside it', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)

    const justInside = new Date(NOW.getTime() + INDEX_TTL_MS - 1000)
    const justOutside = new Date(NOW.getTime() + INDEX_TTL_MS + 1000)
    expect(await isIndexStale(db.client, justInside)).toBe(false)
    expect(await isIndexStale(db.client, justOutside)).toBe(true)
  })
})

describe('an index with no charge codes is stale, however recent', () => {
  // Seen live: 145 projects indexed, 145 task reads rejected. The result was fresh by
  // timestamp and useless in substance — it could match a project but had nothing to log to,
  // and the next hour was spent trusting it.
  const codeless = () => row({ chargeCodes: [] })

  it('rebuilds once past the retry floor when nothing has a charge code', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [codeless()], NOW)

    const later = new Date(NOW.getTime() + INDEX_MIN_RETRY_MS + 1000)
    expect(await isIndexStale(db.client, later)).toBe(true)
  })

  it('does not rebuild on every page load', async () => {
    // A portal that genuinely has no tasks must not become a rate-limit problem.
    const db = new FakeDb()
    await saveProjectIndex(db.client, [codeless()], NOW)

    const soon = new Date(NOW.getTime() + 60_000)
    expect(await isIndexStale(db.client, soon)).toBe(false)
  })

  it('leaves a working index alone', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)

    const later = new Date(NOW.getTime() + INDEX_MIN_RETRY_MS + 1000)
    expect(await isIndexStale(db.client, later)).toBe(false)
  })

  it('still expires on age, charge codes or not', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    expect(
      await isIndexStale(db.client, new Date(NOW.getTime() + INDEX_TTL_MS + 1000)),
    ).toBe(true)
  })

  it('counts a single project with codes as enough', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [codeless(), row({ projectId: 'p2' })], NOW)
    const later = new Date(NOW.getTime() + INDEX_MIN_RETRY_MS + 1000)
    expect(await isIndexStale(db.client, later)).toBe(false)
  })
})

describe('a partial rebuild does not discard what it did not read', () => {
  it('keeps stored charge codes when a run reports null', async () => {
    // A throttled rebuild still writes every project. Overwriting the codes with an empty
    // list would make the bot ask about a task it knew yesterday.
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    expect(db.projectIndexes[0]!.chargeCodes).toHaveLength(1)

    await saveProjectIndex(db.client, [row({ chargeCodes: null })], NOW)
    expect(db.projectIndexes[0]!.chargeCodes).toHaveLength(1)
  })

  it('still updates the rest of the row', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row()], NOW)
    await saveProjectIndex(
      db.client,
      [row({ chargeCodes: null, projectName: 'Renamed' })],
      NOW,
    )
    expect(db.projectIndexes[0]!.projectName).toBe('Renamed')
  })

  it('writes an empty list for a project it has never seen', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, [row({ chargeCodes: null })], NOW)
    expect(db.projectIndexes[0]!.chargeCodes).toEqual([])
  })
})
