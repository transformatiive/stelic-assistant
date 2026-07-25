#!/usr/bin/env node
/**
 * Mint the service refresh token (task 0.1).
 *
 * `ZOHO_SERVICE_REFRESH_TOKEN` cannot be copied out of n8n. n8n runs the OAuth dance itself
 * and stores the result encrypted with its own `N8N_ENCRYPTION_KEY`; neither its UI nor its
 * API ever hands the refresh token back. The client id and secret in that credential *are*
 * readable — they were typed in by hand — and this script uses them to run the same dance
 * once, by hand, and print the refresh token that comes out.
 *
 * Two steps, because a human has to authenticate in the middle:
 *
 *   node scripts/zoho-refresh-token.mjs authorize
 *   node scripts/zoho-refresh-token.mjs exchange <code>
 *
 * Reads ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REDIRECT_URI and (optionally)
 * ZOHO_ACCOUNTS_DOMAIN from the environment. Nothing is written to disk and nothing is
 * logged anywhere — the token is printed once, to your terminal.
 */

const DEFAULT_ACCOUNTS_DOMAIN = 'https://accounts.zoho.com'

/**
 * Reads only. Writes run on the signed-in user's own token, never on this one — so this
 * credential deliberately does not ask for anything it cannot justify.
 */
const SERVICE_SCOPES = [
  'ZohoProjects.projects.READ',
  'ZohoProjects.tasks.READ',
  'ZohoProjects.timesheets.READ',
  'ZohoProjects.portals.READ',
  'ZohoCRM.modules.READ',
  'ZohoCRM.settings.READ',
]

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`Missing ${name}. Set it in your shell before running this:\n`)
    console.error(`  export ${name}='…'\n`)
    process.exit(1)
  }
  return value
}

function accountsDomain() {
  return process.env.ZOHO_ACCOUNTS_DOMAIN?.trim() || DEFAULT_ACCOUNTS_DOMAIN
}

function authorize() {
  const url = new URL('/oauth/v2/auth', accountsDomain())
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', required('ZOHO_CLIENT_ID'))
  url.searchParams.set('redirect_uri', required('ZOHO_REDIRECT_URI'))
  url.searchParams.set('scope', SERVICE_SCOPES.join(','))
  // Both are load-bearing. Without access_type=offline Zoho returns no refresh token at all;
  // without prompt=consent it silently reuses an existing grant and returns none either.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')

  console.log(
    '\n1. Open this in a browser, signed in as the account the reads should run as:\n',
  )
  console.log(url.toString())
  console.log(
    '\n2. Approve. Zoho redirects to your redirect URI with ?code=… in the address bar.',
  )
  console.log(
    '   The page itself may well fail to load — that does not matter. Copy the code.',
  )
  console.log('\n3. Within ~2 minutes (the code is short-lived), run:\n')
  console.log('   node scripts/zoho-refresh-token.mjs exchange <code>\n')
}

async function exchange(code) {
  if (!code) {
    console.error('Usage: node scripts/zoho-refresh-token.mjs exchange <code>')
    process.exit(1)
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: required('ZOHO_CLIENT_ID'),
    client_secret: required('ZOHO_CLIENT_SECRET'),
    redirect_uri: required('ZOHO_REDIRECT_URI'),
    code,
  })

  const response = await fetch(new URL('/oauth/v2/token', accountsDomain()), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  })

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    console.error(
      `Zoho returned something unreadable (HTTP ${response.status}):\n${text}`,
    )
    process.exit(1)
  }

  // Zoho answers 200 with an `error` field rather than an HTTP error code.
  if (payload.error) {
    console.error(`\nZoho refused: ${payload.error}\n`)
    if (payload.error === 'invalid_code') {
      console.error('That code was already used or has expired. Run `authorize` again.')
    }
    if (payload.error === 'redirect_uri_mismatch') {
      console.error(
        'ZOHO_REDIRECT_URI must match the one registered on the client, character for character.',
      )
    }
    process.exit(1)
  }

  if (!payload.refresh_token) {
    console.error('\nNo refresh token in the response.\n')
    console.error(
      'This happens when the grant already existed. Revoke the app under\n' +
        'accounts.zoho.com → Security → OAuth Apps, then run `authorize` again.\n',
    )
    process.exit(1)
  }

  console.log('\nZOHO_SERVICE_REFRESH_TOKEN=' + payload.refresh_token)
  console.log('\nScopes granted: ' + (payload.scope ?? '(not reported)'))
  console.log('API domain:     ' + (payload.api_domain ?? '(not reported)'))
  console.log(
    '\nPaste the value into the Railway service variables. It does not expire on its own —\n' +
      'only revoking the app, or exceeding Zoho’s per-user token limit, invalidates it.\n',
  )
}

const [command, argument] = process.argv.slice(2)

if (command === 'authorize') {
  authorize()
} else if (command === 'exchange') {
  await exchange(argument)
} else {
  console.error('Usage:\n  node scripts/zoho-refresh-token.mjs authorize')
  console.error('  node scripts/zoho-refresh-token.mjs exchange <code>')
  process.exit(1)
}
