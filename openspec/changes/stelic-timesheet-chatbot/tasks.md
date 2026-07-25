# Tasks: Stelic Timesheet Chatbot

Work top to bottom. Each task should be completable and testable in one session. Mark
complete as you go. Stop and ask if a spec scenario is ambiguous.

---

## 0. Pre-flight (blocking — do before writing code)

- [~] 0.1 Pull the Stelic credential. **The vault returns metadata and token *hints* only**
      (`refresh_token_hint`, no client id or secret) — confirmed portal `911636649`, domain
      `https://www.zohoapis.com`, Books org `911636705`, scopes, and deploy capabilities.
      The usable credential is the n8n credential `Stelic Credentials` (`81cg7LlsTQCWMht1`,
      `oAuth2Api`), whose values n8n does not expose over its API. **Remaining:** extract
      client id / secret / refresh token from it into Railway variables, since the app reads
      credentials from its own environment (`design.md §7`). Do not register a new one
- [x] 0.2 Verify the service token can call `GET /portal/911636649/users/` — **verified
      2026-07-25: it cannot.** `403 {"code":6403,"message":"Invalid OAuth scope."}`, and
      `GET /projects/{id}/users/` fails identically, so there is no project-scoped workaround.
      `portals.ALL` does not cover it. **Blocking follow-up: re-consent the token with
      `ZohoProjects.users.ALL` added and update the vault entry** — task group 2 cannot map an
      email to a portal user without it
- [ ] 0.3 Add this app's redirect URI to the **existing** Stelic OAuth client (server-based
      app — the vault entry shows a redirect URI already in use). No new client registration
- [ ] 0.4 Confirm open questions 2 and 9 in `proposal.md` (portal membership coverage,
      production domain)
- [ ] 0.5 Provision the OpenRouter key (dedicated key for this app so spend is attributable),
      set the account privacy defaults, and register it in the vault under `TRNSF-600`

## 1. Foundations

- [x] 1.1 In `transformatiive/stelic-assistant` (the repo already exists and holds this spec
      under `openspec/`), scaffold Next.js + TypeScript + Tailwind + shadcn/ui alongside
      it; strict mode, ESLint, Prettier, Vitest, CI on push
      — **Next.js 16, not 15.** 16 is the current stable major with the same App Router
      architecture this design assumes; starting a greenfield app on a superseded major
      buys nothing. Stack as built: Next 16.2, React 19.2, Tailwind 4.3, Prisma 7.9,
      Vitest 4.1, TypeScript 5.9, Zod 4.4. shadcn/ui is **not** installed yet — it is
      pulled in per component in task group 8, which is where the first UI lands.
- [x] 1.2 Add Prisma with the schema from `design.md §3` — including `ServiceToken` (service
      access-token cache, task 1.5), `RateLimit` (task 7.4) and the gateway accounting columns
      on `Message` (task 4.6); first migration
      — 10 tables in `prisma/migrations/20260725000000_init`. Prisma 7 takes the connection
      through `prisma.config.ts` + a driver adapter rather than a schema `url`. The migration
      is **generated but not applied**: there is no database until task 1.3.
- [~] 1.3 Provision a **new** Railway project (`Stelic Assistant`) with its own app service
      and its own Postgres — not inside the existing `Stelic Financials` project, which is a
      different product (`design.md §2`).
      — Done: project `861f18e1-a732-4f78-a084-312ba41999f1`, Postgres service, app service
      bound to this repo, and a stable origin **`https://stelic-assistant-production.up.railway.app`**
      (open question 9 resolved — a generated Railway domain, swappable for a custom one only
      before users install the PWA). Non-secret env vars set, `DATABASE_URL` referencing the
      Postgres service.
      **Remaining:** the credentials from 0.1/0.3/0.5, then a first green deploy — the app
      fails fast at boot without them, by design (task 1.6). Switch the service's branch from
      the feature branch to `main` when this PR merges
