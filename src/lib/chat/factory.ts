import { loadConfig } from '@/lib/config'
import {
  createOpenRouterExtractor,
  userAttribution,
  type Extractor,
} from '@/lib/extract/openrouter'

/**
 * The extractor the chat routes use, assembled in one place.
 *
 * Built per request rather than cached at module scope: `loadConfig` is the single place that
 * validates the environment, and a client constructed at import time would be built before
 * the environment is guaranteed to exist — the same mistake that broke `next build` when the
 * Prisma client was constructed eagerly.
 */
export function chatExtractor(): Extractor {
  const config = loadConfig()
  return createOpenRouterExtractor({
    apiKey: config.OPENROUTER_API_KEY,
    model: config.OPENROUTER_MODEL,
    fallbackModels: config.OPENROUTER_FALLBACK_MODELS,
    siteUrl: config.OPENROUTER_SITE_URL,
    appTitle: config.OPENROUTER_APP_TITLE,
  })
}

/**
 * The opaque handle the gateway sees instead of a person.
 *
 * Salted with the token encryption key, which is already secret and already required — one
 * fewer variable to configure, and no way to recover a user id from the hash without it.
 */
export function userKeyFor(userId: string): string {
  return userAttribution(userId, loadConfig().TOKEN_ENCRYPTION_KEY)
}
