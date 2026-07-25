import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import {
  aliasesFor,
  buildProjectIndex,
  isLoggable,
  toChargeCodes,
} from '@/lib/index/build'
import { matchProject } from '@/lib/index/match'

const TODAY = '2026-07-25'

const TOKENS = {
  mode: 'service' as const,
  getAccessToken: async () => 'at',
  refreshAccessToken: async () => 'at',
}

/** Answers each URL from a table, so a test reads as "the portal contains this". */
function portal(routes: Record<string, unknown>) {
  const seen: string[] = []
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input)
    seen.push(url)
    const key = Object.keys(routes).find((k) => url.includes(k))
    const body = key ? routes[key] : {}
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  })
  const make = (base: string) =>
    new ZohoClient({ baseUrl: base, tokens: TOKENS, fetchImpl })
  return {
    seen,
    fetchImpl,
    clients: {
      projects: make('https://projectsapi.zoho.com/restapi/portal/911636649/'),
      crm: make('https://www.zohoapis.com/crm/v8/'),
    },
  }
}

describe('isLoggable', () => {
  it('keeps active projects', () => {
    expect(isLoggable({ id: '1', name: 'P', status: 'active' })).toBe(true)
    expect(isLoggable({ id: '1', name: 'P' })).toBe(true)
  })

  it('drops projects nobody can log to', () => {
    for (const status of ['closed', 'Archived', 'COMPLETED', 'cancelled', 'canceled']) {
      expect(isLoggable({ id: '1', name: 'P', status })).toBe(false)
    }
  })

  it('keeps a status it does not recognise, rather than hiding real work', () => {
    expect(isLoggable({ id: '1', name: 'P', status: 'on hold' })).toBe(true)
  })
})

describe('aliasesFor', () => {
  const project = { id: '1', name: 'STE-100013 - Clayco: MS Data Center' }

  it('produces the short names people actually say', () => {
    const aliases = aliasesFor(project, undefined).map((a) => a.toLowerCase())
    expect(aliases.some((a) => a.includes('clayco'))).toBe(true)
    expect(aliases.some((a) => a.includes('ms data center'))).toBe(true)
  })

  it('adds the account and deal names from CRM', () => {
    const aliases = aliasesFor(project, {
      id: 'd1',
      dealName: 'MS Data Center Phase 2',
      accountName: 'Clayco Inc',
    })
    expect(aliases).toContain('Clayco Inc')
  })

  it('drops fragments too short to distinguish anything', () => {
    for (const alias of aliasesFor({ id: '1', name: 'A - B: Real Name' }, undefined)) {
      expect(alias.length).toBeGreaterThanOrEqual(3)
    }
  })

  it('deduplicates case-insensitively', () => {
    const aliases = aliasesFor(
      { id: '1', name: 'Clayco - clayco' },
      {
        id: 'd',
        dealName: 'CLAYCO',
        accountName: 'Clayco',
      },
    )
    const lowered = aliases.map((a) => a.toLowerCase())
    expect(new Set(lowered).size).toBe(lowered.length)
  })

  it('feeds the matcher: the alias is enough to resolve the project', () => {
    const aliases = aliasesFor(project, undefined)
    const result = matchProject(
      'clayco',
      [
        { projectId: '1', projectName: project.name, aliases },
        {
          projectId: '2',
          projectName: 'STE-100020 - Google: Ads Migration',
          aliases: [],
        },
      ],
      TODAY,
    )
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') expect(result.match.project.projectId).toBe('1')
  })
})

describe('toChargeCodes', () => {
  it('puts open tasks first, so a finished one is never the first chip', () => {
    const codes = toChargeCodes([
      { id: 't1', name: 'Done thing', completed: true },
      { id: 't2', name: 'Live thing', completed: false },
    ])
    expect(codes.map((c) => c.taskId)).toEqual(['t2', 't1'])
  })

  it('drops a nameless task, which no chip could label', () => {
    expect(toChargeCodes([{ id: 't1', name: '', completed: false }])).toEqual([])
  })
})

