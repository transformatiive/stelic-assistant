import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import {
  PACE_MS,
  ZOHO_CALLS_PER_WINDOW,
  ZOHO_WINDOW_MS,
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
    const { rows, stats } = await buildProjectIndex(clients, { paceMs: 0 })

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
    await buildProjectIndex(clients, { paceMs: 0 })
    expect(seen.some((u) => u.includes('/projects/p2/tasks/'))).toBe(false)
  })

  it('asks CRM once for every deal, not once per project', async () => {
    const { clients, seen } = portal(routes)
    await buildProjectIndex(clients, { paceMs: 0 })
    expect(seen.filter((u) => u.includes('crm/v8/Deals'))).toHaveLength(1)
  })

  it('leaves a project with no deal unenriched rather than blank-named', async () => {
    const { clients } = portal(routes)
    const { rows } = await buildProjectIndex(clients, { paceMs: 0 })
    const internal = rows.find((r) => r.projectId === 'p3')!
    expect(internal.crmDealId).toBeNull()
    expect(internal.accountName).toBeNull()
    expect(internal.projectName).toBe('STE-3 - Internal')
  })

  it('still indexes a project whose deal CRM does not return', async () => {
    // d2 belongs to the closed project, so nothing here resolves — the row must survive.
    const { clients } = portal({ ...routes, 'crm/v8/Deals': { data: [] } })
    const { rows, stats } = await buildProjectIndex(clients, { paceMs: 0 })
    expect(rows).toHaveLength(2)
    expect(stats.dealsResolved).toBe(0)
    expect(rows[0]!.dealName).toBeNull()
  })

  it('honours the task-fetch cap, because tasks are one call each against a 100/120s limit', async () => {
    const { clients, seen } = portal(routes)
    const { rows, stats } = await buildProjectIndex(clients, {
      maxProjectsWithTasks: 1,
      paceMs: 0,
    })

    expect(stats.projectsWithTasksFetched).toBe(1)
    expect(seen.some((u) => u.includes('/projects/p3/tasks/'))).toBe(false)
    // The capped project is still indexed and still matchable — it just has no charge codes.
    expect(rows[1]!.projectId).toBe('p3')
    expect(rows[1]!.chargeCodes).toEqual([])
  })

  it('reports progress so a long rebuild is observable', async () => {
    const { clients } = portal(routes)
    const seenProgress: number[] = []
    await buildProjectIndex(clients, {
      paceMs: 0,
      onProgress: (done) => seenProgress.push(done),
    })
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
    const { rows, stats } = await buildProjectIndex(clients, { paceMs: 0 })

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
    const { rows, stats } = await buildProjectIndex(failing, { paceMs: 0 })

    expect(rows).toHaveLength(2)
    expect(rows[0]!.accountName).toBe('Google LLC')
    expect(stats.crmFailure).toBe('Error')
  })

  it('makes the long client name matchable by the short one people say', async () => {
    const { clients } = portal(LIVE_ROUTES)
    const { rows } = await buildProjectIndex(clients, { paceMs: 0 })

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
    const { rows } = await buildProjectIndex(clients, { paceMs: 0 })
    expect(rows[0]!.projectId).toBe('2620762000000790022')
  })
})

describe('one unreadable project does not lose the rest', () => {
  // Seen live: after ~60 projects one answered 400 and the whole rebuild aborted, leaving the
  // index empty. A portal of 145 projects will always contain one oddity.
  const ROUTES = {
    '/projects/?': {
      projects: [
        { id_string: 'p-good', name: 'Good', status: 'active' },
        { id_string: 'p-bad', name: 'Bad', status: 'active' },
        { id_string: 'p-also-good', name: 'Also good', status: 'active' },
      ],
    },
    '/projects/p-good/tasks/': { tasks: [{ id_string: 't1', name: 'Design' }] },
    '/projects/p-also-good/tasks/': { tasks: [{ id_string: 't2', name: 'Build' }] },
    'crm/v8/Deals': { data: [] },
  }

  function portalWithBadProject() {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/projects/p-bad/tasks/')) {
        return new Response(JSON.stringify({ code: 6401, message: 'nope' }), {
          status: 400,
        })
      }
      const key = Object.keys(ROUTES).find((k) => url.includes(k))
      return new Response(JSON.stringify(key ? ROUTES[key as keyof typeof ROUTES] : {}), {
        headers: { 'content-type': 'application/json' },
      })
    })
    const make = (base: string) =>
      new ZohoClient({ baseUrl: base, tokens: TOKENS, fetchImpl, maxRateLimitRetries: 0 })
    return {
      projects: make('https://projectsapi.zoho.com/restapi/portal/911636649/'),
      crm: make('https://www.zohoapis.com/crm/v8/'),
    }
  }

  it('indexes every project, including the one whose tasks failed', async () => {
    const { rows, stats } = await buildProjectIndex(portalWithBadProject(), { paceMs: 0 })

    expect(rows.map((r) => r.projectId)).toEqual(['p-good', 'p-bad', 'p-also-good'])
    expect(stats.projectsWithTaskFailures).toBe(1)
    expect(stats.projectsWithTasksFetched).toBe(2)
  })

  it('leaves the failed project matchable, just without charge codes', async () => {
    const { rows } = await buildProjectIndex(portalWithBadProject(), { paceMs: 0 })
    const bad = rows.find((r) => r.projectId === 'p-bad')!
    expect(bad.projectName).toBe('Bad')
    expect(bad.chargeCodes).toEqual([])
  })

  it('does not fail silently — the caller is told which project', async () => {
    const failures: string[] = []
    await buildProjectIndex(portalWithBadProject(), {
      paceMs: 0,
      onTaskFailure: (project) => failures.push(project.id),
    })
    expect(failures).toEqual(['p-bad'])
  })
})

describe('pacing, because a spent quota is not a 429', () => {
  // The live rebuild made exactly 100 successful task reads and then 45 failures — and they
  // came back as plain 400s, so the client's 429 backoff never fired. Waiting before the call
  // is the only defence; retrying is not one.
  const ROUTES = {
    '/projects/?': {
      projects: [
        { id_string: 'p1', name: 'One', status: 'active' },
        { id_string: 'p2', name: 'Two', status: 'active' },
        { id_string: 'p3', name: 'Three', status: 'active' },
      ],
    },
    '/projects/p1/tasks/': { tasks: [] },
    '/projects/p2/tasks/': { tasks: [] },
    '/projects/p3/tasks/': { tasks: [] },
    'crm/v8/Deals': { data: [] },
  }

  it('waits between task reads, but not before the first', async () => {
    const waits: number[] = []
    await buildProjectIndex(portal(ROUTES).clients, {
      paceMs: 1200,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    // Three projects, two gaps.
    expect(waits).toEqual([1200, 1200])
  })

  it('paces slower than the documented budget allows, not exactly at it', () => {
    // 100 calls per 120s is 1200ms; the margin covers the projects and CRM calls at the
    // start of a build, which spend from the same budget.
    expect(PACE_MS).toBeGreaterThan(ZOHO_WINDOW_MS / ZOHO_CALLS_PER_WINDOW)
  })

  it('does not wait for projects it is not fetching tasks for', async () => {
    const waits: number[] = []
    await buildProjectIndex(portal(ROUTES).clients, {
      paceMs: 1200,
      maxProjectsWithTasks: 1,
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(waits).toEqual([])
  })
})