- [x] 1.4 **DECISIVE SPIKE — done 2026-07-25**, run as n8n workflows on the `Stelic
      Credentials` credential against `Transformatiive — TEST Deal 30 - disregard`. Four
      15-minute `Non Billable` logs created, all four deleted, task verified back to zero.
      (a) **YES** — `owner=<zuid>` creates a log owned by another user (`201`, verified for
      two different people). A `zpuid` fails with a misleading `6401`. Decision resolved in
      `design.md §2`.
      (b) **NO** — `custom_fields` came back `[]` on creation and on re-read, so
      `stampRoleOnTimelog` does not fire for API writes → new task 6.12.
      (c) **YES** — `DELETE` returns `200` and the log is gone.
      Side findings: portal *and* project user endpoints both `403` (open question 3 answered
      — no); numeric `id` is precision-corrupted so only `id_string` is usable; API-created
      logs are born `Approved`; the portal-wide `/logs/` range call is `6891` → task 6.11
- [x] 1.5 Typed Zoho HTTP client with two credential modes (service / user): base URL from
      env, auth header injection, 401-refresh-once, 429 backoff with jitter, request-id
      logging. Cache the service access token in Postgres — rapid successive refreshes on
      this tenant trigger rate limiting
      — Transport done and unit-tested (`lib/zoho/{client,backoff,errors}.ts`): mode carried
      by the injected `TokenSource` so a write cannot run on the service credential by
      accident, one silent refresh on 401 then `ZohoAuthError`, full-jitter backoff honouring
      `Retry-After`, no retry on 5xx, one request id across a retry chain.
      Both concrete `TokenSource` implementations now exist in `lib/auth/token-sources.ts`
      (see task 2.8): the user one backed by `OAuthToken`, the service one by the shared
      `ServiceToken` cache row.
- [x] 1.6 Config module reading and validating all env vars at boot (fail fast on missing or
      malformed). Credentials come from the environment only — the runtime never calls the
      vault (`design.md §7`)
      — `lib/config.ts` (Zod), invoked from `instrumentation.ts` so the process dies at boot
      rather than 500-ing on the first request that needed the variable. Errors name the
      variable and never echo its value. `SKIP_ENV_VALIDATION=1` for build and CI, which
      must not require a production secret.

## 2. Authentication and session

- [x] 2.1 `/api/auth/login` — build the Zoho authorize URL with state and PKCE
      — builder and PKCE in `lib/auth/{zoho-oauth,pkce}.ts`, tested including an RFC 7636
      known-answer vector; route handler in `app/api/auth/login/route.ts`. Scopes deliberately
      exclude `users.*` (0.2 proved that endpoint unreachable) but do include
      `AaaServer.profile.READ`, without which there is no email — see 2.4.
      `state` and the PKCE verifier ride in a 10-minute AES-256-GCM cookie rather than a
      database row: nothing to clean up, and a planted cookie only signs the attacker in as
      themselves
- [x] 2.2 `/api/auth/callback` — validate state, exchange code, fetch profile
      — `lib/auth/callback-flow.ts` holds the decisions behind injected ports, so every branch
      the spec names is unit-testable without a database or a network; the route handler is
      wiring only. State is checked **before** the exchange, so a mismatch costs no code.
      A replayed code fails at Zoho and is logged with a request id
- [x] 2.3 AES-256-GCM encrypt/decrypt helpers for token storage; unit tests
      — `lib/auth/crypto.ts`. Per-value random IV, so the same token encrypts differently each
      time and nobody can tell two users share one. Tampering with either ciphertext or auth
      tag fails closed, and the error is deliberately opaque so a wrong key is
      indistinguishable from a forged payload
