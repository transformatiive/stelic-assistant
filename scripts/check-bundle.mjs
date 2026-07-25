#!/usr/bin/env node
/**
 * Fails the build if a secret is reachable from the browser (task 9.2).
 *
 * Next only inlines `NEXT_PUBLIC_*` into client code, so in principle this cannot happen. In
 * practice it happens the moment somebody imports a server module into a `'use client'` file
 * and the bundler follows it — which is a one-line mistake with no visible symptom, because
 * the app keeps working perfectly while shipping a client secret to every visitor.
 *
 * So this reads what was actually emitted rather than trusting the rule.
 *
 * Two passes, because either alone has a blind spot:
 *
 * 1. **By value** — every secret-looking environment variable this process can see, searched
 *    for verbatim in the emitted client chunks. Catches the real leak precisely.
 * 2. **By shape** — patterns for credentials whose value is *not* in this environment (a CI
 *    box without the production env, a secret that was hard-coded rather than read from
 *    `process.env`). Catches what pass one cannot see.
 *
 * Exit code 1 on a finding, and it never prints the secret it found.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

/**
 * Overridable so the checker can be pointed at a fixture and *proved to catch something*.
 * A scanner that has only ever reported "clean" is a scanner nobody has tested.
 */
const root = process.env.CHECK_BUNDLE_ROOT
  ? resolve(process.env.CHECK_BUNDLE_ROOT)
  : resolve(import.meta.dirname, '..')

/** Everything the browser can fetch. Server chunks are not in scope — they are the server. */
const CLIENT_DIRS = ['.next/static', 'public']

/** Env names whose values must never appear in a client chunk. */
const SECRET_NAME = /(SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL|DATABASE_URL|DSN)/i
/** …except these, which are public by construction or by name. */
const ALLOWED_NAMES = /^(NEXT_PUBLIC_|npm_|PATH$|HOME$)/

/**
 * Credential shapes, for secrets this process cannot see.
 *
 * Anchored to real formats rather than "long random string", because a Next build is full of
 * long random strings — chunk hashes, source-map ids, base64 assets — and a checker that
 * cries wolf is a checker somebody disables.
 */
const SHAPES = [
  { name: 'Zoho client id', re: /\b1000\.[A-Z0-9]{20,}\b/ },
  { name: 'Zoho OAuth token', re: /\b1000\.[a-f0-9]{32}\.[a-f0-9]{32}\b/ },
  { name: 'OpenRouter key', re: /\bsk-or-v1-[a-f0-9]{48,}\b/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  {
    name: 'Postgres URL with password',
    re: /\bpostgres(?:ql)?:\/\/[^\s:@'"]+:[^\s@'"]+@/,
  },
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
]

async function* walk(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // a directory that does not exist is not a finding
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

function secretsFromEnv() {
  const out = []
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12) continue // too short to be distinctive
    if (ALLOWED_NAMES.test(name)) continue
    if (!SECRET_NAME.test(name)) continue
    out.push({ name, value })
  }
  return out
}

const secrets = secretsFromEnv()
const findings = []
let scanned = 0

for (const dir of CLIENT_DIRS) {
  for await (const path of walk(resolve(root, dir))) {
    // Text only. A PNG cannot contain a secret anyone will read out of it, and decoding
    // every image would make this slow enough to be skipped.
    if (!/\.(js|mjs|cjs|css|json|map|txt|html|webmanifest|svg)$/.test(path)) continue

    const content = await readFile(path, 'utf8').catch(() => null)
    if (content === null) continue
    scanned += 1

    const where = relative(root, path)
    for (const secret of secrets) {
      if (content.includes(secret.value)) {
        findings.push(`${where}: value of ${secret.name} is present verbatim`)
      }
    }
    for (const shape of SHAPES) {
      if (shape.re.test(content)) findings.push(`${where}: looks like a ${shape.name}`)
    }
  }
}

if (scanned === 0) {
  console.error('check-bundle: nothing scanned — run `next build` first')
  process.exit(1)
}

if (findings.length > 0) {
  console.error(`check-bundle: ${findings.length} finding(s) in the client bundle\n`)
  for (const finding of findings) console.error(`  - ${finding}`)
  console.error('\nA secret reachable from the browser is a secret that must be rotated.')
  process.exit(1)
}

console.log(
  `check-bundle: ${scanned} client files scanned, ` +
    `${secrets.length} env secrets checked by value, ${SHAPES.length} by shape — clean`,
)
