import type { PrismaClient } from '@/generated/prisma/client'
import { loadConfig, type Config } from '@/lib/config'
import { prisma } from '@/lib/db'
import { createServiceTokenSource, createUserTokenSource } from '@/lib/auth/token-sources'
import { ZohoClient } from './client'
import { logZohoEvent } from './log'

/**
 * The four clients this app actually uses, each bound to the right credential (§2, §5).
 *
 * Assembled here rather than at each call site so the pairing of base URL to credential is
 * made once. A read on the user credential would burn their rate limit for no reason; a
 * write on the service credential would put the wrong name on someone's timesheet.
 */

function oauthConfig(config: Config) {
  return {
    clientId: config.ZOHO_CLIENT_ID,
    clientSecret: config.ZOHO_CLIENT_SECRET,
    redirectUri: config.ZOHO_REDIRECT_URI,
    accountsDomain: config.ZOHO_ACCOUNTS_DOMAIN,
  }
}

function serviceTokens(config: Config, db: PrismaClient) {
  return createServiceTokenSource({
    db,
    encryptionKey: config.TOKEN_ENCRYPTION_KEY,
    oauth: oauthConfig(config),
    refreshToken: config.ZOHO_SERVICE_REFRESH_TOKEN,
  })
}

/** `.../restapi/portal/{id}/` — the trailing slash matters, see `ZohoClient`. */
export function projectsBaseUrl(config: Config): string {
  return `${config.ZOHO_PROJECTS_API_DOMAIN}/restapi/portal/${config.ZOHO_PORTAL_ID}/`
}

export function crmBaseUrl(config: Config): string {
  return `${config.ZOHO_API_DOMAIN}/crm/v8/`
}

/** Reads against Zoho Projects: projects, tasks, existing logs. */
export function serviceProjectsClient(db: PrismaClient = prisma): ZohoClient {
  const config = loadConfig()
  return new ZohoClient({
    baseUrl: projectsBaseUrl(config),
    tokens: serviceTokens(config, db),
    logger: logZohoEvent,
  })
}

/** Reads against Zoho CRM: Accounts, Deals, charge-code rates. */
export function serviceCrmClient(db: PrismaClient = prisma): ZohoClient {
  const config = loadConfig()
  return new ZohoClient({
    baseUrl: crmBaseUrl(config),
    tokens: serviceTokens(config, db),
    logger: logZohoEvent,
  })
}

/**
 * Writes — creating and deleting a time log — on the signed-in person's own credential, so
 * the log's owner is the person the hours belong to (AUTH-8).
 */
export function userProjectsClient(
  userId: string,
  db: PrismaClient = prisma,
): ZohoClient {
  const config = loadConfig()
  return new ZohoClient({
    baseUrl: projectsBaseUrl(config),
    tokens: createUserTokenSource({
      db,
      userId,
      encryptionKey: config.TOKEN_ENCRYPTION_KEY,
      oauth: oauthConfig(config),
    }),
    logger: logZohoEvent,
  })
}