describe('buildProjectIndex', () => {
  const routes = {
    '/projects/?': {
      projects: [
        {
          id_string: 'p1',
          name: 'STE-1 - Clayco: MS DC',
          status: 'active',
          crm_deal_id: 'd1',
        },
        { id_string: 'p2', name: 'STE-2 - Old Job', status: 'closed', crm_deal_id: 'd2' },
        { id_string: 'p3', name: 'STE-3 - Internal', status: 'active' },
      ],
    },
    '/projects/p1/tasks/': {
      tasks: [{ id_string: 't1', name: 'Design', completed: false }],
    },
    '/projects/p3/tasks/': {
      tasks: [{ id_string: 't9', name: 'Admin', completed: false }],
    },
    'crm/v8/Deals': {
      data: [{ id: 'd1', Deal_Name: 'MS Data Center', Account_Name: { name: 'Clayco' } }],
    },
  }

  it('indexes the loggable projects and enriches them from CRM', async () => {
    const { clients } = portal(routes)
    const { rows, stats } = await buildProjectIndex(clients)

    expect(rows.map((r) => r.projectId)).toEqual(['p1', 'p3'])
    expect(stats).toMatchObject({ projectsSeen: 3, projectsIndexed: 2, dealsResolved: 1 })

    const clayco = rows[0]!
    expect(clayco.accountName).toBe('Clayco')
    expect(clayco.dealName).toBe('MS Data Center')
    expect(clayco.chargeCodes).toEqual([
      { taskId: 't1', taskName: 'Design', tasklist: undefined, completed: false },
    ])
  })

  it('never fetches tasks for a closed project', async () => {
    const { clients, seen } = portal(routes)
    await buildProjectIndex(clients)
    expect(seen.some((u) => u.includes('/projects/p2/tasks/'))).toBe(false)
  })

  it('asks CRM once for every deal, not once per project', async () => {
    const { clients, seen } = portal(routes)
    await buildProjectIndex(clients)
    expect(seen.filter((u) => u.includes('crm/v8/Deals'))).toHaveLength(1)
  })

  it('leaves a project with no deal unenriched rather than blank-named', async () => {
    const { clients } = portal(routes)
    const { rows } = await buildProjectIndex(clients)
    const internal = rows.find((r) => r.projectId === 'p3')!
    expect(internal.crmDealId).toBeNull()
    expect(internal.accountName).toBeNull()
    expect(internal.projectName).toBe('STE-3 - Internal')
  })

  it('still indexes a project whose deal CRM does not return', async () => {
    // d2 belongs to the closed project, so nothing here resolves — the row must survive.
    const { clients } = portal({ ...routes, 'crm/v8/Deals': { data: [] } })
    const { rows, stats } = await buildProjectIndex(clients)
    expect(rows).toHaveLength(2)
    expect(stats.dealsResolved).toBe(0)
    expect(rows[0]!.dealName).toBeNull()
  })

  it('honours the task-fetch cap, because tasks are one call each against a 100/120s limit', async () => {
    const { clients, seen } = portal(routes)
    const { rows, stats } = await buildProjectIndex(clients, { maxProjectsWithTasks: 1 })

    expect(stats.projectsWithTasksFetched).toBe(1)
    expect(seen.some((u) => u.includes('/projects/p3/tasks/'))).toBe(false)
    // The capped project is still indexed and still matchable — it just has no charge codes.
    expect(rows[1]!.projectId).toBe('p3')
    expect(rows[1]!.chargeCodes).toEqual([])
  })

  it('reports progress so a long rebuild is observable', async () => {
    const { clients } = portal(routes)
    const seenProgress: number[] = []
    await buildProjectIndex(clients, { onProgress: (done) => seenProgress.push(done) })
    expect(seenProgress).toEqual([1, 2])
  })
})

// The live portal, as the probe found it on 2026-07-25.
describe('a portal where the client name rides on the project', () => {
  const LIVE_ROUTES = {
    '/projects/?': {
      projects: [
        {
          id: 2620762000000790000, // precision-corrupted, as all 145 live ids are
          id_string: '2620762000000790022',
          name: 'Google LLC — 1080 - Google: Capital Projects Dashboard',
          status: 'active',
          custom_fields: [
            { 'CRM Deal ID': '7217638000000702236' },
            { Customer: 'Google LLC' },
          ],
        },
        {
          id_string: '2620762000000565019',
          name: '1066 - 1066 - Clayco EKI Data Center',
          status: 'active',
          custom_fields: [
            { 'CRM Deal ID': '7217638000003716102' },
            { Customer: 'Clayco Construction Company Inc' },
          ],
        },
      ],
    },
    '/projects/2620762000000790022/tasks/': { tasks: [] },
    '/projects/2620762000000565019/tasks/': { tasks: [] },
    'crm/v8/Deals': { data: [] },
  }

  it('names the client from the project, with no CRM call needed', async () => {
    const { clients } = portal(LIVE_ROUTES)
    const { rows, stats } = await buildProjectIndex(clients)

    expect(rows[0]!.accountName).toBe('Google LLC')
    expect(rows[1]!.accountName).toBe('Clayco Construction Company Inc')
    // CRM returned nothing, yet every row still has a client name.
    expect(stats.dealsResolved).toBe(0)
    expect(stats.projectsWithAccountName).toBe(2)
  })

  it('keeps building when the CRM read fails outright', async () => {
    // A missing ZohoCRM scope must cost deal names, not the whole index.
    const { clients } = portal(LIVE_ROUTES)
    const failing = {
      projects: clients.projects,
      crm: {
        requestJson: async () => {
          throw new Error('Invalid OAuth scope')
        },
      } as unknown as (typeof clients)['crm'],
    }
    const { rows, stats } = await buildProjectIndex(failing)

    expect(rows).toHaveLength(2)
    expect(rows[0]!.accountName).toBe('Google LLC')
    expect(stats.crmFailure).toBe('Error')
  })

  it('makes the long client name matchable by the short one people say', async () => {
    const { clients } = portal(LIVE_ROUTES)
    const { rows } = await buildProjectIndex(clients)

    // Nobody types "Clayco Construction Company Inc".
    const index = rows.map((r) => ({
      projectId: r.projectId,
      projectName: r.projectName,
      accountName: r.accountName,
      aliases: r.aliases,
    }))
    const result = matchProject('clayco', index, TODAY)
    expect(result.status).toBe('resolved')
    if (result.status === 'resolved') {
      expect(result.match.project.projectId).toBe('2620762000000565019')
    }
  })

  it('uses id_string even though every live numeric id is corrupted', async () => {
    const { clients } = portal(LIVE_ROUTES)
    const { rows } = await buildProjectIndex(clients)
    expect(rows[0]!.projectId).toBe('2620762000000790022')
  })
})
