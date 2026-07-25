/**
 * Reading the caller's address behind Railway's proxy.
 *
 * The IP is never stored raw — `store.ts` hashes it with a salt. It exists to spot a session
 * being used from somewhere implausible, not to track anybody.
 */
export function clientIpFrom(headers: Headers): string | null {
  // Railway sets `x-forwarded-for`; the client's own address is the first entry, the rest are
  // proxies. Taking the last would record our own edge on every row.
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('x-real-ip')?.trim() || null
}

/**
 * The app's own public origin, taken from the configured redirect URI.
 *
 * Not from `request.url`. Behind Railway's proxy the container sees `http://localhost:8080`,
 * so building a redirect against the incoming origin sends the browser to localhost — which
 * is exactly what a live smoke test of the callback did before this existed. The redirect URI
 * is the one value guaranteed to be the public origin: Zoho refuses the whole flow unless it
 * matches the registered one character for character, and config validates it as https.
 */
export function appOrigin(redirectUri: string): string {
  return new URL(redirectUri).origin
}

/**
 * Read one cookie out of a raw `Cookie` header.
 *
 * Route handlers reach for this rather than `next/headers` so the same code is callable from
 * a test with a plain `Request` and no Next.js request scope.
 */
export function readCookie(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}
