import { z } from 'zod'

/**
 * The Zoho OAuth component (tasks 2.1, 2.2, 2.8).
 *
 * Deliberately free of Next.js, Prisma and this app's config: everything it needs arrives as
 * arguments, and `fetch` is injectable. That keeps it unit-testable without a browser or a
 * network, and portable to the next Zoho-attached project.
 */

/**
 * Scopes this app needs. `ZohoProjects.users.ALL` is absent on purpose — the signed-in user
 * self-identifies via `GET /restapi/portals/` (`login_id`), so a portal-wide user list is not
 * required for login. See `design.md` §2.
 */
export const REQUIRED_SCOPES = [
  'ZohoProjects.projects.READ',
  'ZohoProjects.tasks.READ',
  'ZohoProjects.timesheets.ALL',
  'ZohoProjects.portals.READ',
  // Email and display name. `/restapi/portals/` identifies the caller by zuid only, and the
  // `User` row needs an email — it is the join key across CRM, Projects and Books.
  'AaaServer.profile.READ',
] as const

export type ZohoOAuthConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  /** e.g. `https://accounts.zoho.com` — the DC matters, tokens are not portable across them. */
  accountsDomain: string
}

export class ZohoOAuthError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ZohoOAuthError'
    this.code = code
  }
}

export function buildAuthorizeUrl(
  config: Pick<ZohoOAuthConfig, 'clientId' | 'redirectUri' | 'accountsDomain'>,
  params: { state: string; codeChallenge: string; scopes?: readonly string[] },
): string {
  const url = new URL('/oauth/v2/auth', config.accountsDomain)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('scope', (params.scopes ?? REQUIRED_SCOPES).join(','))
  // Without access_type=offline Zoho returns no refresh token, and the session dies in an
  // hour instead of lasting the 30 days AUTH-5 requires.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Zoho answers 200 with an `error` field rather than an HTTP error code. */
const tokenResponseSchema = z.union([
  z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().int().positive(),
    api_domain: z.string().optional(),
    token_type: z.string().optional(),
    scope: z.string().optional(),
  }),
  z.object({ error: z.string() }),
])

export type ZohoTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt: Date
  scope?: string
  apiDomain?: string
}

async function postToken(
  config: ZohoOAuthConfig,
  body: Record<string, string>,
  fetchImpl: typeof fetch,
  now: Date,
): Promise<ZohoTokens> {
  const url = new URL('/oauth/v2/token', config.accountsDomain)
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams(body).toString(),
    cache: 'no-store',
  })

  const text = await response.text()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ZohoOAuthError(
      'invalid_response',
      'Zoho returned a response we could not read',
    )
  }

  const parsed = tokenResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new ZohoOAuthError(
      'invalid_response',
      'Zoho returned an unexpected token payload',
    )
  }
  if ('error' in parsed.data) {
    throw new ZohoOAuthError(
      parsed.data.error,
      `Zoho rejected the request: ${parsed.data.error}`,
    )
  }

  const data = parsed.data
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Expire a minute early so a token cannot lapse mid-flight.
    expiresAt: new Date(now.getTime() + (data.expires_in - 60) * 1000),
    scope: data.scope,
    apiDomain: data.api_domain,
  }
}

