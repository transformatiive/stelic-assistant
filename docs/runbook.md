# Runbook — Stelic Assistant

Operating the deployed app. For what it does and how to use it, see
[the user guide](./user-guide.md). For why it is built this way, see
`openspec/changes/stelic-timesheet-chatbot/design.md`.

| | |
|---|---|
| **URL** | https://stelic-assistant-production.up.railway.app |
| **Railway project** | `Stelic Assistant` — app service + Postgres |
| **Zoho portal** | `911636649` (Stelic) |
| **Repo** | `transformatiive/stelic-assistant`, deploys from `main` |
| **Ticket** | [TRNSF-1321](https://transformatiive.atlassian.net/browse/TRNSF-1321) · Epic [TRNSF-589](https://transformatiive.atlassian.net/browse/TRNSF-589) |

---

## 1. Environment variables

Every one is set on the Railway service. **The app reads credentials only from its
environment** — it does not call the vault at boot, on the hot path, or on token refresh.

### Required

| Name | Notes |
|---|---|
| `DATABASE_URL` | References the Postgres service. Railway resolves it by service **id**, so renaming the database service is safe. |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | The `Stelic Assistant` client in the Zoho API console. **Not** the n8n credential — see §5. |
| `ZOHO_REDIRECT_URI` | Must match the API console entry character for character, or Zoho answers `redirect_uri_mismatch`. |
| `ZOHO_PORTAL_ID` | `911636649` |
| `ZOHO_ACCOUNTS_DOMAIN`, `ZOHO_API_DOMAIN`, `ZOHO_PROJECTS_API_DOMAIN` | US DC. Tokens are **not** portable across data centres. |
| `TOKEN_ENCRYPTION_KEY` | 32 bytes, AES-256-GCM. Also salts the opaque user handle sent to OpenRouter. **Rotating it invalidates every stored Zoho token** — see §5. |
| `OPENROUTER_API_KEY` | |
| `CRON_SECRET` | Bearer secret for the scheduled rebuild. Without it the cron route refuses to run at all, rather than running unauthenticated. |

### Optional, with defaults

| Name | Default | Notes |
|---|---|---|
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-5` | Runs the conversation. It calls tools to search projects and list charge codes, and proposes entries; it cannot write to Zoho. |
| `OPENROUTER_FALLBACK_MODELS` | — | Comma-separated. |
| `SESSION_MAX_AGE_DAYS` | `30` | Sliding. |
| `BACKDATE_WARN_DAYS` | `14` | A warning, never a block. |
| `DEFAULT_BILL_STATUS` | `Billable` | Matches the portal's own default. |
| `DEFAULT_TIMEZONE` | `America/New_York` | Only what a brand-new user row starts with; the browser reports the real one. |
| `BILLING_LOCKED_THROUGH` | unset | ISO date. Undo refuses on or before it, so deleting a log cannot orphan a pointer in the billing ledger. **Currently unset** — see §6. |
| `BILLING_ROLE_FIELD` | unset | Zoho *column* name (e.g. `UDF_CHAR1`) of the read-only Billing Role field on the Time Logs layout. Unset means no role is stamped, which affects nothing that bills — see §6. |

**`DAILY_HOUR_CAP` is set on Railway and is inert.** The cap was abandoned as policy
(open question 4); nothing reads the variable. Safe to delete.

### Checking a change did not leak

```bash
npm run build && npm run check:bundle
```

Scans the emitted client bundle for every secret-shaped env var by value, and for known
credential shapes. Exits non-zero on a finding and never prints what it found.

---

## 2. The project index

The bot matches what somebody types against a **shared** index of all 145 portal projects —
name, client, CRM deal, and the charge codes it can log to. Shared, not per user: 145
projects is 145 Zoho calls, and a per-user index would take three quarters of an hour for
fifteen people.

**It refreshes four times a day on a schedule**, with no user involved, because sessions last
thirty days and a returning user may never trigger a page load that happens to be the first
of the hour.

### Rebuild it by hand

```bash
BASE_URL=https://stelic-assistant-production.up.railway.app \
CRON_SECRET=… node scripts/warm-index.mjs
```

Takes several minutes on purpose. **The pacing is load-bearing** — see §4.

### Is it healthy?

`GET /api/me` (signed in) reports `index.projects` and `index.stale`. A good run looks like
145 projects, 145 with a client name, ~100 CRM deals resolved, and **zero task-read
failures**. Task-read failures mean projects with no charge code, which the bot can match but
cannot log to.

---

## 3. Zoho credentials

Two kinds, deliberately:

- **The service credential** does the reads — the project index, CRM lookups. One credential,
  stored encrypted in the `ServiceToken` table.
- **Each person's own token** does the writes. A time log's owner is whose utilisation and
  invoice line it becomes, so it cannot be a service account. Writes now include creating a
  task the user asked to add from chat (`ZohoProjects.tasks.CREATE`) — a scope added after
  launch, so a session from before it exists fails that one action with a sign-in-again
  message; signing out and back in re-consents and picks it up. Time logs are unaffected.

### Reconnecting the service credential

Sign in as a portal admin and visit **`/api/admin/zoho/connect`**. It runs the OAuth
handshake and stores the refresh token.

**Do not paste a refresh token from anywhere else.** A refresh token is bound to the OAuth
client that issued it: one from n8n, from the old Stelic client, or from a self client will
answer `invalid_code` on every refresh, however carefully it is copied. This cost half a day
once already.

Symptom that it needs reconnecting: `reason: "service_credential"` in the logs, and the app
telling users their projects could not be loaded.

### Rotating `TOKEN_ENCRYPTION_KEY`

Every stored token — the service one and every user's — is encrypted with it. Change it and
they all become unreadable. The recovery is not a disaster but it is manual: change the
variable, reconnect the service credential at `/api/admin/zoho/connect`, and everyone signs
in again on their next visit. Do it deliberately, not by accident.

---

## 4. Zoho rate limits — the thing that bites

**100 requests per API per 120 seconds**, and Zoho reports a breach as a **`400`**, not a
`429`:

```json
{"error":{"status_code":400,"title":"URL_ROLLING_THROTTLES_LIMIT_EXCEEDED",
 "details":{"message":"Cannot execute more than 100 requests per API in 2 minutes.
 Try again after 17 minutes."}}}
```

Three things follow, and each one was learned the hard way:

1. **A lockout lasts about a quarter of an hour**, and every further call sustains it. The
   client recognises the shape and refuses to retry in-request.
2. **The index rebuild paces itself** at roughly one call every 1.4 seconds. That is why it
   takes minutes. Making it faster makes it fail.
3. **A throttled rebuild is not a failed one.** Every project is still indexed and matchable;
   only the charge codes it could not read are missing, and the next run fills them in. The
   code distinguishes "not read this run" from "none exist" precisely so a partial rebuild
   cannot discard yesterday's codes.

If the index has been rebuilding badly, wait twenty minutes before trying again.

---

## 5. Common errors

| What you see | What it is | What to do |
|---|---|---|
| `reason: "service_credential"` | The read credential is missing or expired. | Reconnect at `/api/admin/zoho/connect` (§3). |
| `reason: "missing_scope"`, or `403 Invalid OAuth scope` | The credential was consented without a read this needs. | Reconnect, granting the missing scope. Note `GET projects/users/` **always** 403s for this credential and is not used. |
| `level: "alert", reason: "credits_exhausted"` | OpenRouter balance spent. | Top up. Users are meanwhile dropped to the guided slot-by-slot form and can still log time. |
| `level: "alert", reason: "no_compliant_endpoint"` | No zero-retention endpoint for the configured model. | Change `OPENROUTER_MODEL`. **Do not** relax the data policy to route around it. |
| `URL_ROLLING_THROTTLES_LIMIT_EXCEEDED` | Zoho lockout. | Wait ~20 minutes (§4). |
| `commit.log_id_unreadable` | Zoho accepted a write but we could not parse which log it made. | The hours **are** logged. Undo will refuse that one. The parser needs a shape it has not seen — worth reporting. |
| `route.unhandled` | A bug. | The line carries a `requestId`; the user saw the same id. |
| `stale_link` on sign-in | An authorization code was consumed twice, usually by re-opening an old link. | Sign in again from the app. |

### Reading the logs

Everything is one-line JSON with a `level`, an `event` and a `requestId`.

- **`level: "alert"`** is the only severity that means *somebody has to do something*, and it
  is only ever a fault of ours — never a user's mistake. One filter, one alerting rule.
- **No message content and no secret can appear in a log line.** The logger drops those field
  names rather than masking them. If you find yourself wanting to log a description to debug
  something, add a `requestId` to the report instead.

---

## 6. Known gaps

**`BILLING_LOCKED_THROUGH` is unset**, so undo refuses nothing on billing grounds. This is
tolerable only because undo is same-day-only anyway. Set it to the last date the invoice
pipeline has billed if that assumption ever weakens.

**`billing_role` is not stamped on logs this app creates**, and this is cosmetic. TRNSF-914:
*"The stamped role is for display/review only; billing still resolves independently by
(user, project) at invoice time."* What matters is the log's **owner**, which is always set
explicitly. Two things would turn the stamp on, neither needed for correct billing: someone
populating `Resource` on the `Project_Charge_Code_Rates` rows, and `BILLING_ROLE_FIELD`.

**The live CRM still has `Charge_Code_Rates`.** TRNSF-864 (rename to `Resource_Rates`) is
marked Done but did not take effect on this portal. Not this app's problem, but anything
written against the new name will not find it.

**The OpenRouter key has no spend limit.** Worth setting one in the console: a runaway loop
should cost a small invoice rather than a large one. The per-user rate limit (30/minute)
bounds it, but only per user.

---

## 7. Deploying

Push to `main`. Railway builds, runs `npx prisma migrate deploy` as a pre-deploy step, and
health-checks `/api/health` before taking traffic. Restart policy is `ON_FAILURE`, ten
retries.

`/api/health` checks the database and **nothing else** — deliberately. A health check that
called Zoho would fail the instance during somebody else's outage and have Railway restart a
container that was working perfectly.

### Before merging anything

```bash
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build && npm run check:bundle
```

### End-to-end, against a real deployment

```bash
E2E_BASE_URL=https://stelic-assistant-production.up.railway.app \
E2E_SESSION=<your stelic_session cookie> \
npm run e2e
```

**It writes to the real portal and undoes itself.** That is the point — every mocked
assertion would have passed on the day Zoho changed a field name, which has already happened
twice here. Without the variables the suite skips rather than fails.
