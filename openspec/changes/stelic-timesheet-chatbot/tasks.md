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
- [ ] 0.2 Verify the service token can call `GET /portal/911636649/users/`. The vault scope
      string has no `ZohoProjects.users.*`; if `portals.ALL` does not cover it, re-consent the
      token with the users scope added and update the vault entry
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
- [ ] 1.4 **DECISIVE SPIKE — run this before task group 2.** Against the real portal with the
      vault service token and a test task:
      (a) can a log be created owned by a *different* user? Test **both** the v1
      `restapi/.../tasks/{taskId}/logs/` endpoint and **v3
      `POST /api/v3/portal/{id}/addbulktimelogs`** with `log_object` — the v3 bulk endpoint is
      already in production use by the `Stelic Timelog Bulk Loader` n8n workflow and is the
      likelier place an owner field exists (`design.md §5`). → decides whether per-user OAuth
      is mandatory (`design.md §2`);
      (b) does an API-created log trigger `stampRoleOnTimelog` and populate `billing_role`?
      (c) does `DELETE` remove it cleanly?
      Record the answers in `design.md §5`, resolve the provisional decision, and raise a new
      task if `billing_role` is not stamped
- [~] 1.5 Typed Zoho HTTP client with two credential modes (service / user): base URL from
      env, auth header injection, 401-refresh-once, 429 backoff with jitter, request-id
      logging. Cache the service access token in Postgres — rapid successive refreshes on
      this tenant trigger rate limiting
      — Transport done and unit-tested (`lib/zoho/{client,backoff,errors}.ts`): mode carried
      by the injected `TokenSource` so a write cannot run on the service credential by
      accident, one silent refresh on 401 then `ZohoAuthError`, full-jitter backoff honouring
      `Retry-After`, no retry on 5xx, one request id across a retry chain.
      **Outstanding:** the concrete `TokenSource` implementations. The service one needs the
      `ServiceToken` cache wired to a live database (1.3); the user one needs the AES-256-GCM
      helpers from task 2.3.
- [x] 1.6 Config module reading and validating all env vars at boot (fail fast on missing or
      malformed). Credentials come from the environment only — the runtime never calls the
      vault (`design.md §7`)
      — `lib/config.ts` (Zod), invoked from `instrumentation.ts` so the process dies at boot
      rather than 500-ing on the first request that needed the variable. Errors name the
      variable and never echo its value. `SKIP_ENV_VALIDATION=1` for build and CI, which
      must not require a production secret.

## 2. Authentication and session

- [ ] 2.1 `/api/auth/login` — build the Zoho authorize URL with state and PKCE
- [ ] 2.2 `/api/auth/callback` — validate state, exchange code, fetch profile
- [ ] 2.3 AES-256-GCM encrypt/decrypt helpers for token storage; unit tests
- [ ] 2.4 On first login: resolve the Zoho Projects portal user by email using the service
      credential; reject the session if absent (auth spec: *Valid Zoho account without portal membership*)
- [ ] 2.5 Resolve and store the CRM user id by email; tolerate absence with a flag
- [ ] 2.6 Session issue/validate/revoke; sliding expiry; `HttpOnly` `Secure` `SameSite=Lax`
      cookie
- [ ] 2.7 Route middleware: 401 for unauthenticated API calls, redirect for pages
- [ ] 2.8 Token refresh on demand; on refresh failure, revoke session and force re-login
- [ ] 2.9 `/api/auth/logout` + Sign out control
- [ ] 2.10 Login screen (single action, Stelic-appropriate styling, no field for a password)
- [ ] 2.11 Tests for every scenario in `specs/auth/spec.md`

## 3. Project index

- [ ] 3.1 Using the **service** credential, fetch projects (paged) and, per project, the
      tasks each user can log to — this lets the index be warmed before a user first signs in
- [ ] 3.2 For each project, read `crm_deal_id`; batch-fetch deal name and account name from
      CRM
- [ ] 3.3 Fetch the user's last 60 days of logs to derive a recency score per project
- [ ] 3.4 Persist to `ProjectIndex`; build on login, refresh hourly and on demand
- [ ] 3.5 Matcher: normalisation (case, punctuation, id prefixes), token + trigram scoring,
      recency boost, thresholds per `design.md §4.2`
- [ ] 3.6 Unit tests with a realistic fixture: exact name, client-only, deal name, misspelling,
      two-candidate tie, no match
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

- [ ] 5.1 Date resolver (timezone-aware): today, yesterday, weekday names, "last <weekday>",
      `dd/mm`, `mm-dd`, ISO; reject future; unit tests around DST boundaries
- [ ] 5.2 Hours parser: decimal, `h:mm`, `7h30`; round to 0.25; bounds 0.25–24
- [ ] 5.3 Description validator: trim, minimum length, filler-word rejection list
- [ ] 5.4 Task resolver: PCCR lookup by (deal, CRM user) → labour category → task match;
      handle none / one / many
- [ ] 5.5 Slot-state machine: which slot to ask next, ordered project → task → date → hours →
      description, entry by entry
- [ ] 5.6 Draft persistence, expiry, and re-resolution after each answer
- [ ] 5.7 Warning engine: daily cap (existing logs + draft), duplicate similarity, backdating
- [ ] 5.8 Unit tests for the full resolver against the spec scenarios

## 6. Commit pipeline

- [ ] 6.1 Idempotency key derivation + unique constraint enforcement
- [ ] 6.2 `CommitLog` write-before-call, update-after-response
- [ ] 6.3 Create time log in Zoho with correct `MM-DD-YYYY` date and `hh:mm` hours
- [ ] 6.4 Per-entry result aggregation; partial-failure reporting; retry-failed-only path
- [ ] 6.5 `/api/drafts/{id}/confirm` — re-read the draft server-side, ignore any client-sent
      entry data
- [ ] 6.6 `/api/drafts/{id}/cancel`
- [ ] 6.7 Undo: `/api/entries/{id}/undo` with same-day and app-origin guards; refuse approved
      logs
- [ ] 6.8 Week read-back: `/api/entries/week` grouped by day with total
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