export function exchangeCode(
  config: ZohoOAuthConfig,
  params: { code: string; codeVerifier: string },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ZohoTokens> {
  return postToken(
    config,
    {
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code: params.code,
      code_verifier: params.codeVerifier,
    },
    options.fetchImpl ?? fetch,
    options.now ?? new Date(),
  )
}

export function refreshAccessToken(
  config: ZohoOAuthConfig,
  refreshToken: string,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<ZohoTokens> {
  return postToken(
    config,
    {
      grant_type: 'refresh_token',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    },
    options.fetchImpl ?? fetch,
    options.now ?? new Date(),
  )
}

/**
 * Who is this token, and are they on our portal? (task 2.4, AUTH-3)
 *
 * `GET /restapi/portals/` works on an ordinary user token — unlike the portal *users* list,
 * which needs a scope the Stelic credential does not have. Verified against the live portal
 * 2026-07-25.
 */
const portalsResponseSchema = z.object({
  login_id: z.union([z.string(), z.number()]).optional(),
  portals: z
    .array(
      z.object({
        id_string: z.string().optional(),
        id: z.union([z.string(), z.number()]).optional(),
        name: z.string().optional(),
        role: z.string().optional(),
        login_zpuid: z.union([z.string(), z.number()]).optional(),
      }),
    )
    .default([]),
})

export type ZohoIdentity = {
  /** The user's zuid — what the time-log `owner` parameter takes. */
  zuid: string
  portalId: string
  portalName?: string
  role?: string
}

export type IdentityResult =
  | { status: 'ok'; identity: ZohoIdentity }
  | { status: 'not_a_member' }
  | { status: 'unreadable' }

export function readIdentity(body: unknown, expectedPortalId: string): IdentityResult {
  const parsed = portalsResponseSchema.safeParse(body)
  if (!parsed.success) return { status: 'unreadable' }

  const zuid = parsed.data.login_id
  if (zuid === undefined || String(zuid) === '') return { status: 'unreadable' }

  // `id_string` first: the numeric `id` exceeds Number.MAX_SAFE_INTEGER and JSON parsing
  // silently corrupts it. Same trap as project, task and log ids.
  const portal = parsed.data.portals.find(
    (p) => (p.id_string ?? String(p.id ?? '')) === expectedPortalId,
  )
  if (!portal) return { status: 'not_a_member' }

  return {
    status: 'ok',
    identity: {
      zuid: String(zuid),
      portalId: portal.id_string ?? String(portal.id ?? ''),
      portalName: portal.name,
      role: portal.role,
    },
  }
}

/**
 * Email and display name for the signed-in token (task 2.4, AUTH-3).
 *
 * `/restapi/portals/` answers *which portals* and *what zuid*, but never an email. This is
 * the accounts-server companion to it: same token, different host.
 */
const userInfoSchema = z.object({
  ZUID: z.union([z.string(), z.number()]).optional(),
  Email: z.string().optional(),
  Display_Name: z.string().optional(),
  First_Name: z.string().optional(),
  Last_Name: z.string().optional(),
})

export type ZohoProfile = {
  email: string
  displayName?: string
  zuid?: string
}

export function readProfile(body: unknown): ZohoProfile | null {
  const parsed = userInfoSchema.safeParse(body)
  if (!parsed.success) return null

  const email = parsed.data.Email?.trim().toLowerCase()
  if (!email) return null

  const fullName = [parsed.data.First_Name, parsed.data.Last_Name]
    .filter((p) => p && p.trim())
    .join(' ')
    .trim()

  return {
    email,
    displayName: parsed.data.Display_Name?.trim() || fullName || undefined,
    zuid: parsed.data.ZUID === undefined ? undefined : String(parsed.data.ZUID),
  }
}

export async function fetchProfile(
  accessToken: string,
  accountsDomain: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ZohoProfile | null> {
  const response = await (options.fetchImpl ?? fetch)(
    new URL('/oauth/user/info', accountsDomain).toString(),
    {
      headers: {
        Authorization: `Zoho-oauthtoken ${accessToken}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
    },
  )
  if (!response.ok) return null
  try {
    return readProfile(await response.json())
  } catch {
    return null
  }
}

export async function fetchIdentity(
  accessToken: string,
  expectedPortalId: string,
  options: { fetchImpl?: typeof fetch; projectsApiDomain?: string } = {},
): Promise<IdentityResult> {
  const domain = options.projectsApiDomain ?? 'https://projectsapi.zoho.com'
  const response = await (options.fetchImpl ?? fetch)(`${domain}/restapi/portals/`, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
  })
  if (!response.ok) return { status: 'unreadable' }
  try {
    return readIdentity(await response.json(), expectedPortalId)
  } catch {
    return { status: 'unreadable' }
  }
}
