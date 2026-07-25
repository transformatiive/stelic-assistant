import { describe, expect, it, vi } from 'vitest'
import { ZohoClient, type TokenSource } from '@/lib/zoho/client'
import { ZohoAuthError, ZohoHttpError, ZohoRateLimitError } from '@/lib/zoho/errors'

const BASE = 'https://projectsapi.zoho.com/restapi/portal/911636649/'

function tokenSource(mode: 'service' | 'user' = 'service'): TokenSource & {
  refreshCount: () => number
} {
  let refreshes = 0
  let current = 'token-0'
  return {
    mode,
    getAccessToken: async () => current,
    refreshAccessToken: async () => {
      refreshes += 1
      current = `token-${refreshes}`
      return current
    },
    refreshCount: () => refreshes,
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers })
}

/** Typed so `mock.calls[n]` is the real `fetch` parameter tuple, not an empty one. */
function fetchMock(...queued: Response[]) {
  const mock = vi.fn<typeof fetch>()
  if (queued.length === 0) mock.mockResolvedValue(jsonResponse({}))
  else {
    for (const response of queued) mock.mockResolvedValueOnce(response)
    mock.mockResolvedValue(queued[queued.length - 1]!.clone())
  }
  return mock
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

function client(
  fetchImpl: ReturnType<typeof fetchMock>,
  tokens = tokenSource(),
  overrides: Partial<ConstructorParameters<typeof ZohoClient>[0]> = {},
) {
  return new ZohoClient({
    baseUrl: BASE,
    tokens,
    fetchImpl,
    sleep: async () => {},
    random: () => 0.5,
    requestIdFactory: () => 'req-fixed',
    ...overrides,
  })
}

describe('ZohoClient', () => {
  it('injects the bearer header and the request id', async () => {
    const fetchImpl = fetchMock(jsonResponse({ projects: [] }))
    await client(fetchImpl).requestJson('projects/')

    const [, init] = fetchImpl.mock.calls[0]!
    const headers = headersOf(init)
    expect(headers.Authorization).toBe('Zoho-oauthtoken token-0')
    expect(headers['X-Request-Id']).toBe('req-fixed')
  })

  it('resolves paths against the portal base without dropping a segment', async () => {
    const fetchImpl = fetchMock()
    // No trailing slash on the base — the client must add one.
    const c = new ZohoClient({
      baseUrl: 'https://projectsapi.zoho.com/restapi/portal/911636649',
      tokens: tokenSource(),
      fetchImpl,
    })
    await c.requestJson('projects/')

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      'https://projectsapi.zoho.com/restapi/portal/911636649/projects/',
    )
  })

  it('drops undefined and null query parameters', async () => {
    const fetchImpl = fetchMock()
    await client(fetchImpl).requestJson('logs', {
      query: { users_list: '42', bill_status: undefined, component_type: null, index: 1 },
    })

    const url = new URL(String(fetchImpl.mock.calls[0]![0]))
    expect(url.searchParams.get('users_list')).toBe('42')
    expect(url.searchParams.get('index')).toBe('1')
    expect(url.searchParams.has('bill_status')).toBe(false)
    expect(url.searchParams.has('component_type')).toBe(false)
  })

  it('form-encodes a write body and sets the content type', async () => {
    const fetchImpl = fetchMock(jsonResponse({ timelog: {} }))
    await client(fetchImpl).requestJson('logs/', {
      method: 'POST',
      form: {
        date: '07-21-2026',
        hours: '08:00',
        bill_status: 'Billable',
        notes: undefined,
      },
    })

    const [, init] = fetchImpl.mock.calls[0]!
    const headers = headersOf(init)
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(init?.body).toBe('date=07-21-2026&hours=08%3A00&bill_status=Billable')
  })

  it('refreshes exactly once on 401 and retries with the new token', async () => {
    const tokens = tokenSource()
    const fetchImpl = fetchMock(
      jsonResponse({ error: 'invalid token' }, 401),
      jsonResponse({ projects: ['ok'] }),
    )

    const result = await client(fetchImpl, tokens).requestJson<{
      projects: string[]
    }>('projects/')

    expect(result.projects).toEqual(['ok'])
    expect(tokens.refreshCount()).toBe(1)
    const secondHeaders = headersOf(fetchImpl.mock.calls[1]![1])
    expect(secondHeaders.Authorization).toBe('Zoho-oauthtoken token-1')
  })

  it('gives up after a second 401 rather than refreshing in a loop', async () => {
    const tokens = tokenSource('user')
    const fetchImpl = fetchMock(jsonResponse({ error: 'invalid token' }, 401))

    await expect(client(fetchImpl, tokens).requestJson('logs/')).rejects.toBeInstanceOf(
      ZohoAuthError,
    )

    expect(tokens.refreshCount()).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('reports which credential mode failed to authenticate', async () => {
    const fetchImpl = fetchMock(jsonResponse({}, 401))
    const error = await client(fetchImpl, tokenSource('user'))
      .requestJson('logs/')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ZohoAuthError)
    expect((error as ZohoAuthError).mode).toBe('user')
    expect((error as ZohoAuthError).requestId).toBe('req-fixed')
  })

  it('backs off and retries on 429, then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = fetchMock(
      jsonResponse({}, 429),
      jsonResponse({}, 429),
      jsonResponse({ ok: true }),
    )

    const result = await client(fetchImpl, tokenSource(), {
      sleep,
    }).requestJson<{ ok: boolean }>('projects/')

    expect(result.ok).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('honours Retry-After over computed backoff', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = fetchMock(
      jsonResponse({}, 429, { 'retry-after': '3' }),
      jsonResponse({ ok: true }),
    )

    await client(fetchImpl, tokenSource(), { sleep }).requestJson('projects/')

    expect(sleep).toHaveBeenCalledWith(3000)
  })

  it('throws once the rate-limit retry budget is spent', async () => {
    const fetchImpl = fetchMock(jsonResponse({}, 429))

    const error = await client(fetchImpl, tokenSource(), {
      maxRateLimitRetries: 2,
    })
      .requestJson('projects/')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ZohoRateLimitError)
    expect((error as ZohoRateLimitError).attempts).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('surfaces other failures as ZohoHttpError with the body kept for logs', async () => {
    const fetchImpl = fetchMock(new Response('task not found', { status: 404 }))

    const error = await client(fetchImpl)
      .requestJson('projects/1/tasks/2/logs/')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ZohoHttpError)
    expect((error as ZohoHttpError).status).toBe(404)
    expect((error as ZohoHttpError).body).toBe('task not found')
  })

  it('never retries a 500 — that decision belongs to the commit pipeline', async () => {
    const fetchImpl = fetchMock(new Response('boom', { status: 500 }))

    await expect(
      client(fetchImpl).requestJson('logs/', { method: 'POST' }),
    ).rejects.toBeInstanceOf(ZohoHttpError)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('exposes the credential mode it was constructed with', () => {
    const fetchImpl = fetchMock()
    expect(client(fetchImpl, tokenSource('user')).mode).toBe('user')
    expect(client(fetchImpl, tokenSource('service')).mode).toBe('service')
  })

  it('shares one request id across a retry chain', async () => {
    const fetchImpl = fetchMock(jsonResponse({}, 401), jsonResponse({}))

    await client(fetchImpl).requestJson('projects/')

    const ids = fetchImpl.mock.calls.map((call) => headersOf(call[1])['X-Request-Id'])
    expect(new Set(ids).size).toBe(1)
  })

  it('logs an auth failure without the token', async () => {
    const warn = vi.fn()
    const fetchImpl = fetchMock(jsonResponse({}, 401))

    await client(fetchImpl, tokenSource(), {
      logger: { info: () => {}, warn },
    })
      .requestJson('projects/')
      .catch(() => {})

    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain('zoho.auth_failed')
    expect(logged).not.toContain('token-')
  })
})