- [x] 2.4 On first login: identify the user from **their own token** via
      `GET /restapi/portals/` → `login_id` (their zuid) and `login_zpuid`, and confirm the
      Stelic portal is among those returned; reject the session if it is not (auth spec:
      *Valid Zoho account without portal membership*). This replaces the email → portal-user
      lookup, which is blocked by scope and no longer needed now that login is per-user.
      Store the zuid — the `owner` parameter needs it (task 5.9)
      — `readIdentity`/`fetchIdentity` in `lib/auth/zoho-oauth.ts`, matching on `id_string` so
      the precision-corrupted numeric portal id cannot cause a false negative, and the zuid
      stored as `zoho_projects_user_id` (task 5.9 satisfied for the login path).
      **`/restapi/portals/` carries no email**, and the `User` row needs one — it is the join
      key across CRM, Projects and Books. So the flow also calls `GET /oauth/user/info` on the
      accounts server (`readProfile`/`fetchProfile`) and requests `AaaServer.profile.READ`.
      An unreadable profile fails closed rather than inventing an address. AUTH-3 in the spec
      has been rewritten to match: the email → portal-user lookup it originally specified is
      impossible (0.2) and no longer needed
- [ ] 2.5 Resolve and store the CRM user id by email; tolerate absence with a flag
      — **not started.** `User.crm_user_id` is nullable and stays null through sign-in, which
      is what AUTH-4 requires of the *absence* case, but nothing resolves it yet. Needs the
      CRM read client from task group 3
- [x] 2.6 Session issue/validate/revoke; sliding expiry; `HttpOnly` `Secure` `SameSite=Lax`
      cookie — policy in `lib/auth/session.ts` (opaque 256-bit ids, cookie attributes, sliding
      expiry that only writes when the deadline has drifted more than an hour, salted IP
      hashing); persistence in `lib/auth/store.ts`. An unknown id, an expired one and a
      revoked one all return the same `invalid`, so probing reveals nothing
- [x] 2.7 Route middleware: 401 for unauthenticated API calls, redirect for pages
      — `src/proxy.ts`. **Next 16 renamed the `middleware` file convention to `proxy`**; the
      old name still builds but warns. It runs in the edge runtime, before Prisma is in reach,
      so it answers only the cheap question — *is a cookie present at all?* That covers both
      unauthenticated scenarios with no LLM or Zoho call made. A **forged** id passes it
      deliberately and dies in `requireApiSession` (`lib/auth/guard.ts`), which can read the
      database. The alternative — a second, edge-side notion of "valid" — is how the two
      drift apart
- [x] 2.8 Token refresh on demand; on refresh failure, revoke session and force re-login
      — `lib/auth/token-sources.ts` closes this and the outstanding half of 1.5. Tokens are
      treated as expiring a minute early so one cannot lapse mid-flight. When a refresh is
      rejected the user's sessions are revoked **before** the grant is cleared, so a
      concurrent request cannot pick the dead row back up. A stored token that will not
      decrypt (key rotation) is treated the same as a revoked one — the only recovery is a
      fresh sign-in. The service source caches its access token in the `ServiceToken` row so
      replicas share one refresh instead of rate-limiting the credential on every boot
- [x] 2.9 `/api/auth/logout` + Sign out control
      — POST, never GET, so a prefetch or an `<img src>` cannot sign anyone out. Revokes only
      this session (AUTH-5 *Multiple devices*) and drops the stored grant only when no other
      live session remains. Always 200, so the response reveals nothing about whether the id
      was real
- [x] 2.10 Login screen (single action, Stelic-appropriate styling, no field for a password)
      — `app/login/page.tsx`. A plain `<a>`, so it works before any JavaScript loads. The
      callback redirects here with an error *code*, not a sentence: the page owns the wording,
      and a message in a query string is a message an attacker can choose
