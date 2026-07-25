import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '@/app/manifest'
import {
  ServiceWorkerHarness,
  assetRequest,
  navigationRequest,
} from './support/service-worker-harness'
import { metadata, viewport } from '@/app/metadata'

const root = resolve(__dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path))

describe('the manifest', () => {
  const m = manifest()

  it('is installable: standalone, scoped, with a start url', () => {
    expect(m.display).toBe('standalone')
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(m.theme_color).toBe('#0b204b')
  })

  it('declares 192, 512 and a maskable variant', () => {
    const icons = m.icons ?? []
    expect(icons.map((i) => i.sizes)).toEqual(['192x192', '512x512', '512x512'])
    expect(icons.filter((i) => i.purpose === 'maskable')).toHaveLength(1)
  })

  it('ships every icon it declares', () => {
    // A manifest pointing at a missing file fails the install prompt silently.
    for (const icon of manifest().icons ?? []) {
      expect(() => read(`public${icon.src}`)).not.toThrow()
    }
  })

  it('has a short name that fits under a home-screen icon', () => {
    expect((m.short_name ?? '').length).toBeLessThanOrEqual(12)
  })
})

describe('iOS, which ignores the manifest', () => {
  it('declares itself web-app capable, or it launches into a Safari tab', () => {
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: 'Stelic' })
  })

  it('ships the apple-touch-icon it points at', () => {
    expect(() => read('public/apple-touch-icon.png')).not.toThrow()
  })

  it('keeps pinch-zoom available', () => {
    // PWA-10: no maximum-scale, no user-scalable: no.
    expect(viewport.maximumScale).toBeUndefined()
    expect(viewport.userScalable).toBeUndefined()
  })

  it('covers the notch, which the translucent status bar depends on', () => {
    expect(viewport.viewportFit).toBe('cover')
    const css = read('src/app/globals.css').toString()
    expect(css).toContain('env(safe-area-inset-top)')
  })
})

describe('the service worker, run for real', () => {
  function harness() {
    const sw = new ServiceWorkerHarness()
    sw.load()
    return sw
  }

  it('never caches an API response', async () => {
    // A cached timesheet is a wrong timesheet, and a cached /api/me would leave the last
    // person's name on a shared device.
    const sw = harness()
    sw.network.set('/api/entries/week', () => new Response('{"totalHours":8}'))

    const result = await sw.dispatch('fetch', assetRequest('/api/entries/week'))

    // Not intercepted at all — it goes straight to the network, untouched.
    expect(result.responded).toBe(false)
    expect(sw.cachedPaths()).not.toContain('/api/entries/week')
  })

  it('does not cache the login page either', async () => {
    const sw = harness()
    const result = await sw.dispatch('fetch', navigationRequest('/login'))
    expect(result.responded).toBe(false)
  })

  it('caches a static asset and serves it from cache next time', async () => {
    const sw = harness()
    let hits = 0
    sw.network.set('/icons/icon-192.png', () => {
      hits += 1
      return new Response('png')
    })

    await sw.dispatch('fetch', assetRequest('/icons/icon-192.png'))
    await sw.dispatch('fetch', assetRequest('/icons/icon-192.png'))

    expect(hits).toBe(1)
    expect(sw.cachedPaths()).toContain('/icons/icon-192.png')
  })

  it('serves a navigation from the network, so a new deploy is picked up', async () => {
    const sw = harness()
    sw.network.set('/', () => new Response('new build'))

    const result = await sw.dispatch('fetch', navigationRequest('/'))

    expect(await result.response!.text()).toBe('new build')
  })

  it('falls back to the cached shell when the network is unreachable', async () => {
    const sw = harness()
    sw.network.set('/', () => new Response('the shell'))
    await sw.dispatch('fetch', navigationRequest('/'))

    sw.network.delete('/')
    const offline = await sw.dispatch('fetch', navigationRequest('/'))

    expect(await offline.response!.text()).toBe('the shell')
  })

  it('explains itself when there is no cached shell either', async () => {
    const sw = harness()
    const result = await sw.dispatch('fetch', navigationRequest('/'))
    expect(result.response!.status).toBe(503)
    expect(await result.response!.text()).toMatch(/offline/i)
  })

  it('deletes caches from previous versions on activate', async () => {
    const sw = harness()
    sw.seedCache('stelic-shell-v0', '/old-thing')

    await sw.dispatch('activate')

    expect([...sw.caches.keys()]).not.toContain('stelic-shell-v0')
    expect(sw.claimCalled).toBe(true)
  })

  it('ignores a non-GET request', async () => {
    const sw = harness()
    const result = await sw.dispatch('fetch', assetRequest('/', { method: 'POST' }))
    expect(result.responded).toBe(false)
  })

  it('ignores a cross-origin request', async () => {
    const sw = harness()
    const result = await sw.dispatch('fetch', new Request('https://example.com/thing.js'))
    expect(result.responded).toBe(false)
  })

  it('takes over immediately on install, rather than waiting for every tab to close', async () => {
    const sw = harness()
    await sw.dispatch('install')
    expect(sw.skipWaitingCalled).toBe(true)
  })
})

describe('the proxy lets the shell through without a session', () => {
  const proxy = read('src/proxy.ts').toString()

  it('allows the files a browser fetches before anyone signs in', () => {
    for (const path of ['/manifest.webmanifest', '/sw.js', '/apple-touch-icon.png']) {
      expect(proxy).toContain(path)
    }
    expect(proxy).toContain("'/icons/'")
  })
})
