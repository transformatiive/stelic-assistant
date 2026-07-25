/**
 * The service worker (task 8.3, PWA-2).
 *
 * It caches the **shell** and nothing else. Not a single `/api/*` response is stored, and the
 * reason is not performance — a cached timesheet is a wrong timesheet. Someone opening the
 * app after logging six hours must not be shown yesterday's week from a cache, and a cached
 * `/api/me` would leave the last person's name on a shared device.
 *
 * Written by hand rather than generated. A generated worker brings a runtime, a config file
 * and a set of caching strategies, of which this app wants exactly one — and the failure mode
 * of getting a service worker wrong is a user stuck on a stale build with no way to clear it
 * from inside the app.
 *
 * Deliberately conservative in three ways:
 *
 * 1. **Only same-origin GETs are considered.** Anything else goes straight to the network.
 * 2. **Navigations are network-first.** A new deployment is picked up on the next launch
 *    rather than after a manual cache clear; the cached shell is the offline fallback, not
 *    the default answer.
 * 3. **Old caches are deleted on activate**, so a version bump cannot leave the previous
 *    build's assets lying around indefinitely.
 */

// Bump on any change to this file or to what it should serve.
const VERSION = 'v1'
const SHELL_CACHE = `stelic-shell-${VERSION}`

/** Enough to render something recognisable offline; the rest is fetched and cached as used. */
const SHELL = [
  '/',
  '/icons/icon-192.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // `reload` so an install never seeds the cache from the HTTP cache, which is how a
      // "new" worker ends up serving the previous build's shell.
      .then((cache) =>
        cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))),
      )
      // A shell asset that 404s must not fail the install — the worker is still useful.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== SHELL_CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

/** Anything that must never be cached, whatever else is true. */
function isNeverCacheable(url) {
  return (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/login') ||
    url.pathname === '/sw.js'
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (isNeverCacheable(url)) return

  // Navigations: network first, cached shell only when the network is unreachable. This is
  // what makes a new deployment appear without anyone clearing storage.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // `waitUntil`, not a floating promise: without it the browser may terminate the
          // worker the moment the response is returned, and the write silently never lands.
          event.waitUntil(cacheShell(response.clone()))
          return response
        })
        .catch(() => caches.match('/').then((cached) => cached ?? offlineResponse())),
    )
    return
  }

  // Static assets: cache first. Next fingerprints its build output, so a cached hit is
  // always the right file for the build that asked for it.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          // Only `ok`. There is no opaque-response check because cross-origin requests were
          // already returned above — this can only be a same-origin asset.
          if (response.ok) event.waitUntil(put(request, response.clone()))
          return response
        }),
    ),
  )
})

function cacheShell(response) {
  return put('/', response)
}

function put(request, response) {
  return caches.open(SHELL_CACHE).then((cache) => cache.put(request, response))
}

/** Last resort: a page that explains itself rather than the browser's dinosaur. */
function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Offline</title>' +
      '<body style="font-family:system-ui;background:#0b204b;color:#fff;display:grid;place-items:center;height:100dvh;margin:0">' +
      '<p style="max-width:24rem;text-align:center;padding:1.5rem">You’re offline. Your hours are safe — nothing is lost. Try again when you have a connection.</p>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } },
  )
}