- [~] 2.11 Tests for every scenario in `specs/auth/spec.md`
      — 210 tests green. Covered: state mismatch, replayed code, consent refused, non-member
      (with the email logged), unreadable identity, missing email, missing refresh token,
      return-after-a-week sliding, expired/revoked/forged/unknown session, per-device sign
      out, grant retained while another device is live, tokens-at-rest ciphertext, silent
      refresh, revoked consent, open-redirect attempts on `returnTo`.
      **Not yet covered:** *No password is ever handled by the app* and *Nothing leaks to the
      client* — both are assertions about the built bundle and belong with the UI in task
      group 8, where there is a rendered app to assert against

## 3. Project index

- [ ] 3.1 Using the **service** credential, fetch projects (paged) and, per project, the
      tasks each user can log to — this lets the index be warmed before a user first signs in
- [ ] 3.2 For each project, read `crm_deal_id`; batch-fetch deal name and account name from
      CRM
- [ ] 3.3 Fetch the user's last 60 days of logs to derive a recency score per project
- [ ] 3.4 Persist to `ProjectIndex`; build on login, refresh hourly and on demand
- [x] 3.5 Matcher: normalisation (case, punctuation, id prefixes), token + trigram scoring,
      recency boost, thresholds per `design.md §4.2`
      — `lib/index/{normalise,match}.ts`. Trigram Dice alone scored `clacyo` against `clayco`
      at ~0.33 and would have lost real typos, so matching also uses Jaro–Winkler per token
      with a 0.87 floor (below which a score is coincidence between unrelated words, not a
      typo). Recency boost is capped at 0.10, deliberately below the 0.15 resolve gap, so a
      recently-used project can never silently win a genuine ambiguity. Every candidate
      reports the field and text it matched on, so the bot can explain itself
- [x] 3.6 Unit tests with a realistic fixture: exact name, client-only, deal name, misspelling,
      two-candidate tie, no match — fixture uses live-portal name shapes (`STE-100013 - …`,
      `Google LLC — 1080 - Google: …`)
- [ ] 3.7 Live fallback search (CRM Accounts → Deals → projects by `crm_deal_id`; Projects by
      name) when the index misses

## 4. Extraction (LLM via OpenRouter)

- [ ] 4.1 OpenRouter client wrapper behind an `Extractor` interface (so the gateway can be
      swapped): base URL, `Authorization`, `HTTP-Referer`/`X-Title`, model + fallback list
      from env, provider policy `{data_collection: "deny", zdr: true, require_parameters:
      true}`, timeout, retry once, typed errors distinguishing 402 / 429 / model error.
      **Verify on first call** that the configured slug exists and that ZDR endpoints are
      available for it; fail closed and escalate if not
- [ ] 4.2 Tool schemas `submit_time_entries` and `reply_only` per `design.md §4.1`, OpenAI
      function format, `tool_choice: "required"`; parse `tool_calls[0].function.arguments`
      and validate with Zod before anything downstream sees it
- [ ] 4.3 System prompt builder: today's date in user timezone, display name, 8 recent
      projects as hints, hard rules (never invent hours/projects/descriptions, verbatim
      `project_query` and `date_expression`)
- [ ] 4.4 Conversation windowing — last N turns only, with token budget
- [ ] 4.5 Degraded mode: on gateway or tool-call failure, fall back to a guided slot-by-slot
      form; raise an operational alert on 402 (credits exhausted)
- [ ] 4.6 Usage accounting: request `usage.include`, persist generation id, model actually
      served, tokens and cost against the message row; simple monthly cost query
- [ ] 4.7 Fixture tests: single entry, two projects one sentence, one project three days,
      missing description, missing hours, pure question, gibberish, malformed tool call

## 5. Deterministic resolution

- [x] 5.1 Date resolver (timezone-aware): today, yesterday, weekday names, "last <weekday>",
      `N days/weeks ago`, numeric `MM/DD`, ISO; reject future; unit tests around DST boundaries
      — `lib/resolve/{civil-date,date}.ts`. All arithmetic is on civil calendar dates rather
      than UTC subtraction, so DST cannot shift a log by a day; tested across both 2026
      changeovers. Numeric dates read US-first, a documented correction to `design.md` §4.2
