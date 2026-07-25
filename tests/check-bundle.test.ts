import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Tests the checker, not the bundle (task 9.2).
 *
 * `npm run check:bundle` passing tells you nothing on its own — an empty scan and a broken
 * regex both report "clean". So these plant secrets in a fixture and require the checker to
 * find them, and plant realistic decoys and require it not to.
 */
const SCRIPT = resolve(__dirname, '../scripts/check-bundle.mjs')

function run(files: Record<string, string>, env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bundle-'))
  mkdirSync(join(root, '.next/static'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, '.next/static', name), content)
  }

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ...env, CHECK_BUNDLE_ROOT: root },
    })
    return { ok: true as const, output: stdout }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number }
    return {
      ok: false as const,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      status: failure.status,
    }
  }
}

describe('the bundle checker catches a leak', () => {
  it('finds an env secret inlined verbatim', () => {
    // The real failure mode: a server module imported into a client component, and the
    // bundler helpfully inlines what it reads from `process.env`.
    const result = run(
      { 'chunk.js': 'const t="shhh-this-is-the-real-secret-value";' },
      { SOME_API_SECRET: 'shhh-this-is-the-real-secret-value' },
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain('SOME_API_SECRET')
  })

  it('finds a hard-coded credential this environment has never seen', () => {
    const result = run({
      'chunk.js':
        'fetch(url,{headers:{authorization:"Bearer sk-or-v1-' +
        'a1b2c3d4'.repeat(6) +
        '"}})',
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('OpenRouter key')
  })

  it('finds a database URL with a password in it', () => {
    const result = run({
      'chunk.js': 'const u="postgresql://user:hunter2@db.internal:5432/stelic"',
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain('Postgres URL')
  })

  it('never prints the secret it found', () => {
    // A CI log is a place secrets go to live forever.
    const result = run(
      { 'chunk.js': 'const t="shhh-this-is-the-real-secret-value";' },
      { SOME_API_SECRET: 'shhh-this-is-the-real-secret-value' },
    )
    expect(result.output).not.toContain('shhh-this-is-the-real-secret-value')
  })
})

describe('the bundle checker does not cry wolf', () => {
  it('passes a chunk full of the long random strings a build normally contains', () => {
    // Chunk hashes, source-map ids and base64 assets are all long and all random. A checker
    // that flags them is a checker somebody disables.
    const result = run({
      'chunk.js':
        'self.__BUILD_MANIFEST={"/":["static/chunks/2c9f1e7a8b3d4f5061728394a5b6c7d8.js"]};' +
        'const img="data:image/png;base64,' +
        'iVBORw0KGgoAAAANSUhEUg'.repeat(20) +
        '";',
    })
    expect(result.ok).toBe(true)
  })

  it('ignores a public env var, whatever it is called', () => {
    const result = run(
      { 'chunk.js': 'const url="https://stelic-assistant-production.up.railway.app";' },
      { NEXT_PUBLIC_SITE_TOKEN: 'https://stelic-assistant-production.up.railway.app' },
    )
    expect(result.ok).toBe(true)
  })

  it('fails loudly when there is nothing to scan, rather than reporting clean', () => {
    // The worst outcome: a green check that never opened a file.
    const root = mkdtempSync(join(tmpdir(), 'bundle-empty-'))
    let failed = false
    let output = ''
    try {
      execFileSync(process.execPath, [SCRIPT], {
        encoding: 'utf8',
        env: { ...process.env, CHECK_BUNDLE_ROOT: root },
      })
    } catch (error) {
      failed = true
      output = String((error as { stderr?: string }).stderr ?? '')
    }
    expect(failed).toBe(true)
    expect(output).toContain('nothing scanned')
  })
})
