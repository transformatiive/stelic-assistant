import { z } from 'zod'

/**
 * Environment configuration, validated once at boot (task 1.6).
 *
 * Credentials come from the environment only. The running app never calls the credential
 * vault — the deploy pipeline resolves TRNSF-600 and injects these variables
 * (design.md §7). `VAULT_URL` / `VAULT_EPIC_KEY` are therefore deliberately absent here.
 */

const nonEmpty = z.string().trim().min(1)
const httpsUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith('https://'), { message: 'must be an https:// URL' })

// `.default()` must come before `.transform()`: applied after, it short-circuits and returns
// the raw default without running the transform, yielding a string where a string[] is typed.
const csv = z
  .string()
  .trim()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
  )

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: nonEmpty,

  // Model gateway
  OPENROUTER_API_KEY: nonEmpty,
  OPENROUTER_MODEL: nonEmpty.default('anthropic/claude-sonnet-5'),
  OPENROUTER_FALLBACK_MODELS: csv,
  OPENROUTER_SITE_URL: httpsUrl,
  OPENROUTER_APP_TITLE: nonEmpty.default('Stelic Assistant'),

  // Zoho OAuth — the existing Stelic client, extended with this app's redirect URI
  ZOHO_CLIENT_ID: nonEmpty,
  ZOHO_CLIENT_SECRET: nonEmpty,
  ZOHO_REDIRECT_URI: httpsUrl,
  ZOHO_ACCOUNTS_DOMAIN: httpsUrl.default('https://accounts.zoho.com'),
  ZOHO_API_DOMAIN: httpsUrl.default('https://www.zohoapis.com'),
  ZOHO_PROJECTS_API_DOMAIN: httpsUrl.default('https://projectsapi.zoho.com'),
  ZOHO_PORTAL_ID: nonEmpty,

  /**
   * Optional fallback for the service credential (reads only — writes use the user's own
   * token). No longer required to boot: an admin can connect the credential through the app,
   * which is the only way to guarantee the token was issued by *this* OAuth client. A token
   * from any other client fails with Zoho's `invalid_code`, which is what happened here.
   */
  ZOHO_SERVICE_REFRESH_TOKEN: nonEmpty.optional(),

  // AES-256-GCM key for token storage: 32 bytes, base64 or hex
  TOKEN_ENCRYPTION_KEY: nonEmpty.refine((v) => decodeKeyLength(v) === 32, {
    message: 'must decode to exactly 32 bytes (base64 or hex)',
  }),

  SESSION_COOKIE_NAME: nonEmpty.default('stelic_session'),
  SESSION_MAX_AGE_DAYS: z.coerce.number().int().positive().default(30),

  // Pending product decisions — proposal.md open questions 5 and 6.
  // There is deliberately no DAILY_HOUR_CAP: the cap was abandoned as a policy
  // (open question 4). The per-entry 0.25-24h bound lives in the hours parser.
  BACKDATE_WARN_DAYS: z.coerce.number().int().nonnegative().default(14),
  DEFAULT_BILL_STATUS: z.enum(['Billable', 'Non Billable']).default('Billable'),

  DEFAULT_TIMEZONE: nonEmpty.default('America/New_York'),
})

export type Config = z.infer<typeof configSchema>

/** A plain env bag. Not `NodeJS.ProcessEnv`, which requires NODE_ENV and so cannot be
 *  satisfied by the partial fixtures the tests build. */
export type EnvRecord = Record<string, string | undefined>

function decodeKeyLength(value: string): number {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return 32
  try {
    return Buffer.from(value, 'base64').length
  } catch {
    return -1
  }
}

let cached: Config | undefined

/**
 * Parse and cache the environment. Throws with every offending variable listed — a missing
 * credential should fail the process at boot, not the first request that needs it.
 *
 * Set `SKIP_ENV_VALIDATION=1` for `next build` and CI, where no credential is present and
 * none is needed: the build must not require production secrets.
 */
export function loadConfig(env: EnvRecord = process.env): Config {
  if (cached) return cached

  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    // Names only — never echo a value, valid or not.
    throw new Error(`Invalid environment configuration:\n${detail}`)
  }

  cached = parsed.data
  return cached
}

/** Test seam. Not for application code. */
export function resetConfigForTests(): void {
  cached = undefined
}

export function isEnvValidationSkipped(env: EnvRecord = process.env): boolean {
  return env.SKIP_ENV_VALIDATION === '1' || env.SKIP_ENV_VALIDATION === 'true'
}
