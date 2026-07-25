import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { listCrmUsers, resolveCrmUserId } from '@/lib/zoho/crm-users'
import { resolveBillingRole } from '@/lib/zoho/billing-role'
import { createRoleStamper } from '@/lib/commit/role-stamp'
import type { CommittableEntry } from '@/lib/commit/commit'
import { FakeDb } from './support/fake-db'

function zoho(responder: (url: string) => Response): {
  client: ZohoClient
  fetchImpl: ReturnType<typeof vi.fn>
} {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async (input) => responder(String(input)))
  return {
    fetchImpl,
    client: new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
      maxRateLimitRetries: 0,
    }),
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Trimmed from the live response, captured 2026-07-25. */
const USERS = {
  users: [
    {
      id: '7217638000000587001',
      zuid: '903491881',
      email: 'aviana@stelic.com',
      full_name: 'Alex Viana',
    },
    {
      id: '7217638000002090001',
      zuid: '917530087',
      email: 'nbarreto@stelic.com',
      full_name: 'Nuno Barreto',
    },
  ],
}

describe('finding the CRM user', () => {
  it('matches on the zuid, which is the id that crosses systems', async () => {
    const { client } = zoho(() => json(USERS))
    const users = await listCrmUsers(client)
    expect(users.find((u) => u.zuid === '917530087')?.id).toBe('7217638000002090001')
  })

  it('does not match on email, which differs by domain between systems', async () => {
    // The sign-in account and the CRM record need not share a domain, so an email match
    // would silently find nobody — and silently is the problem.
    const db = new FakeDb()
    const user = db.seedUser({
      zohoUserId: '917530087',
      email: 'nuno@somewhere-else.com',
      crmUserId: null,
    })
    const { client } = zoho(() => json(USERS))

    await expect(resolveCrmUserId(db.client, client, user)).resolves.toBe(
      '7217638000002090001',
    )
  })

  it('remembers it, so the whole company is not read twice', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    const { client, fetchImpl } = zoho(() => json(USERS))

    await resolveCrmUserId(db.client, client, user)
    expect(db.users[0]!.crmUserId).toBe('7217638000002090001')

    await resolveCrmUserId(db.client, client, {
      ...user,
      crmUserId: '7217638000002090001',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('returns nothing rather than failing when the person has no CRM record', async () => {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: 'nobody', crmUserId: null })
    const { client } = zoho(() => json(USERS))
    await expect(resolveCrmUserId(db.client, client, user)).resolves.toBeNull()
  })
})

describe('resolving the role', () => {
  const found = {
    data: [
      {
        id: '7217638000005766001',
        Labor_Category: 'Project Controls Analyst V',
        Hourly_Bill_Rate: '275.00',
        Hourly_Cost_Rate: '120.00',
        Deal: { name: '1080 - Google: Capital Projects Dashboard', id: 'deal_1' },
      },
    ],
  }

  it('asks the PCCR module for the deal and the person together', async () => {
    const { client, fetchImpl } = zoho(() => json(found))
    await resolveBillingRole(client, { crmDealId: 'deal_1', crmUserId: 'user_1' })

    const url = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(url.pathname).toContain('Project_Charge_Code_Rates/search')
    expect(url.searchParams.get('criteria')).toBe(
      '((Deal:equals:deal_1)and(Resource:equals:user_1))',
    )
  })

  it('returns the label and nothing else', async () => {
    // The row carries rates. A rate on a time log is a rate in a screenshot.
    const { client } = zoho(() => json(found))
    const role = await resolveBillingRole(client, {
      crmDealId: 'deal_1',
      crmUserId: 'user_1',
    })
    expect(role).toEqual({
      label: 'Project Controls Analyst V',
      recordId: '7217638000005766001',
    })
    expect(JSON.stringify(role)).not.toContain('275')
  })

  it('reads a 204 as nobody assigned, not as a failure', async () => {
    // This is the live answer today: PCCR rows exist per labor category with `Resource`
    // unpopulated, so the (deal, person) query matches nothing.
    const { client } = zoho(() => new Response(null, { status: 204 }))
    await expect(
      resolveBillingRole(client, { crmDealId: 'deal_1', crmUserId: 'user_1' }),
    ).resolves.toBeNull()
  })

  it('treats a row with a blank category as no role', async () => {
    const { client } = zoho(() => json({ data: [{ id: 'r1', Labor_Category: '  ' }] }))
    await expect(
      resolveBillingRole(client, { crmDealId: 'deal_1', crmUserId: 'user_1' }),
    ).resolves.toBeNull()
  })
})

describe('stamping the log', () => {
  const entry: CommittableEntry = {
    entryId: 'e1',
    projectId: 'p1',
    projectName: 'Clayco',
    taskId: 't1',
    taskName: 'Engineering',
    date: '2026-07-24',
    hours: 8,
    billable: true,
    description: 'Structural review',
  }

  function setup(crmResponder: (url: string) => Response) {
    const db = new FakeDb()
    const user = db.seedUser({ zohoUserId: '917530087', crmUserId: null })
    db.projectIndexes.push({
      projectId: 'p1',
      projectName: 'Clayco',
      projectIdString: 'p1',
      crmDealId: 'deal_1',
      dealName: null,
      accountName: null,
      aliases: [],
      chargeCodes: [],
      refreshedAt: new Date(),
    })
    const crm = zoho(crmResponder)
    const projects = zoho(() => json({ response: 'ok' }))
    return { db, user, crm, projects }
  }

  const withRole = (url: string) =>
    url.includes('users')
      ? json(USERS)
      : json({ data: [{ id: 'r1', Labor_Category: 'Project Controls Analyst V' }] })

  it('does nothing at all when the field name is not configured', () => {
    // Zoho addresses a custom field by an internal column name that is not derivable from
    // its label. Writing to a guessed one corrupts a field somebody else owns.
    const { db, user, crm, projects } = setup(withRole)
    const stamper = createRoleStamper({
      db: db.client,
      crm: crm.client,
      projects: projects.client,
      user,
    })
    expect(stamper).toBeUndefined()
  })

  it('writes the role onto the log', async () => {
    const { db, user, crm, projects } = setup(withRole)
    const stamper = createRoleStamper({
      db: db.client,
      crm: crm.client,
      projects: projects.client,
      user,
      field: 'UDF_CHAR1',
      logger: { info: () => {} },
    })!

    await stamper(entry, 'log_1')

    const [url, init] = projects.fetchImpl.mock.calls[0]!
    expect(String(url)).toContain('projects/p1/tasks/t1/logs/log_1/')
    expect(new URLSearchParams(String(init?.body)).get('UDF_CHAR1')).toBe(
      'Project Controls Analyst V',
    )
  })

  it('reads the company once for a multi-entry draft', async () => {
    const { db, user, crm, projects } = setup(withRole)
    const stamper = createRoleStamper({
      db: db.client,
      crm: crm.client,
      projects: projects.client,
      user,
      field: 'UDF_CHAR1',
      logger: { info: () => {} },
    })!

    await stamper(entry, 'log_1')
    await stamper({ ...entry, entryId: 'e2' }, 'log_2')

    const userCalls = crm.fetchImpl.mock.calls.filter((call) =>
      String(call[0]).includes('users'),
    )
    expect(userCalls).toHaveLength(1)
  })

  it('stamps nothing when nobody is assigned to the project', async () => {
    // The live case today, and the one TRNSF-914 specifies as "leave the field blank".
    // Deriving a role from the deal's rate rows would put a wrong labor category on an
    // invoice, and a wrong role is worse than a missing one because nobody looks twice.
    const info = vi.fn()
    const { db, user, crm, projects } = setup((url) =>
      url.includes('users') ? json(USERS) : new Response(null, { status: 204 }),
    )
    const stamper = createRoleStamper({
      db: db.client,
      crm: crm.client,
      projects: projects.client,
      user,
      field: 'UDF_CHAR1',
      logger: { info },
    })!

    await stamper(entry, 'log_1')

    expect(projects.fetchImpl).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith('role.unassigned', expect.anything())
  })

  it('stamps nothing when the project has no CRM deal', async () => {
    const { db, user, crm, projects } = setup(withRole)
    db.projectIndexes[0]!.crmDealId = null
    const stamper = createRoleStamper({
      db: db.client,
      crm: crm.client,
      projects: projects.client,
      user,
      field: 'UDF_CHAR1',
      logger: { info: () => {} },
    })!

    await stamper(entry, 'log_1')
    expect(projects.fetchImpl).not.toHaveBeenCalled()
  })
})
