import type { PrismaClient } from '@/generated/prisma/client'
import { encrypt } from './crypto'
import { OAUTH_STATE_MAX_AGE_SECONDS } from './oauth-state'
import type { ZohoTokens } from './zoho-oauth'

/**
 * Connecting the service credential from inside the app (task 0.1, revised).
 *
 * The original plan was to mint a refresh token by hand and paste it into
 * `ZOHO_SERVICE_REFRESH_TOKEN`. That failed in production with Zoho's `invalid_code`, and the
 * reason generalises: **a refresh token is bound to the OAuth client that issued it.** A token
 * produced by any other client — the old Stelic one, n8n's, a self client — cannot be
 * refreshed with this client's id and secret, no matter how carefully it is copied.
 *
 * Doing the handshake here removes the class of error rather than the instance. The token is
 * necessarily issued by the client the app is running as, because the app is the thing asking
 * for it. It is stored encrypted alongside the per-user tokens, which is where the app already
 * keeps refresh tokens, and it is preferred over the environment variable when present.
 *
 * Environment stays supported: a deployment that has a known-good token can still inject one,
 * and design §7's rule — credentials from the environment, never fetched from a vault at
 * runtime — is unchanged. This adds a way to *obtain* one, not a new place to fetch it from.
 */

export const SERVICE_CONNECT_COOKIE = 'stelic_service_oauth'

/**
 * Reads only. This credential must never be able to write a time log: writes run on the
 * signed-in person's own token so the log carries their name (AUTH-8).
 */
export const SERVICE_SCOPES = [
  'ZohoProjects.projects.READ',
  'ZohoProjects.tasks.READ',
  'ZohoProjects.timesheets.READ',
  'ZohoProjects.portals.READ',
  'ZohoCRM.modules.READ',
  'ZohoCRM.settings.READ',
] as const

export const SERVICE_CONNECT_MAX_AGE_SECONDS = OAUTH_STATE_MAX_AGE_SECONDS

export async function storeServiceRefreshToken(
  db: PrismaClient,
  tokens: ZohoTokens,
  options: { encryptionKey: string; connectedByUserId: string; now?: Date },
): Promise<void> {
  if (!tokens.refreshToken) {
    throw new Error('Zoho returned no refresh token for the service credential')
  }

  const now = options.now ?? new Date()
  const refreshTokenEncrypted = encrypt(tokens.refreshToken, options.encryptionKey)
  const accessTokenEncrypted = encrypt(tokens.accessToken, options.encryptionKey)

  await db.serviceToken.upsert({
    where: { id: 'service' },
    create: {
      id: 'service',
      refreshTokenEncrypted,
      accessTokenEncrypted,
      expiresAt: tokens.expiresAt,
      connectedByUserId: options.connectedByUserId,
      connectedAt: now,
    },
    update: {
      refreshTokenEncrypted,
      accessTokenEncrypted,
      expiresAt: tokens.expiresAt,
      connectedByUserId: options.connectedByUserId,
      connectedAt: now,
    },
  })
}

export type ServiceCredentialState = {
  connected: boolean
  connectedAt: Date | null
}

/** Whether the app holds a service credential it obtained itself. */
export async function serviceCredentialState(
  db: PrismaClient,
): Promise<ServiceCredentialState> {
  const row = await db.serviceToken.findUnique({
    where: { id: 'service' },
    select: { refreshTokenEncrypted: true, connectedAt: true },
  })
  return {
    connected: Boolean(row?.refreshTokenEncrypted),
    connectedAt: row?.connectedAt ?? null,
  }
}
