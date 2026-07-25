import type { PrismaClient } from '@/generated/prisma/client'
import type { TokenSource } from '@/lib/zoho/client'
import { DecryptionError, decrypt, encrypt } from './crypto'
import { needsRefresh } from './session'
import { clearTokens, revokeAllSessions, saveTokens } from './store'
import {
  ZohoOAuthError,
  refreshAccessToken,
  type ZohoOAuthConfig,
  type ZohoTokens,
} from './zoho-oauth'

/**
 * The concrete `TokenSource` implementations the Zoho client takes (tasks 1.5, 2.8).
 *
 * Two credentials, two very different failure modes:
 *
 * - the **user** source backs a person. If its refresh fails, that person's consent is gone;
 *   the right response is to revoke their sessions and make them sign in again (AUTH-6).
 * - the **service** source backs the app. If its refresh fails, nobody can be asked to fix
 *   it from a browser — it is an operational fault, and it must not be retried in a loop.
 */

/** Raised when a user's grant is dead. The caller turns this into a re-login. */
export class UserReauthRequired extends Error {
  readonly userId: string
  constructor(userId: string, cause: string) {
    super(`Zoho refresh failed for user ${userId}: ${cause}`)
    this.name = 'UserReauthRequired'
    this.userId = userId
  }
}

export class ServiceCredentialUnavailable extends Error {
  constructor(cause: string) {
    super(`Zoho service credential unusable: ${cause}`)
    this.name = 'ServiceCredentialUnavailable'
  }
}

export type UserTokenSourceOptions = {
  db: PrismaClient
  userId: string
  encryptionKey: string
  oauth: ZohoOAuthConfig
  now?: () => Date
  fetchImpl?: typeof fetch
}

export function createUserTokenSource(options: UserTokenSourceOptions): TokenSource {
  const now = options.now ?? (() => new Date())

  async function readRow() {
    const row = await options.db.oAuthToken.findUnique({
      where: { userId: options.userId },
    })
    if (!row || !row.refreshTokenEncrypted) {
      throw new UserReauthRequired(options.userId, 'no stored grant')
    }
    return row
  }

  async function refresh(refreshTokenEncrypted: string): Promise<string> {
    let refreshToken: string
    try {
      refreshToken = decrypt(refreshTokenEncrypted, options.encryptionKey)
    } catch (error) {
      // A row we cannot decrypt is a row we cannot use. Rotating the key does this, and the
      // only recovery is a fresh sign-in.
      if (error instanceof DecryptionError) {
        await failGrant('undecryptable stored token')
      }
      throw error
    }

    let tokens: ZohoTokens
    try {
      tokens = await refreshAccessToken(options.oauth, refreshToken, {
        fetchImpl: options.fetchImpl,
        now: now(),
      })
    } catch (error) {
      const code = error instanceof ZohoOAuthError ? error.code : 'unknown'
      await failGrant(code)
      throw new UserReauthRequired(options.userId, code)
    }

    await saveTokens(options.db, options.userId, tokens, options.encryptionKey)
    return tokens.accessToken
  }

  async function failGrant(cause: string): Promise<never> {
    // Order matters: revoke first, so a concurrent request cannot pick the row back up.
    await revokeAllSessions(options.db, options.userId, now())
    await clearTokens(options.db, options.userId)
    throw new UserReauthRequired(options.userId, cause)
  }

  return {
    mode: 'user',

    async getAccessToken() {
      const row = await readRow()
      if (row.accessTokenEncrypted && !needsRefresh(row.accessTokenExpiresAt, now())) {
        try {
          return decrypt(row.accessTokenEncrypted, options.encryptionKey)
        } catch (error) {
          // A cached access token we cannot read is not fatal — refresh gets a new one.
          if (!(error instanceof DecryptionError)) throw error
        }
      }
      return refresh(row.refreshTokenEncrypted)
    },

    async refreshAccessToken() {
      const row = await readRow()
      return refresh(row.refreshTokenEncrypted)
    },
  }
}

export type ServiceTokenSourceOptions = {
  db: PrismaClient
  encryptionKey: string
  oauth: ZohoOAuthConfig
  refreshToken: string
  now?: () => Date
  fetchImpl?: typeof fetch
}

const SERVICE_TOKEN_ID = 'service'

/**
 * The shared read credential, cached in Postgres.
 *
 * The cache is not an optimisation. This tenant rate-limits rapid successive refreshes, and
 * without a shared cache every replica would refresh independently on boot and lock the
 * credential out for everyone (task 1.5).
 */
export function createServiceTokenSource(
  options: ServiceTokenSourceOptions,
): TokenSource {
  const now = options.now ?? (() => new Date())

  async function refresh(): Promise<string> {
    let tokens: ZohoTokens
    try {
      tokens = await refreshAccessToken(options.oauth, options.refreshToken, {
        fetchImpl: options.fetchImpl,
        now: now(),
      })
    } catch (error) {
      throw new ServiceCredentialUnavailable(
        error instanceof ZohoOAuthError ? error.code : 'unknown',
      )
    }

    const encrypted = encrypt(tokens.accessToken, options.encryptionKey)
    await options.db.serviceToken.upsert({
      where: { id: SERVICE_TOKEN_ID },
      create: {
        id: SERVICE_TOKEN_ID,
        accessTokenEncrypted: encrypted,
        expiresAt: tokens.expiresAt,
      },
      update: { accessTokenEncrypted: encrypted, expiresAt: tokens.expiresAt },
    })

    return tokens.accessToken
  }

  return {
    mode: 'service',

    async getAccessToken() {
      const row = await options.db.serviceToken.findUnique({
        where: { id: SERVICE_TOKEN_ID },
      })
      if (row && !needsRefresh(row.expiresAt, now())) {
        try {
          return decrypt(row.accessTokenEncrypted, options.encryptionKey)
        } catch (error) {
          if (!(error instanceof DecryptionError)) throw error
        }
      }
      return refresh()
    },

    refreshAccessToken: refresh,
  }
}
