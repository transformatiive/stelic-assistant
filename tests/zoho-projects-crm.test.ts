import { describe, expect, it, vi } from 'vitest'
import { ZohoClient } from '@/lib/zoho/client'
import { PAGE_SIZE, _internal, listProjects, listTasks } from '@/lib/zoho/projects'
import { fetchDealsByIds, readDeal } from '@/lib/zoho/crm'

const { readProject, readTask } = _internal

function client(pages: unknown[]): {
  client: ZohoClient
  fetchImpl: ReturnType<typeof vi.fn>
} {
  let call = 0
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const body = pages[Math.min(call++, pages.length - 1)]
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
    })
  })
  return {
    fetchImpl,
    client: new ZohoClient({
      baseUrl: 'https://projectsapi.zoho.com/restapi/portal/911636649/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
    }),
  }
}

describe('id_string discipline', () => {
  // design §5: the numeric id exceeds Number.MAX_SAFE_INTEGER and JSON.parse corrupts it.
  it('prefers id_string over the corrupted numeric id', () => {
    const project = readProject({
      id: 2620762000000790000, // what JSON.parse produced
      id_string: '2620762000000790022', // what Zoho actually meant
      name: 'STE-100013 - Clayco: MS Data Center',
    })
    expect(project?.id).toBe('2620762000000790022')
  })

  it('refuses a numeric id that has already lost precision', () => {
    // No id_string to fall back on, and the number is past the safe range: guessing here
    // would address a different record, silently.
    expect(readProject({ id: 2620762000000790022, name: 'X' })).toBeNull()
    expect(readTask({ id: 9007199254740993, name: 'X' })).toBeNull()
  })

  it('accepts a small numeric id, which cannot have been corrupted', () => {
    expect(readProject({ id: 12345, name: 'X' })?.id).toBe('12345')
  })

  it('applies the same rule to tasks', () => {
    expect(
      readTask({ id: 111, id_string: '2620762000000750005', name: 'Design' })?.id,
    ).toBe('2620762000000750005')
  })
})

describe('readProject', () => {
  it('reads the CRM deal id from the documented column', () => {
    expect(
      readProject({ id_string: '1', name: 'P', crm_deal_id: '660000123' })?.crmDealId,
    ).toBe('660000123')
  })

  it('reads a numeric deal id as a string', () => {
    expect(
      readProject({ id_string: '1', name: 'P', crm_deal_id: 660000123 })?.crmDealId,
    ).toBe('660000123')
  })

  it('falls back to a custom field when the column is absent', () => {
    // The real envelope; see the dedicated block below for why this shape and not the
    // documented { label_name, value } one.
    const project = readProject({
      id_string: '1',
      name: 'P',
      custom_fields: [{ Entity: 'Stelic LLC' }, { 'CRM Deal ID': '660000999' }],
    })
    expect(project?.crmDealId).toBe('660000999')
  })

  it('reports no deal rather than an empty string', () => {
    expect(
      readProject({ id_string: '1', name: 'P', crm_deal_id: '  ' })?.crmDealId,
    ).toBeUndefined()
    expect(readProject({ id_string: '1', name: 'P' })?.crmDealId).toBeUndefined()
  })

  it('tolerates fields Zoho adds later', () => {
    expect(readProject({ id_string: '1', name: 'P', something_new: 42 })?.name).toBe('P')
  })
})

describe('readTask', () => {
  it('treats a closed status as completed', () => {
    expect(
      readTask({ id_string: '1', name: 'T', status: { type: 'closed' } })?.completed,
    ).toBe(true)
    expect(
      readTask({ id_string: '1', name: 'T', status: { type: 'open' } })?.completed,
    ).toBe(false)
  })

  it('prefers the explicit completed flag', () => {
    expect(
      readTask({ id_string: '1', name: 'T', completed: true, status: { type: 'open' } })
        ?.completed,
    ).toBe(true)
  })

  it('carries the tasklist, which is how a charge code is described', () => {
    expect(
      readTask({ id_string: '1', name: 'T', tasklist: { name: 'Phase 2' } })?.tasklist,
    ).toBe('Phase 2')
  })
})

