import { describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy } from '@/proxy'

const ORIGIN = 'https://stelic-assistant-production.up.railway.app'

function request(path: string, cookie?: string) {
  return new NextRequest(new URL(path, ORIGIN), {
    headers: cookie ? { cookie } : undefined,
  })
}

const SIGNED_IN = 'stelic_session=abc123'

// AUTH-7: Unauthenticated access is refused consistently
describe('proxy (route middleware)', () => {
  it('answers an unauthenticated API call with 401 JSON', async () => {
    const response = proxy(request('/api/chat'))
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthenticated' })
  })

  it('redirects an unauthenticated page load to the login screen', () => {
    const response = proxy(request('/'))
    expect(response.status).toBe(307)
    expect(new URL(response.headers.get('location')!).pathname).toBe('/login')
  })

  it('remembers where a deep link was heading', () => {
    const location = new URL(proxy(request('/week?day=mon')).headers.get('location')!)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('returnTo')).toBe('/week?day=mon')
  })

  it('does not add a returnTo for the home page, which is the default anyway', () => {
    const location = new URL(proxy(request('/')).headers.get('location')!)
    expect(location.searchParams.has('returnTo')).toBe(false)
  })

  it('lets the auth routes and the login page through unauthenticated', () => {
    for (const path of [
      '/login',
      '/api/auth/login',
      '/api/auth/callback?code=x',
      '/api/auth/logout',
      '/manifest.webmanifest',
    ]) {
      expect(proxy(request(path)).status).toBe(200)
    }
  })

  it('lets a request carrying a session cookie proceed to the handler', () => {
    expect(proxy(request('/api/chat', SIGNED_IN)).status).toBe(200)
    expect(proxy(request('/', SIGNED_IN)).status).toBe(200)
  })

  it('passes a cookie through without judging it — the handler is the authority', () => {
    // Deliberate: the proxy cannot reach the database, so a forged id gets past here and
    // is refused by `requireApiSession`. Asserted so the split stays intentional.
    expect(proxy(request('/api/chat', 'stelic_session=forged')).status).toBe(200)
  })
})

describe('the scheduler has no session', () => {
  it('lets the cron route through, because it authenticates itself', () => {
    // Caught live: the proxy answered 401 before the route ran, so the schedule could never
    // have worked. The route checks a bearer secret and refuses to run without one
    // configured — it is session-free, not unauthenticated.
    expect(proxy(request('/api/cron/refresh-index')).status).toBe(200)
  })

  it('still refuses every other API route without a cookie', () => {
    for (const path of ['/api/chat', '/api/index/refresh', '/api/admin/zoho/connect']) {
      expect(proxy(request(path)).status).toBe(401)
    }
  })
})
