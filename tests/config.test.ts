import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, resetConfigForTests, type EnvRecord } from '@/lib/config'

const validEnv = {
  DATABASE_URL: 'postgresql://user:pass@host:5432/db',
  OPENROUTER_API_KEY: 'sk-or-test',
  OPENROUTER_SITE_URL: 'https://assistant.example.com',
  ZOHO_CLIENT_ID: '1000.ABC',
  ZOHO_CLIENT_SECRET: 'secret',
  ZOHO_REDIRECT_URI: 'https://assistant.example.com/api/auth/callback',
  ZOHO_PORTAL_ID: '911636649',
  ZOHO_SERVICE_REFRESH_TOKEN: '1000.refresh',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
} satisfies EnvRecord

beforeEach(() => resetConfigForTests())

describe('loadConfig', () => {
  it('accepts a complete environment and applies documented defaults', () => {
    const config = loadConfig({ ...validEnv })

    expect(config.OPENROUTER_MODEL).toBe('anthropic/claude-sonnet-5')
    expect(config.ZOHO_ACCOUNTS_DOMAIN).toBe('https://accounts.zoho.com')
    expect(config.ZOHO_API_DOMAIN).toBe('https://www.zohoapis.com')
    expect(config.DEFAULT_TIMEZONE).toBe('America/New_York')
    expect(config.SESSION_MAX_AGE_DAYS).toBe(30)
    expect(config.DEFAULT_BILL_STATUS).toBe('Billable')
    expect(config.OPENROUTER_FALLBACK_MODELS).toEqual([])
  })

  it('fails fast and names every missing variable at once', () => {
    const { DATABASE_URL: _db, ZOHO_CLIENT_SECRET: _secret, ...partial } = validEnv

    expect(() => loadConfig(partial)).toThrowError(/DATABASE_URL/)
    resetConfigForTests()
    expect(() => loadConfig(partial)).toThrowError(/ZOHO_CLIENT_SECRET/)
  })

  it('never echoes a value in the error, only the variable name', () => {
    const env = { ...validEnv, ZOHO_REDIRECT_URI: 'http://insecure.example.com/cb' }

    expect(() => loadConfig(env)).toThrowError(/ZOHO_REDIRECT_URI/)
    resetConfigForTests()
    expect(() => loadConfig(env)).not.toThrowError(/insecure\.example\.com/)
  })

  it('rejects a non-https redirect URI', () => {
    expect(() =>
      loadConfig({ ...validEnv, ZOHO_REDIRECT_URI: 'http://example.com/cb' }),
    ).toThrowError(/https/)
  })

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64'),
      }),
    ).toThrowError(/32 bytes/)
  })

  it('accepts a 64-character hex encryption key', () => {
    const config = loadConfig({ ...validEnv, TOKEN_ENCRYPTION_KEY: 'a'.repeat(64) })
    expect(config.TOKEN_ENCRYPTION_KEY).toBe('a'.repeat(64))
  })

  it('splits the fallback model list', () => {
    const config = loadConfig({
      ...validEnv,
      OPENROUTER_FALLBACK_MODELS:
        'anthropic/claude-sonnet-4.5, anthropic/claude-haiku-4.5',
    })
    expect(config.OPENROUTER_FALLBACK_MODELS).toEqual([
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-haiku-4.5',
    ])
  })

  it('ignores a leftover DAILY_HOUR_CAP rather than failing boot', () => {
    // The cap was abandoned as a policy; a stale value in the environment must
    // neither fail validation nor reappear in the parsed config.
    const config = loadConfig({ ...validEnv, DAILY_HOUR_CAP: '12' })
    expect(config).not.toHaveProperty('DAILY_HOUR_CAP')
  })

  it('caches the parsed config', () => {
    const first = loadConfig({ ...validEnv })
    const second = loadConfig({})
    expect(second).toBe(first)
  })
})