describe('paging', () => {
  it('stops on a short page', async () => {
    const { client: c, fetchImpl } = client([
      {
        projects: Array.from({ length: PAGE_SIZE }, (_, i) => ({
          id_string: `p${i}`,
          name: `P${i}`,
        })),
      },
      { projects: [{ id_string: 'last', name: 'Last' }] },
    ])
    const projects = await listProjects(c)
    expect(projects).toHaveLength(PAGE_SIZE + 1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('asks for a 1-based index, as Zoho expects', async () => {
    const { client: c, fetchImpl } = client([
      {
        projects: Array.from({ length: PAGE_SIZE }, (_, i) => ({
          id_string: `p${i}`,
          name: 'P',
        })),
      },
      { projects: [] },
    ])
    await listProjects(c)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('index=1')
    expect(String(fetchImpl.mock.calls[1]![0])).toContain(`index=${PAGE_SIZE + 1}`)
  })

  it('stops on an empty page without looping forever', async () => {
    const { client: c, fetchImpl } = client([{ projects: [] }])
    expect(await listProjects(c)).toEqual([])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('survives a 204, which the logs endpoint really does return', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }))
    const c = new ZohoClient({
      baseUrl: 'https://projectsapi.zoho.com/restapi/portal/911636649/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
    })
    expect(await listTasks(c, 'p1')).toEqual([])
  })

  it('skips an unidentifiable row instead of failing the page', async () => {
    const { client: c } = client([
      { projects: [{ name: 'No id at all' }, { id_string: 'ok', name: 'Fine' }] },
    ])
    const projects = await listProjects(c)
    expect(projects.map((p) => p.id)).toEqual(['ok'])
  })
})

describe('CRM deals', () => {
  it('reads the deal and its account name', () => {
    expect(
      readDeal({
        id: '660000123',
        Deal_Name: 'MS Data Center',
        Account_Name: { id: '55', name: 'Clayco' },
      }),
    ).toEqual({ id: '660000123', dealName: 'MS Data Center', accountName: 'Clayco' })
  })

  it('tolerates a deal with no account', () => {
    expect(readDeal({ id: '1', Deal_Name: 'D', Account_Name: null })).toEqual({
      id: '1',
      dealName: 'D',
      accountName: undefined,
    })
  })

  it('batches ids and returns a lookup map', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'a', Deal_Name: 'Alpha', Account_Name: { name: 'Acme' } }],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    )
    const c = new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
    })

    const deals = await fetchDealsByIds(c, ['a', 'b', 'a', '', '  '])
    expect(deals.get('a')?.accountName).toBe('Acme')
    // Deduplicated and blank-stripped: one call, two ids.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('ids=a%2Cb')
  })

  it('makes no call at all when no project has a deal', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const c = new ZohoClient({
      baseUrl: 'https://www.zohoapis.com/crm/v8/',
      tokens: {
        mode: 'service',
        getAccessToken: async () => 'at',
        refreshAccessToken: async () => 'at',
      },
      fetchImpl,
    })
    expect((await fetchDealsByIds(c, [])).size).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

// Verified against all 145 live projects on 2026-07-25 via a temporary n8n probe.
describe('custom fields, as the live portal actually returns them', () => {
  const LIVE_SHAPE = [
    { 'CRM Deal ID': '7217638000003716102' },
    { 'Books Project ID': 'BOOKS-TEST-1066' },
    { 'Rate Sheet Name': 'Construction Management' },
    { 'Billing Model': 'T&M' },
    { Entity: 'Stelic LLC' },
    { 'BigTime Project SID': '11824079' },
    { Customer: 'Clayco Construction Company Inc' },
  ]

  it('reads one single-key object per field, not { label_name, value } pairs', () => {
    // The documented shape matched nothing, so every project silently lost its deal id and
    // its client name — 0 of 145, until the probe showed the real envelope.
    const project = readProject({
      id_string: '2620762000000565019',
      name: '1066 - 1066 - Clayco EKI Data Center',
      custom_fields: LIVE_SHAPE,
    })
    expect(project?.crmDealId).toBe('7217638000003716102')
    expect(project?.customerName).toBe('Clayco Construction Company Inc')
  })

  it('matches the label case-insensitively, so a rename of case cannot drop a field', () => {
    const project = readProject({
      id_string: '1',
      name: 'P',
      custom_fields: [{ 'crm deal ID': '123' }, { CUSTOMER: 'Acme' }],
    })
    expect(project?.crmDealId).toBe('123')
    expect(project?.customerName).toBe('Acme')
  })

  it('treats a blank value as absent', () => {
    const project = readProject({
      id_string: '1',
      name: 'P',
      custom_fields: [{ Customer: '   ' }, { 'CRM Deal ID': '' }],
    })
    expect(project?.customerName).toBeUndefined()
    expect(project?.crmDealId).toBeUndefined()
  })

  it('still prefers the documented column when a portal does populate it', () => {
    const project = readProject({
      id_string: '1',
      name: 'P',
      crm_deal_id: 'from-column',
      custom_fields: [{ 'CRM Deal ID': 'from-custom-field' }],
    })
    expect(project?.crmDealId).toBe('from-column')
  })

  it('survives a project with no custom fields at all', () => {
    expect(readProject({ id_string: '1', name: 'P' })?.customerName).toBeUndefined()
    expect(
      readProject({ id_string: '1', name: 'P', custom_fields: [] })?.crmDealId,
    ).toBeUndefined()
  })
})
