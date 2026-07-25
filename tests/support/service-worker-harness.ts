import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Runs `public/sw.js` for real, against a fake `self`.
 *
 * Asserting on the source text with regexes would pass for a worker that greps right and
 * behaves wrong — and the guarantee that matters here ("no `/api/*` response is ever cached")
 * is a behaviour, not a substring. So this builds just enough of the service-worker global to
 * execute the file and dispatch events at it.
 */

type Handler = (event: FakeEvent) => void

export type FakeEvent = {
  request: Request
  respondWith(promise: Promise<Response> | Response): void
  waitUntil(promise: Promise<unknown>): void
}

class FakeCache {
  readonly entries = new Map<string, Response>()

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(keyOf(request), response)
  }
  async match(request: Request | string): Promise<Response | undefined> {
    return this.entries.get(keyOf(request))
  }
  async addAll(requests: (Request | string)[]): Promise<void> {
    for (const request of requests) {
      this.entries.set(keyOf(request), new Response('shell'))
    }
  }
}

function keyOf(request: Request | string): string {
  return typeof request === 'string' ? request : new URL(request.url).pathname
}

export class ServiceWorkerHarness {
  readonly caches = new Map<string, FakeCache>()
  readonly handlers = new Map<string, Handler>()
  readonly fetched: string[] = []
  /** What the network answers, keyed by pathname. */
  network = new Map<string, () => Response>()
  skipWaitingCalled = false
  claimCalled = false

  private readonly cacheStorage = {
    open: async (name: string) => {
      const existing = this.caches.get(name)
      if (existing) return existing
      const created = new FakeCache()
      this.caches.set(name, created)
      return created
    },
    keys: async () => [...this.caches.keys()],
    delete: async (name: string) => this.caches.delete(name),
    match: async (request: Request | string) => {
      for (const cache of this.caches.values()) {
        const hit = await cache.match(request)
        if (hit) return hit
      }
      return undefined
    },
  }

  /** Seed a cache as though a previous version had populated it. */
  seedCache(name: string, path: string, body = 'stale'): void {
    const cache = new FakeCache()
    void cache.put(path, new Response(body))
    this.caches.set(name, cache)
  }

  load(): void {
    const source = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8')

    const self = {
      location: { origin: 'https://stelic.example' },
      addEventListener: (type: string, handler: Handler) => {
        this.handlers.set(type, handler)
      },
      skipWaiting: async () => {
        this.skipWaitingCalled = true
      },
      clients: {
        claim: async () => {
          this.claimCalled = true
        },
      },
    }

    const fetchImpl = async (request: Request | string) => {
      const path = keyOf(request)
      this.fetched.push(path)
      const responder = this.network.get(path)
      if (!responder) throw new TypeError('network unreachable')
      return responder()
    }

    // `new Function` rather than an import: the file is a service worker, not a module, and
    // it addresses globals (`self`, `caches`, `fetch`) that only exist inside one.
    const run = new Function(
      'self',
      'caches',
      'fetch',
      'Response',
      'URL',
      'Request',
      source,
    )
    run(self, this.cacheStorage, fetchImpl, Response, URL, Request)
  }

  /** Dispatch an event and wait for whatever it promised. */
  async dispatch(
    type: string,
    request?: Request,
  ): Promise<{ response?: Response | undefined; responded: boolean }> {
    const handler = this.handlers.get(type)
    if (!handler) throw new Error(`no handler registered for ${type}`)

    const waits: Promise<unknown>[] = []
    let responsePromise: Promise<Response> | Response | undefined

    handler({
      request: request as Request,
      respondWith: (value) => {
        responsePromise = value
      },
      waitUntil: (promise) => {
        waits.push(promise)
      },
    })

    await Promise.all(waits)
    if (responsePromise === undefined) return { responded: false }
    return { responded: true, response: await responsePromise }
  }

  /** Everything currently held in any cache, as pathnames. */
  cachedPaths(): string[] {
    return [...this.caches.values()].flatMap((cache) => [...cache.entries.keys()])
  }
}

/**
 * A navigation request.
 *
 * Duck-typed rather than a real `Request`: `mode: 'navigate'` cannot be constructed from
 * script — the browser reserves it for actual navigations — so a `new Request(...)` with it
 * throws. The worker reads `method`, `url` and `mode` and nothing else.
 */
export function navigationRequest(path: string): Request {
  return {
    url: `https://stelic.example${path}`,
    method: 'GET',
    mode: 'navigate',
  } as unknown as Request
}

export function assetRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://stelic.example${path}`, init)
}