- [x] 5.2 Hours parser: decimal, `h:mm`, `7h30`; round to 0.25; bounds 0.25–24
      — `lib/resolve/hours.ts`, also accepts `7,5`, `90m`, `7 hours 30 mins`. Rounds half away
      from zero and pins the result to 2dp so float drift cannot reach a committed value
- [x] 5.3 Description validator: trim, minimum length, filler-word rejection list
      — `lib/resolve/description.ts`. Rejects filler *phrases* too ("misc stuff and things"),
      which a length check alone would pass, while accepting text that merely contains a
      filler word ("rebar inspection and misc punch list")
- [ ] 5.4 Task resolver: PCCR lookup by (deal, CRM user) → labour category → task match;
      handle none / one / many
- [ ] 5.5 Slot-state machine: which slot to ask next, ordered project → task → date → hours →
      description, entry by entry
- [ ] 5.6 Draft persistence, expiry, and re-resolution after each answer
- [ ] 5.7 Warning engine: duplicate similarity, backdating. **No daily cap** — abandoned as a
      policy (open question 4); do not sum a user's daily total to warn on it
- [ ] 5.9 Store each user's Zoho **zuid** alongside their portal user id, from `login_id` on
      `GET /restapi/portals/`. The `owner` parameter on a time-log write takes a zuid, not a
      zpuid (spike 1.4), so the commit pipeline needs it on the `User` row
- [ ] 5.10 Settle the timezone. The portal is configured `America/Los_Angeles` but
      `DEFAULT_TIMEZONE` is `America/New_York` (open question 11). Date resolution is already
      timezone-parameterised, so this is a configuration and per-user-preference decision, not
      a code change — but getting it wrong shifts logs by a day either side of midnight
- [ ] 5.8 Unit tests for the full resolver against the spec scenarios

## 6. Commit pipeline

- [~] 6.1 Idempotency key derivation + unique constraint enforcement
      — derivation done in `lib/commit/idempotency.ts`, normalising hours and description so
      `8` vs `8.00` and stray whitespace cannot produce two keys for one booking. The unique
      constraint is already in the Prisma schema; enforcement lands with the commit pipeline
- [ ] 6.2 `CommitLog` write-before-call, update-after-response
- [ ] 6.3 Create time log in Zoho with correct `MM-DD-YYYY` date and `hh:mm` hours
- [ ] 6.4 Per-entry result aggregation; partial-failure reporting; retry-failed-only path
- [ ] 6.5 `/api/drafts/{id}/confirm` — re-read the draft server-side, ignore any client-sent
      entry data
- [ ] 6.6 `/api/drafts/{id}/cancel`
- [ ] 6.7 Undo: `/api/entries/{id}/undo` with same-day and app-origin guards; refuse approved
      logs
- [ ] 6.8 Week read-back: `/api/entries/week` grouped by day with total
- [ ] 6.11 Establish a working week read-back contract. The week runs **Sunday–Saturday**:
      the portal's `startday_of_week` is `sunday`. The portal-wide
      `GET /logs?users_list=…&view_type=custom_date&custom_date=…` returns
      `6891 "Given URL is wrong"` (verified, both parameter shapes). Find the correct call or
      build the week view from per-project log reads, which are verified working. 6.8 depends
      on this
- [ ] 6.12 Write `billing_role` after creating a log. Spike 1.4(b) proved
      `stampRoleOnTimelog` does not fire for API-created logs, so a log this app creates is
      **not** indistinguishable from a UI one until the app stamps the field itself. Derive
      the value the same way the workflow does (TRNSF-914) and set it on the log's custom
      field. Without this the invoice pipeline sees an unroled log — check with the pipeline
      owner whether that breaks pricing or merely degrades reporting
