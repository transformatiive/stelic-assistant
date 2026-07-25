import { describe, expect, it } from 'vitest'
import type { IndexedProjectRow } from '@/lib/index/build'
import {
  INDEX_TTL_MS,
  isIndexStale,
  loadProjectIndex,
  refreshRecency,
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
    chargeCodes: [{ taskId: 't1', taskName: 'Design', completed: false }],
    ...overrides,
  }
}

describe('saveProjectIndex', () => {
  it('writes a row per project', async () => {
    const db = new FakeDb()
    const result = await saveProjectIndex(
      db.client,
      'u1',
      [row(), row({ projectId: 'p2', projectName: 'Other' })],
      NOW,
    )
    expect(result).toEqual({ written: 2, removed: 0 })
    expect(db.projectIndexes).toHaveLength(2)
  })

  it('removes projects that have left the portal or closed', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row(), row({ projectId: 'p2' })], NOW)
    const result = await saveProjectIndex(db.client, 'u1', [row()], NOW)

    expect(result.removed).toBe(1)
    expect(db.projectIndexes.map((r) => r.projectId)).toEqual(['p1'])
  })

  it('leaves another user’s index alone', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row(), row({ projectId: 'p2' })], NOW)
    await saveProjectIndex(db.client, 'u2', [row()], NOW)

    expect(db.projectIndexes.filter((r) => r.userId === 'u1')).toHaveLength(2)
    expect(db.projectIndexes.filter((r) => r.userId === 'u2')).toHaveLength(1)
  })

  it('does not wipe recency when the portal is refreshed', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    db.projectIndexes[0]!.lastLoggedAt = new Date('2026-07-20T00:00:00Z')

    await saveProjectIndex(db.client, 'u1', [row({ projectName: 'Renamed' })], NOW)

    expect(db.projectIndexes[0]!.projectName).toBe('Renamed')
    expect(db.projectIndexes[0]!.lastLoggedAt).toEqual(new Date('2026-07-20T00:00:00Z'))
  })
})

describe('refreshRecency', () => {
  it('records each project’s most recent successful log', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row(), row({ projectId: 'p2' })], NOW)
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

    expect(await refreshRecency(db.client, 'u1', 60, NOW)).toBe(2)
    expect(db.projectIndexes[0]!.lastLoggedAt).toEqual(new Date('2026-07-22'))
    expect(db.projectIndexes[1]!.lastLoggedAt).toEqual(new Date('2026-07-01'))
  })

  it('ignores a failed commit — an attempt is not a log', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'failed',
      logDate: new Date('2026-07-22'),
    })

    expect(await refreshRecency(db.client, 'u1', 60, NOW)).toBe(0)
    expect(db.projectIndexes[0]!.lastLoggedAt).toBeNull()
  })

  it('ignores logs older than the window', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    db.commitLogs.push({
      userId: 'u1',
      projectId: 'p1',
      status: 'success',
      logDate: new Date('2026-01-01'),
    })
    expect(await refreshRecency(db.client, 'u1', 60, NOW)).toBe(0)
  })

  it('is empty for a new user, which the matcher tolerates by design', async () => {
    // Zoho's portal-wide range read returns 6891 (design §5, task 6.11), so recency starts
    // from this app's own writes. The matcher caps recency below the resolve gap, so its
    // absence can only cost a tie-break — never a correct match.
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    expect(await refreshRecency(db.client, 'u1', 60, NOW)).toBe(0)

    const index = await loadProjectIndex(db.client, 'u1')
    const result = matchProject('clayco', index, TODAY)
    expect(result.status).toBe('resolved')
  })
})

describe('loadProjectIndex', () => {
  it('hands the matcher a civil date, not an instant', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    db.projectIndexes[0]!.lastLoggedAt = new Date('2026-07-22T23:30:00Z')

    const [project] = await loadProjectIndex(db.client, 'u1')
    expect(project!.lastLoggedAt).toBe('2026-07-22')
  })

  it('reports no history as null rather than a date', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)
    expect((await loadProjectIndex(db.client, 'u1'))[0]!.lastLoggedAt).toBeNull()
  })

  it('round-trips into a working match', async () => {
    const db = new FakeDb()
    await saveProjectIndex(
      db.client,
      'u1',
      [
        row(),
        row({ projectId: 'p2', projectName: 'STE-2 - Google: Ads', aliases: ['Google'] }),
      ],
      NOW,
    )
    const result = matchProject('google', await loadProjectIndex(db.client, 'u1'), TODAY)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('p2')
  })
})

describe('isIndexStale', () => {
  it('is stale when there is no index at all', async () => {
    expect(await isIndexStale(new FakeDb().client, 'u1', NOW)).toBe(true)
  })

  it('is fresh just inside the TTL and stale just outside it', async () => {
    const db = new FakeDb()
    await saveProjectIndex(db.client, 'u1', [row()], NOW)

    const justInside = new Date(NOW.getTime() + INDEX_TTL_MS - 1000)
    const justOutside = new Date(NOW.getTime() + INDEX_TTL_MS + 1000)
    expect(await isIndexStale(db.client, 'u1', justInside)).toBe(false)
    expect(await isIndexStale(db.client, 'u1', justOutside)).toBe(true)
  })
})