- [ ] 6.10 Undo guard against already-billed logs: refuse undo when the log's date falls in a
      period the invoice pipeline has already billed, so deleting it cannot orphan a pointer
      in the billing app's `invoiced_logs` ledger (`design.md §2`). Determine the boundary
      from Zoho or configuration — this app must not read the billing database
- [ ] 6.9 Tests for double-confirm, partial failure, Zoho unavailable, expired draft

## 7. Chat API

- [ ] 7.1 `/api/chat` orchestration: persist message → extract → resolve → respond with
      `{ reply, ui }`
- [ ] 7.2 `/api/chat/action` for chip taps: apply typed slot value, no LLM round trip
- [ ] 7.3 Stale-action guard (pwa-shell spec: *Stale options*)
- [ ] 7.4 Per-user rate limiting; 30 chat requests/minute
- [ ] 7.5 Out-of-scope guard: refuse rate, budget, invoice, approval and admin requests
- [ ] 7.6 `/api/me`

## 8. PWA and chat UI

- [ ] 8.1 `manifest.ts`, icons (192, 512, maskable), theme colour, `display: standalone`
- [ ] 8.2 iOS meta tags, apple-touch-icon, status-bar style, splash handling
- [ ] 8.3 Service worker: app-shell caching only; never cache API responses
- [ ] 8.4 Chat layout: dynamic viewport height, sticky composer above the keyboard,
      safe-area insets, 16px minimum input font
- [ ] 8.5 `MessageList` with auto-scroll and screen-reader announcement of new messages
- [ ] 8.6 `Chips` component driven by the server `ui` payload
- [ ] 8.7 `ConfirmationCard` — labelled fields, per-line warnings, total hours, disabled state
      while committing
- [ ] 8.8 Result state after commit: per-entry success/failure with retry
- [ ] 8.9 Week view screen
- [ ] 8.10 Offline and error states
- [ ] 8.11 Desktop layout: readable column, Enter to send, Shift+Enter for newline
- [ ] 8.12 Accessibility pass: labels, focus order, contrast, reduced motion

## 9. Hardening

- [ ] 9.1 Structured logging with request ids; ensure no message content reaches third-party
      sinks
- [ ] 9.2 Verify no secret is reachable from the client bundle (build-time check)
- [ ] 9.3 Input length limits and prompt-injection guard on user text (the model must never
      be able to widen its own tool surface)
- [ ] 9.4 Health check endpoint + Railway restart policy
- [ ] 9.5 Seed/import script to warm the project index for all portal users
- [ ] 9.6 Operational alerting for configuration and quota faults that are not the user's
      fault: portal-user lookup failing on scope (auth spec: *Portal user lookup is
      unavailable*), OpenRouter `402`, no ZDR-eligible endpoint. One channel, one severity —
      the user always sees a plain sentence, never the cause

## 10. Verification

- [ ] 10.1 Every scenario in `specs/auth/spec.md` passes manually
- [ ] 10.2 Every scenario in `specs/timesheet-chat/spec.md` passes manually
- [ ] 10.3 Every scenario in `specs/pwa-shell/spec.md` passes manually
- [ ] 10.4 Playwright E2E: login → single entry → confirm → verify in Zoho → undo
- [ ] 10.5 Cross-check five app-created logs against the Zoho Projects UI: owner, task,
      tasklist, date, hours, bill status, `billing_role`
- [ ] 10.6 Confirm an app-created log flows correctly into the existing invoice pipeline in a
      test billing period
- [ ] 10.7 Install and use on a real iPhone and a real Android device
- [ ] 10.8 Pilot with 3 Stelic users for one week; capture every message the bot mishandled

## 11. Handover

- [ ] 11.1 One-page user guide (English, screenshots, install instructions per platform)
- [ ] 11.2 Runbook: env vars, token rotation, index rebuild, common errors
- [ ] 11.3 Jira: link the repo and this spec folder to the Stelic epic
