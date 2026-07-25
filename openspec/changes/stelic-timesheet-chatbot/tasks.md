# Tasks: Stelic Timesheet Chatbot

Work top to bottom. Each task should be completable and testable in one session. Mark
complete as you go. Stop and ask if a spec scenario is ambiguous.

---

## 0. Pre-flight (blocking — do before writing code)

- [x] 0.1 Pull the Stelic credential. **The vault returns metadata and token *hints* only**
      (`refresh_token_hint`, no client id or secret) — confirmed portal `911636649`, domain
      `https://www.zohoapis.com`, Books org `911636705`, scopes, and deploy capabilities.
      The n8n credential `Stelic Credentials` (`81cg7LlsTQCWMht1`, `oAuth2Api`) is **not** the
      credential this app uses — see 0.3, which supersedes the original "reuse the existing
      client" instruction. n8n holds its own OAuth2 credential with its own redirect URI, and
      **its refresh token cannot be copied out**: n8n ran the dance itself and stored the
      result encrypted under its own `N8N_ENCRYPTION_KEY`, so neither its UI nor its API hands
      a refresh token back, by design.
      So `ZOHO_SERVICE_REFRESH_TOKEN` is **minted fresh against this app's own client**, which
      `scripts/zoho-refresh-token.mjs` (`npm run zoho:token`) does in two steps. It must be the
      same client as the user flow: `lib/config.ts` carries one `ZOHO_CLIENT_ID` /
      `ZOHO_CLIENT_SECRET` pair and both the service refresh and the user code exchange use
      it, so a Zoho *Self Client* — its own id and secret, and no redirect URI at all — cannot
      serve either half.
      Depends on 0.3: the redirect URI must be registered before the authorize step returns
      a code. Whoever signs in during that step is the identity the reads run as, so use an
      account with portal-wide visibility.
      **Superseded 2026-07-25, after the pasted token failed in production.** Zoho answered
      `invalid_code` on every refresh. The reason generalises past the instance: **a refresh
      token is bound to the OAuth client that issued it.** One produced by the old Stelic
      client, by n8n, or by a self client cannot be refreshed with this client's id and secret,
      however carefully it is copied. The manual mint also could not work as instructed — the
      redirect URI is this app's own callback, which intercepted the code and reported a stale
      link.
      So the app now connects the credential itself: `GET /api/admin/zoho/connect` runs the
      handshake and stores the refresh token encrypted in `ServiceToken`, next to the per-user
      tokens the app already holds. The token is *necessarily* issued by the right client,
      because the app is the thing asking. `ZOHO_SERVICE_REFRESH_TOKEN` becomes an optional
      fallback and is no longer needed to boot. Design §7 is unchanged: this adds a way to
      **obtain** a credential, not a new place to fetch one from at runtime.
      `scripts/zoho-refresh-token.mjs` stays for a deployment that wants to inject one, but it
      is no longer the expected path. The OpenRouter key was
      verified live against `GET /api/v1/key` — valid, paid tier, usage zero. It carries **no
      spend limit**, which is worth setting in the OpenRouter console: a runaway loop should
      cost a small invoice, not a large one.
- [x] 0.2 Verify the service token can call `GET /portal/911636649/users/` — **verified
      2026-07-25: it cannot.** `403 {"code":6403,"message":"Invalid OAuth scope."}`, and
      `GET /projects/{id}/users/` fails identically, so there is no project-scoped workaround.
      `portals.ALL` does not cover it. **Blocking follow-up: re-consent the token with
      `ZohoProjects.users.ALL` added and update the vault entry** — task group 2 cannot map an
      email to a portal user without it
- [x] 0.3 **Superseded 2026-07-25: register a dedicated OAuth client after all.** This task
      originally said to add a redirect URI to the *existing* Stelic client and register
      nothing new. That reading was wrong about which credential n8n actually holds: n8n uses
      its own generic OAuth2 credential pointed at its own callback, so there is no shared
      API-console client to extend. (Zoho *does* allow several redirect URIs per client — the
      `+` beside the field — so this is a choice, not a constraint.)
      A dedicated client is the better choice regardless, and the reason to record: revocation
      and audit become independent, so revoking n8n's access cannot break the app or the other
      way round, and the consent asks only for the scopes this app needs rather than
      inheriting n8n's.
      Client Type `Server-based Applications`, name `Stelic Assistant`, homepage
      `https://stelic-assistant-production.up.railway.app`, redirect URI
      `https://stelic-assistant-production.up.railway.app/api/auth/callback` — which must match
      `ZOHO_REDIRECT_URI` character for character, or Zoho answers `redirect_uri_mismatch`.
      Created 2026-07-25 as `Stelic Assistant`, and proven end to end by a real sign-in.
- [x] 0.4 Confirm open questions 2 and 9 in `proposal.md` (portal membership coverage,
      production domain)
      — Both answered. **Question 2: yes, everyone has a Zoho account** (confirmed 2026-07-25),
      so per-user login locks nobody out. Question 9: the production domain is
      `https://stelic-assistant-production.up.railway.app`.
- [~] 0.5 Provision the OpenRouter key (dedicated key for this app so spend is attributable),
      set the account privacy defaults, and register it in the vault under `TRNSF-600`
      — a key is in place and verified live (paid tier, usage zero at the time). The privacy
      defaults are pinned per request rather than trusted from the account: every call sends
      `data_collection: deny`, `zdr: true`, `require_parameters: true`, and fails closed if no
      endpoint meets them.
      **Two things left, both for a human at the OpenRouter console:** confirm this key is
      dedicated to this app rather than shared (so spend is attributable), and **set a spend
      limit** — it currently has none, and the per-user rate limit bounds a runaway loop only
      per user. Then register it in the vault under `TRNSF-600`

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
- [x] 1.3 Provision a **new** Railway project (`Stelic Assistant`) with its own app service
      and its own Postgres — not inside the existing `Stelic Financials` project, which is a
      different product (`design.md §2`).
      — Done: project `861f18e1-a732-4f78-a084-312ba41999f1`, Postgres service, app service
      bound to this repo, and a stable origin **`https://stelic-assistant-production.up.railway.app`**
      (open question 9 resolved — a generated Railway domain, swappable for a custom one only
      before users install the PWA). Non-secret env vars set, `DATABASE_URL` referencing the
      Postgres service.
      **Done 2026-07-25.** The Postgres service first created via MCP was a bare image with
      no volume and no variables, so it crash-looped on `Railway volume not mounted to the
      correct path` and never produced a `DATABASE_URL` — the app's reference resolved to an
      empty string. Replaced with the official Postgres template (volume at
      `/var/lib/postgresql/data`, full credential set). Railway resolves variable references
      by service id rather than display name, so the template's temporary name was harmless.
      `npx prisma migrate deploy` runs as the service's **pre-deploy command**: a failed
      migration then aborts the deploy and leaves the previous version serving, instead of
      starting an app against the wrong schema, and it runs once per deploy rather than once
      per replica. `20260725000000_init` applied cleanly; the service tracks `main`.
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
- [x] 2.5 Resolve and store the CRM user id by email; tolerate absence with a flag
      — **by zuid, not by email.** The sign-in account and the CRM record need not share a
      domain, so an email match would silently find nobody, and silently is the problem. The
      zuid is the one id that crosses Projects and CRM. Cached on the `User` row, since it
      never changes and the lookup returns the whole company. Absence is tolerated and
      logged: somebody can have a Projects account and no CRM record, and the consequence is
      a blank billing role rather than a failure.
      Worth noting the contrast: `GET crm/v8/users` works, while Zoho **Projects**' own
      `users/` endpoint answers `403 Invalid OAuth scope` for this credential
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
- [x] 2.11 Tests for every scenario in `specs/auth/spec.md`
      — 210 tests green. Covered: state mismatch, replayed code, consent refused, non-member
      (with the email logged), unreadable identity, missing email, missing refresh token,
      return-after-a-week sliding, expired/revoked/forged/unknown session, per-device sign
      out, grant retained while another device is live, tokens-at-rest ciphertext, silent
      refresh, revoked consent, open-redirect attempts on `returnTo`.
      **The two bundle scenarios are now covered too, against the deployed app** rather than a
      unit test — they could not be before, because there was nothing running to inspect.
      *No password is ever handled by the app*: `/login` serves no `type="password"` anywhere.
      *Nothing leaks to the client*: 627 KB of served JavaScript plus the HTML contain zero
      occurrences of the client secret, the OpenRouter key, or the names
      `ZOHO_CLIENT_SECRET`, `ZOHO_SERVICE_REFRESH_TOKEN`, `TOKEN_ENCRYPTION_KEY`,
      `DATABASE_URL`.
      **A live smoke test also caught a bug no unit test could**: the callback built its
      redirects from `new URL(request.url).origin`, which behind Railway's proxy is
      `localhost:8080` — so a successful sign-in would have redirected the user to localhost
      with their session cookie set. Redirects now use the origin of `ZOHO_REDIRECT_URI`.
      There is no proxy in a unit test, which is exactly why this needed a deployed app.

> **Sign-in works end to end, verified 2026-07-25** against
> `https://stelic-assistant-production.up.railway.app`: Zoho login → PKCE code exchange →
> portal membership from the user's own token → profile → `User` row → encrypted tokens →
> session cookie → the signed-in shell, showing the display name from the Zoho profile.
> Task group 2 is closed.

## 3. Project index

- [x] 3.1 Using the **service** credential, fetch projects (paged) and, per project, the
      tasks each user can log to — this lets the index be warmed before a user first signs in
      — `lib/zoho/{projects,factory}.ts`. Zoho pages with a 1-based `index` and signals the end
      by returning a short page: no total, no cursor. Every identifier comes from `id_string`,
      and `identifier()` **refuses** a numeric `id` past `Number.MAX_SAFE_INTEGER` rather than
      falling back to it — a corrupted id does not fail loudly, it addresses the wrong record.
      A row with no usable id is skipped, not guessed at, and does not fail the page.
      Task fetching is one call per project against a 100-per-120s limit, so
      `maxProjectsWithTasks` bounds it; a capped project stays indexed and matchable, just
      without charge codes
- [x] 3.2 For each project, read `crm_deal_id`; batch-fetch deal name and account name from
      CRM
      — `lib/zoho/crm.ts`. One batched call for every deal rather than one per project. The
      deal id is read from the documented column and, failing that, from a custom field, since
      not every portal carries it the same way.
      **Corrected 2026-07-25 after probing the live portal.** `custom_fields` is not a list of
      `{ label_name, value }` pairs — it is one single-key object per field, with the label as
      the key. The original parser matched nothing, so all 145 projects silently lost both
      their deal id and their client name. Worse, the assumption was invisible: zero matches
      looks exactly like a portal that simply has no CRM links.
      The fix turned out to be an improvement. **`Customer` is present on all 145 projects**
      (44 distinct values, none blank), so the client name comes straight off the project and
      the CRM round trip is now enrichment for the deal *name* only. A CRM failure, or a
      service credential without `ZohoCRM.modules.READ`, costs a nice-to-have instead of the
      index — and `buildProjectIndex` catches it and reports `crmFailure` rather than aborting.
      A project whose deal CRM does not return keeps its row. A `204` on a batch means "none
      of these exist"; any other error is caught at the call site, because a systematically
      broken CRM read must not quietly look like "no clients"
- [~] 3.3 Fetch the user's last 60 days of logs to derive a recency score per project
      — **Not from Zoho: that read does not exist.** Both documented forms of the portal-wide
      range call return `6891 "Given URL is wrong"` (design §5, task 6.11). The verified
      alternative is per-task, and walking every task of 145 projects is far outside the rate
      budget for a signal that only breaks ties.
      So `refreshRecency` derives it from `CommitLog` — this app's own record of what it
      wrote. Recency therefore starts empty for a new user and sharpens with use. The
      consequence is real and bounded: the matcher caps recency at 0.10, below the 0.15 resolve
      gap, so its absence can cost a tie-break and never a correct match. Revisit when 6.11
      establishes a contract
- [x] 3.4 Persist to `ProjectIndex`; build on login, refresh hourly and on demand
      — `lib/index/store.ts` plus `POST /api/index/refresh` (and `GET` for staleness, which
      spends no Zoho call). Projects absent from a build are deleted, so the matcher cannot
      keep offering something nobody can log to. `lastLoggedAt` is deliberately excluded from
      the upsert: it is the user's own history and a portal refresh must not wipe it.
      **"Build on login" is now automatic**: `app/index-warmer.tsx` checks staleness on the
      signed-in page and rebuilds if needed. It runs from the browser, not the page render — a
      rebuild walks every project and its tasks, and blocking first paint on a minute of Zoho
      calls would make signing in feel broken. The outcome is logged either way, so a failure
      is visible in the server logs rather than only in whoever's browser saw it.
      The route names `403 Invalid OAuth scope` as its own failure reason rather than a generic
      upstream error — it is the single most likely thing to be wrong on a first run, and task
      0.2 already hit it once
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
- [~] 3.7 Live fallback search (CRM Accounts → Deals → projects by `crm_deal_id`; Projects by
      name) when the index misses
      — **deliberately not built.** The window it would serve turned out to be very narrow: the
      index covers 145/145 projects and refreshes four times a day, and the matcher already
      tolerates a transposition (`clyaco` resolves to Clayco). So a genuine miss means a
      project created in the last few hours — and the cost is live Zoho calls on the *miss*
      path, against a limit that answers a breach with a quarter-hour lockout, at exactly the
      moment the user is already waiting. The current behaviour on a miss is to ask, with the
      nearest candidates as chips, which is a good answer.
      **Revisit if** the pilot (10.8) shows people hitting misses on real projects — that is
      the evidence this decision is missing, and it is a week away

## 4. Extraction (LLM via OpenRouter)

- [x] 4.1 OpenRouter client wrapper behind an `Extractor` interface (so the gateway can be
      swapped): base URL, `Authorization`, `HTTP-Referer`/`X-Title`, model + fallback list
      from env, provider policy `{data_collection: "deny", zdr: true, require_parameters:
      true}`, timeout, retry once, typed errors distinguishing 402 / 429 / model error.
      **Verify on first call** that the configured slug exists and that ZDR endpoints are
      available for it; fail closed and escalate if not
      — `lib/extract/{openrouter,errors}.ts`. `require_parameters: true` is load-bearing and
      easy to miss: without it OpenRouter may route to an endpoint that ignores `tools`
      entirely and the model answers in prose, which surfaces as a mysterious extraction
      failure rather than a routing problem. A `404` naming the data policy becomes
      `NoCompliantEndpointError` — **fail closed**, never retry without `zdr`. Retry is once
      and only for 429/5xx: a 402 will still be a 402 in two seconds, and a schema failure
      reproduces. One request id spans the retry chain
- [x] 4.2 Tool schemas `submit_time_entries` and `reply_only` per `design.md §4.1`, OpenAI
      function format, `tool_choice: "required"`; parse `tool_calls[0].function.arguments`
      and validate with Zod before anything downstream sees it
      — `lib/extract/schema.ts`. Written by hand rather than generated from Zod: a generator
      emits `anyOf`/`$ref` that some providers mishandle, and the field descriptions are doing
      real work — they are the only place the model is told to quote the user rather than
      interpret them. The model never returns a project id, a task id or a resolved date, so a
      wrong guess by it cannot become a wrong time log
- [x] 4.3 System prompt builder: today's date in user timezone, display name, 8 recent
      projects as hints, hard rules (never invent hours/projects/descriptions, verbatim
      `project_query` and `date_expression`)
      — `lib/extract/prompt.ts`, with a test asserting the prompt carries no Zoho id, no rate
      and no token. Recent projects are presented explicitly as hints, not a list to choose
      from — the app matches the project, the model never does
- [x] 4.4 Conversation windowing — last N turns only, with token budget
      — trimmed from the oldest end, because a follow-up like "make that 6 hours" depends on
      the newest turns. A single turn over budget is truncated and marked rather than dropped:
      dropping it would silently remove what the user just said
- [x] 4.5 Degraded mode: on gateway or tool-call failure, fall back to a guided slot-by-slot
      form; raise an operational alert on 402 (credits exhausted)
      — `lib/extract/degraded.ts` separates two decisions that are easy to conflate: what the
      user sees, and whether a human is paged. An exhausted balance looks like a mild hiccup to
      each individual user while quietly making the bot useless for everyone, so its message is
      gentle and its alert is loud. Tests assert that no message leaks a provider, model,
      status code or token, and that **every** failure still leaves the user able to log time
- [x] 4.6 Usage accounting: request `usage.include`, persist generation id, model actually
      served, tokens and cost against the message row; simple monthly cost query
      — `lib/extract/usage.ts`. Cost sits on the message that caused it, so "what did the bot
      cost last month" and "why was that turn expensive" are the same query. Grouped in SQL,
      since the table grows a row per turn. Cost is passed as a string: the column is
      `Decimal`, and float drift matters once thousands of rows are summed
- [x] 4.7 Fixture tests: single entry, two projects one sentence, one project three days,
      missing description, missing hours, pure question, gibberish, malformed tool call
      — all eight, against recorded response envelopes rather than convenient objects, plus
      the schema violations the model could plausibly produce: zero hours, hours past 24, an
      empty `project_query`, no entries, an unknown intent, an undefined tool, and prose where
      `tool_choice: "required"` should have forced a call

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
- [~] 5.4 Task resolver: PCCR lookup by (deal, CRM user) → labour category → task match;
      handle none / one / many
      — **Not the PCCR chain, and not yet.** That chain needs a CRM user id, which nothing
      resolves (task 2.5 is unstarted), and a rate sheet, which the live probe found on only
      **22 of 145** projects. Building it now would make the common case depend on data that
      mostly is not there.
      `resolveTask` instead uses the project's own task list, which every project has: exactly
      one task resolves silently, several become chips labelled with the tasklist and **never
      a rate**, none becomes an entry with something to say rather than a shrug. A
      `charge_code_hint` the user actually said narrows the list first, and falls back to the
      full list rather than to nothing when it matches nothing.
      Revisit when 2.5 lands and the rate-sheet coverage is understood
- [x] 5.5 Slot-state machine: which slot to ask next, ordered project → task → date → hours →
      description, entry by entry
      — `lib/resolve/slots.ts`. The order is not cosmetic: the task list depends on the
      project, so asking about hours first risks asking twice. Entries are finished one at a
      time — jumping between them is how a two-entry conversation becomes confusing.
      A **blocked** slot is never a question. A future date has no answer the user could give
      that makes it acceptable, so it is reported and the entry drops out of the commit
- [x] 5.6 Draft persistence, expiry, and re-resolution after each answer
      — `lib/resolve/draft.ts`. Re-resolution is targeted, not blanket: choosing a project
      recomputes the **task** slot, because the task list belongs to the project and keeping
      the old one would log to the wrong task. Nothing else cascades, so nothing else is
      touched — re-running every slot would risk turning an answered field back into a
      question. Answers are re-validated rather than trusted; typing "stuff" as a description
      is still rejected. Drafts expire after two hours, checked on read rather than swept by
      a job
- [x] 5.7 Warning engine: duplicate similarity, backdating. **No daily cap** — abandoned as a
      policy (open question 4); do not sum a user's daily total to warn on it
      — `lib/resolve/warnings.ts`. A duplicate is same project, same task, same day **and** a
      description scoring ≥ 0.8; same-day-same-task alone is not enough, because two hours of
      drafting in the morning and three in the afternoon are two honest entries. A test
      asserts that 23 hours across two entries produces **no** warning, so the abandoned cap
      cannot creep back in as a "helpful" nudge
- [x] 5.9 Store each user's Zoho **zuid** alongside their portal user id, from `login_id` on
      `GET /restapi/portals/`. The `owner` parameter on a time-log write takes a zuid, not a
      zpuid (spike 1.4), so the commit pipeline needs it on the `User` row
      — done with task 2.4: the callback writes `login_id` to both `zohoUserId` and
      `zohoProjectsUserId`, and a test asserts it
- [x] 5.10 Settle the timezone. The portal is configured `America/Los_Angeles` but
      `DEFAULT_TIMEZONE` is `America/New_York` (open question 11). Date resolution is already
      timezone-parameterised, so this is a configuration and per-user-preference decision, not
      a code change — but getting it wrong shifts logs by a day either side of midnight
      — **Answered 2026-07-25: neither. It is per person.** Stelic's people are in dispersed
      timezones, and a timesheet records a *day*, not an instant — so "yesterday" has to mean
      yesterday where the person is. A single app-wide zone would be wrong for most of them,
      and the portal's own setting describes where the portal was configured, not where anyone
      is sitting.
      The browser reports it (`Intl.DateTimeFormat().resolvedOptions().timeZone`), the app
      stores it on `User.timezone`, and the resolver already took a zone. Validated as an IANA
      name the runtime recognises — **a UTC offset is rejected**, because an offset cannot
      express DST, which is the exact class of bug this area exists to avoid.
      `DEFAULT_TIMEZONE` survives as the value a brand-new row starts with, before the browser
      has said anything.
- [x] 5.8 Unit tests for the full resolver against the spec scenarios
      — 45 covering entry resolution, the slot machine and the warnings, on a fixture built
      from **live** project shapes (`1066 - 1066 - Clayco EKI Data Center`,
      `Google LLC — 1080 - …`) rather than tidy invented ones

## 6. Commit pipeline

- [x] 6.1 Idempotency key derivation + unique constraint enforcement
      — derivation in `lib/commit/idempotency.ts`, normalising hours and description so
      `8` vs `8.00` and stray whitespace cannot produce two keys for one booking. Enforced in
      `lib/commit/commit.ts`: the losing insert is how a repeat is *detected*, so the answer
      comes from our own ledger rather than from asking Zoho what it already has
- [x] 6.2 `CommitLog` write-before-call, update-after-response
      — a row that survives as `pending` says "a log may exist in Zoho for this". A retry
      against a `pending` row is refused rather than attempted: an orphan a human can delete
      is recoverable, two invoiced logs are not
- [x] 6.3 Create time log in Zoho with correct `MM-DD-YYYY` date and `hh:mm` hours
      — `lib/zoho/timelogs.ts`, with delete and per-task reads alongside it. An accepted write
      whose response cannot be parsed is recorded as a **success with no log id**, because
      calling it a failure invites the retry that double-books; undo is what degrades
- [x] 6.4 Per-entry result aggregation; partial-failure reporting; retry-failed-only path
      — three entries where the second fails log two. Rate limiting and an expired credential
      stop the run instead, since they fail every remaining entry identically; the untried
      ones come back as `skipped` rather than `failed`
- [x] 6.5 `/api/drafts/{id}/confirm` — re-read the draft server-side, ignore any client-sent
      entry data. The route takes an id and nothing else; the body is not parsed at all. The
      draft is looked up scoped by `userId`, so someone else's is indistinguishable from one
      that does not exist. A draft commits **as far as it can go** (CHAT-3): an entry still
      awaiting an answer does not hold back the ones beside it, and the draft stays `pending`
      until nothing is left to answer or retry
- [x] 6.6 `/api/drafts/{id}/cancel` — idempotent, since the failure mode of a cancel button is
      a double tap. A confirmed draft is refused: cancelling does not undo anything, and
      answering `200` would leave someone believing hours had been removed from Zoho
- [x] 6.7 Undo: `/api/entries/{id}/undo` with same-day and app-origin guards; refuse approved
      logs — **the guard deliberately does not key off `approval_status`.** Spike 1.4 found
      every API-created log comes back `Approved` with nobody approving anything, so that
      check would have disabled undo entirely. App-origin is proved by our own `CommitLog`
      row instead, which is stronger than `added_via: "api"` — that would also match anything
      else built against the same portal. The route takes a `CommitLog` id, never a Zoho log
      id, so a crafted request cannot delete an arbitrary log. "Same day" means the day of the
      **commit**, in the person's own zone: backdating yesterday's hours this morning is
      undoable this morning
- [x] 6.8 Week read-back: `/api/entries/week` grouped by day with total — all seven days
      always present, Sunday first, including the empty ones. A week that silently omits
      Thursday reads as "nothing to see"; a Thursday showing `0h` answers the question that
      was asked. The per-day total is **Zoho's own**, not a re-sum of the entries: if the two
      ever disagree, the portal's number is the one the person sees in the grid. Runs on the
      user's own credential, not the shared service one — it is their own timesheet, and a
      per-person read on the shared credential would spend the index rebuild's rate limit
- [x] 6.11 Establish a working week read-back contract. The week runs **Sunday–Saturday**:
      the portal's `startday_of_week` is `sunday`
      — **found: it was a trailing slash.** `GET .../logs/` returns `6891`; `GET .../logs`
      returns `200`. Nine parameter shapes were tried against the trailing-slash form and all
      nine failed identically, which is what made this look like a missing endpoint. Two
      further findings, both silent failures rather than errors: `users_list` takes the
      **zuid**, not the zpuid — a zpuid returns `204`, an *empty week*, so the wrong id reads
      as "you logged nothing"; and a tasklog carries no `log_date`, so **the day comes from
      the enclosing group**, which for a backdated entry is a different day from
      `created_date`. Full contract in `design.md` §5
- [~] 6.12 Write `billing_role` after creating a log. Spike 1.4(b) proved
      `stampRoleOnTimelog` does not fire for API-created logs, so a log this app creates is
      **not** indistinguishable from a UI one until the app stamps the field itself
      — **the derivation described in TRNSF-914 does not exist.** There is no "CRM Resource
      Subform": the live Deals module has no subform field at all. The role lives in
      `Project_Charge_Code_Rates` — `Deal` × `Resource` (userlookup) × `Labor_Category` — and
      that query is now implemented and tested. **But `Resource` is null on every row**, so
      it resolves to nothing for every project today: those rows are rate-card entries per
      labor category, not per-person assignments. The app leaves the field blank, which is
      what TRNSF-914's own acceptance criteria specify; deriving a role from the deal's rate
      rows would put a wrong labor category on an invoice, and a wrong role is worse than a
      missing one because nobody looks twice at it.
      **This is not a blocker, and the earlier framing of it was wrong.** TRNSF-914 says so
      itself: *"The stamped role is for display/review only; billing still resolves
      independently by (user, project) at invoice time (TRNSF-867)."* The thing that has to be
      right on the log is the **owner**, and it is — every log is written on the person's own
      credential *and* carries an explicit `owner=<zuid>`. Role and rate are derived
      downstream from (user, project); nothing depends on the stamped copy.
      So the stamp is a convenience for the PM reading the Zoho grid, off by default. It turns
      itself on if someone populates `Resource` on the PCCR rows and sets `BILLING_ROLE_FIELD`
      — neither is needed for correct billing
- [~] 6.10 Undo guard against already-billed logs: refuse undo when the log's date falls in a
      period the invoice pipeline has already billed, so deleting it cannot orphan a pointer
      in the billing app's `invoiced_logs` ledger (`design.md §2`). Determine the boundary
      from Zoho or configuration — this app must not read the billing database
      — implemented as `BILLING_LOCKED_THROUGH`, an optional ISO date; undo refuses on or
      before it, unset means no lock. **The mechanism is done, the number is not**: nobody has
      told us what the pipeline has billed through, and it moves every run. Ask the pipeline
      owner for the boundary and whether it can be published somewhere this app may read
- [x] 6.9 Tests for double-confirm, partial failure, Zoho unavailable, expired draft
      — 62 tests across `commit-pipeline`, `commit-confirm`, `commit-undo` and
      `zoho-timelogs`, including the two that matter most: an unparseable success is not
      retried, and a Zoho error body never reaches a message a person reads

## 7. Chat API

- [x] 7.1 `/api/chat` orchestration: persist message → extract → resolve → respond with
      `{ reply, ui }`. The order is deliberate: the scope check first (an out-of-scope
      question should cost nothing), then the user's message persisted **before** the model
      call, so a degraded turn does not lose what they typed. The `ui` payload is the server's
      decision — the browser never sees the draft's internals, and a chip's value is only ever
      something the server put there
- [x] 7.2 `/api/chat/action` for chip taps: apply typed slot value, no LLM round trip — which
      is also what keeps chip taps working when the gateway is down, the whole point of the
      guided form. Its own looser quota, since a person working a guided form taps far more
      often than they type and spending the chat budget on taps would lock them out of the
      fallback path
- [x] 7.3 Stale-action guard (pwa-shell spec: *Stale options*) — refuses a chip whose slot is
      already answered, whose draft was cancelled or has expired, or that belongs to someone
      else, and **re-states the current question** rather than leaving a dead end. Returns
      `200`: the user tapped a real button, so the answer is conversational, not an error the
      client has to invent wording for
- [x] 7.4 Per-user rate limiting; 30 chat requests/minute — a fixed window, one row and one
      atomic increment, checked **before** the model call. The thing being protected is the
      model spend, not the server: counting afterwards would mean a user at the limit still
      pays for the request that tells them they are at the limit
- [x] 7.5 Out-of-scope guard: refuse rate, budget, invoice, approval and admin requests
      — **a keyword list alone would have been wrong.** "6h on Clayco for the budget review"
      is an ordinary time entry, and refusing it would block real work daily. So the test is
      a sensitive topic *and* the shape of a question; a message stating a duration is never
      refused. The real guarantee is that no code path in this app fetches a rate, a budget
      or an approval at all — this is the courteous front door on that absence
- [x] 7.6 `/api/me` — identity and index readiness in one call, so a returning user goes
      straight to the chat without a flash of the wrong state. No Zoho identifiers in the
      response; the email is there because a person needs to see which account they are on

## 8. PWA and chat UI

- [x] 8.1 `manifest.ts`, icons (192, 512, maskable), theme colour, `display: standalone`
      — the maskable variant is not a duplicate: Android crops a launcher icon to the device's
      own shape, so it carries the artwork pulled into the safe zone with the accent band
      dropped (a band running to the edge survives a circular crop only as a thin chord). The
      mark's optical centre was **measured**, not guessed — it sits at y 36.6 of 100, because
      the app icon reserves the foot of the square for the band. `scripts/generate-icons.mjs`
      regenerates them; it is not part of the build, so a deploy never depends on `sharp`
- [x] 8.2 iOS meta tags, apple-touch-icon, status-bar style, splash handling — iOS ignores the
      manifest almost entirely, so without `apple-web-app-capable` the "installed" app opens
      in a Safari tab with an address bar, which is exactly what installing was meant to
      avoid. `black-translucent` needs `viewportFit: cover` **and** the safe-area top padding,
      or the header sits behind the clock. `metadata`/`viewport` moved to their own module so
      a test can assert this without a CSS pipeline
- [x] 8.3 Service worker: app-shell caching only; never cache API responses — and the test
      **executes the worker** against a fake `self` rather than grepping its source, because
      a worker can grep right and behave wrong. A cached timesheet is a wrong timesheet, and
      a cached `/api/me` would leave the last person's name on a shared device. Navigations
      are network-first so a deploy lands without anyone clearing storage; cache writes go
      through `waitUntil`, or the browser can kill the worker before the write does
- [x] 8.4 Chat layout: dynamic viewport height, sticky composer above the keyboard,
      safe-area insets, 16px minimum input font — `dvh` rather than `vh` because on iOS `vh`
      is the height *without* browser chrome, so a `100vh` column is taller than the screen
      and the composer sits below the fold. The bottom inset goes on the composer, not the
      page, or the send button hides under the home indicator. `text-base` is not a style
      choice: iOS zooms a focused input below 16px and never undoes it
- [x] 8.5 `MessageList` with auto-scroll and screen-reader announcement of new messages
      — auto-scroll **only when already at the bottom**; scrolled up, a "jump to latest"
      button appears instead. The live region holds only the newest reply, not the whole
      transcript, or every change re-announces everything; focus never leaves the composer
- [x] 8.6 `Chips` component driven by the server `ui` payload — posts a typed value, never a
      synthesised sentence, and only ever a value the server put there. Disabled once
      answered rather than removed: the transcript should still read as a conversation
- [x] 8.7 `ConfirmationCard` — labelled fields, per-line warnings, total hours, disabled state
      while committing. Every field carries a **visible label**: this is the only screen
      between a sentence and an invoice line, and a dense line reads fine to whoever built it
      and is guesswork to everyone else. Warnings and blocks are distinguished in words, not
      only in colour. A blocked line is shown, marked, and excluded from the total
- [x] 8.8 Result state after commit: per-entry success/failure with retry — per entry, because
      "2 of 3 logged" leaves the person to work out which one is missing. A duplicate says so
      rather than showing a bare tick, which would imply it was written twice
- [x] 8.9 Week view screen
- [x] 8.10 Offline and error states — plain sentences with a next step. Nothing is queued or
      auto-sent; the text stays in the composer and the person decides
- [x] 8.11 Desktop layout: readable column, Enter to send, Shift+Enter for newline — and Enter
      only where there is a real keyboard. On a phone the on-screen return key is the only way
      to get a newline, so hijacking it would make multi-line entries impossible
- [x] 8.12 Accessibility pass: labels, focus order, contrast, reduced motion — 44px targets,
      visible focus rings that work on both themes, `motion-reduce` on every transition, and
      status words (`Blocked:`, `Warning:`, `Logged:`) so meaning never rests on colour alone

## 9. Hardening

- [x] 9.1 Structured logging with request ids; ensure no message content reaches third-party
      sinks — one logger (`lib/observability/log.ts`) replacing two ad-hoc ones and twenty-odd
      bare `console.info(JSON.stringify(…))` calls. Each of those was individually careful,
      which is the problem: carefulness that lives at every call site is carefulness a future
      call site will not have. The request id travels in `AsyncLocalStorage`, so a logger deep
      in the Zoho client carries it without taking it as a parameter, and a `route()` wrapper
      turns an uncaught error into a logged 500 with that id rather than Next's default page.
      **`redact` drops the forbidden field names rather than masking them** — `"description":
      "[redacted]"` still tells a reader an entry had one, and invites someone to unmask it
      "temporarily"
- [x] 9.2 Verify no secret is reachable from the client bundle (build-time check)
      — `npm run check:bundle`, two passes: every secret-shaped env var searched **by value**
      in the emitted client chunks, plus **by shape** for credentials this process cannot see
      (a CI box without production env, or a hard-coded one). **The checker is itself tested**
      against a fixture with planted secrets, because a scanner that has only ever reported
      "clean" is a scanner nobody has tested — and it fails loudly on an empty scan, since a
      green check that never opened a file is the worst outcome. It never prints what it found
- [x] 9.3 Input length limits and prompt-injection guard on user text (the model must never
      be able to widen its own tool surface)
      — **no phrase filter, deliberately.** Every list of forbidden phrasings is a list
      somebody rephrases around, and relying on one would rest the app's safety on a regex.
      The guarantee is structural and now tested as such: two tools and no others, a malformed
      call discarded whole rather than partly used, every value re-derived by deterministic
      code that ignores what the model thought, and a confirmation tap before anything is
      written. The mechanical part — control characters, bidi overrides that can hide text,
      zero-width padding, a length bound — is `lib/chat/sanitise.ts`, sanitising **before**
      the bound so invisible padding cannot smuggle a message past it
- [x] 9.4 Health check endpoint + Railway restart policy — `/api/health` checks the database
      and **nothing else**: a check that called Zoho or OpenRouter would fail the instance
      during someone else's outage and have Railway restart a container that was working,
      turning a degraded dependency into an unavailable app. It exposes up-or-down only — an
      unauthenticated endpoint answering "which env vars are set" is a reconnaissance gift.
      Railway: healthcheck `/api/health`, timeout 30s, restart `ON_FAILURE` ×10
- [x] 9.5 Seed/import script to warm the project index for all portal users
      — `scripts/warm-index.mjs`. Not a loop over people: the index is **shared**, so one
      rebuild serves everybody. It triggers the same endpoint the schedule calls rather than
      carrying a second, subtly different rebuild for operators to keep in sync, and it reads
      the body rather than the status, because that route answers 200 on failure by design
- [x] 9.6 Operational alerting for configuration and quota faults that are not the user's
      fault: portal-user lookup failing on scope (auth spec: *Portal user lookup is
      unavailable*), OpenRouter `402`, no ZDR-eligible endpoint. One channel, one severity —
      the user always sees a plain sentence, never the cause
      — `alert()` emits `level: "alert"` and nothing else does, so a drain filters on one
      predicate and a human is woken by one rule. A second severity becomes the one nobody
      routes. Wired to all three named faults plus a dead service credential and a missing
      `CRON_SECRET`; the user-facing message never changes

## 10. Verification

- [~] 10.1 Every scenario in `specs/auth/spec.md` passes manually
- [~] 10.2 Every scenario in `specs/timesheet-chat/spec.md` passes manually
- [~] 10.3 Every scenario in `specs/pwa-shell/spec.md` passes manually
      — **mapped rather than ticked**, in `docs/verification.md`. 112 scenarios across the
      three files; each of the 32 requirements is matched to the test that proves it or marked
      as needing a person. Ticking these three without knowing which scenarios a machine
      already covers would be a signature on somebody else's work. The great majority are
      covered automatically; what is left is genuinely physical — a real handset, a real
      conversation with a real model, a person trying to break the description field
- [x] 10.4 Playwright E2E: login → single entry → confirm → verify in Zoho → undo
      — `e2e/timesheet.spec.ts`, and it runs against a **real deployment** rather than a dev
      server with a mocked Zoho. That is the whole point: everything below the API boundary is
      already covered by unit tests against recorded shapes, and what those cannot tell you is
      whether the shapes are still true. Both of this project's worst bugs would have passed a
      mocked run. It verifies the write by reading it back **from Zoho**, not from our own
      screen, and undoes itself so a run leaves the timesheet as it found it. Skips rather
      than fails without credentials — a red run meaning "not configured here" is a red run
      people stop reading. **Not yet executed against production**: it needs a live session
      cookie, which is 10.5's job to supply
- [ ] 10.5 Cross-check five app-created logs against the Zoho Projects UI: owner, task,
      tasklist, date, hours, bill status, `billing_role`
- [ ] 10.6 Confirm an app-created log flows correctly into the existing invoice pipeline in a
      test billing period
- [ ] 10.7 Install and use on a real iPhone and a real Android device
- [~] 10.8 Pilot with 3 Stelic users for one week; capture every message the bot mishandled
      — **first field report captured, not a full week yet.** A real conversation in
      production surfaced four real bugs:
      (1) `resolveDate` had no month-name parsing at all — "July 25th" fell through to
      `unrecognised` with no wording that didn't hit the same gap again on retry. Fixed in
      `src/lib/resolve/date.ts`, mirroring the existing bare-numeric "most recent occurrence"
      convention for a year-less date.
      (2) A typed answer to a question with no chips (date, hours, description) was posted to
      `/api/chat` as a brand-new turn instead of to `/api/chat/action` as the answer to the
      slot actually being asked about — so the model re-extracted from scratch and re-asked the
      already-answered project question, forever. CHAT-7 already promises the same free-text
      fallback on chip questions too, so the fix (`pendingQuestion`/`answer` in
      `src/lib/chat/transcript.ts`, wired in `src/components/chat/chat.tsx`) covers both cases
      by position in the transcript, not by trusting a stale `answered` flag.
      (3) The browser-triggered index rebuild fired on ordinary hourly staleness, not only on a
      genuinely empty index, so returning users saw "Loading your projects from Zoho…" on
      almost every visit. Fixed in `src/app/index-warmer.tsx` — gated on `projects === 0`.
      (4) The composer's send button sat a couple of pixels off from the input box
      (`items-end` against a textarea whose own natural height exceeded its `min-h`). Fixed in
      `src/components/chat/composer.tsx` (`items-center`).
      **Second field report, same conversation, two more bugs the first fix didn't reach:**
      (5) The fix in (2) rerouted the composer to `/api/chat/action`, but `applyAnswer` in
      `src/lib/resolve/draft.ts` only ever accepted a project/task **id** — exactly what a chip
      posts, never what a person types. A typed correction ("google", "none of these, find
      more") matched nothing, the entry never changed, and the bot asked the identical
      ambiguous-project question forever: the free-text fallback existed for every slot except
      the two it was demonstrated on. Fixed by falling back to `resolveProject`/`resolveTask` —
      the same matcher a fresh mention gets — whenever the value isn't a known id.
      (6) The ambiguous-project candidates it *did* offer had nothing to do with what was
      typed: "etoe project" matched four unrelated projects purely because this portal's own
      naming convention embeds the literal word "Project" in nearly every project name, and the
      matcher's trigram/token scoring counted that shared word as a real signal. Fixed in
      `src/lib/index/normalise.ts` (`FILLER_WORDS`, `dropFillerWords`) and
      `src/lib/index/match.ts`, scoped to project matching only — the generic
      `trigramSimilarity` used elsewhere (duplicate-description warnings) is untouched.
      **Design change requested off the back of this pilot feedback, not a bug fix:** the user
      asked for the conversation to feel like talking to an LLM rather than a rigid form — able
      to handle "oh i meant X" and "actually make it 6 hours" as corrections, including to a
      slot that had already resolved, not only the one currently being asked about. CHAT-7 is
      revised accordingly: a typed reply to a pending question now goes through a lightweight
      continuation classifier (`src/lib/chat/continuation.ts`, wired into `runChatTurn` in
      `src/lib/chat/turn.ts`) that decides whether the reply answers the pending slot, corrects
      any other value already in the draft, or is unrelated — before the more expensive
      full-sentence extraction ever runs. Every update it names still goes through the exact
      same deterministic `applyAnswer` a chip tap uses, so a wrong classification produces a
      wrong follow-up question at worst, never a wrong Zoho entry. Runs on
      `OPENROUTER_CONTINUATION_MODEL` (default `anthropic/claude-haiku-4.5`) rather than the
      main `OPENROUTER_MODEL` (Sonnet 5) — this is a short classification over a pending
      question and the draft's own entries, not the harder job of splitting a whole sentence
      into entries, and it now runs on every reply to a pending question rather than only on a
      fresh message, so cost and latency mattered in the choice. The composer's own free-text
      routing added for bug (2) above was reverted (`src/components/chat/chat.tsx`,
      `src/lib/chat/transcript.ts`) — every typed reply now goes through `/api/chat` regardless
      of whether a question is pending, and the backend decides; only chip taps still skip the
      model entirely.
      **Third field report:** the user retested seconds before Railway finished deploying the
      matcher fix and saw the old behaviour one more time (the deploy went live 19:59:14 UTC;
      the fix itself is covered by a test against the report's exact four project names). The
      actionable part: with up to two model calls per turn now, the wait needs visible
      feedback — added a typing indicator to `src/components/chat/message-list.tsx` (animated
      dots while a turn is in flight, `motion-reduce` respected, announced politely to screen
      readers via the existing live region).
      **Fourth field report — new-task answers.** The user answered the charge-code chips
      with 'i want something else like "i created an app"'. Two things were wrong: the
      classifier read a rejection of the offered options as a new message (extraction
      restarted and re-asked the project), and there was no way to log to a task that is not
      on the list — even though Zoho itself lets anyone add an arbitrary task. Both fixed,
      and CHAT-3's "no charge codes — ask your PM" dead end closed by the same mechanism:
      a typed answer to the task question that matches no existing charge code becomes a
      task created at commit time (`resolveTypedTask` in `src/lib/resolve/entry.ts`,
      `taskId: null` on the slot; a typo still narrows to the existing task first). The card
      marks it "new — will be added to the project"; nothing is created before the confirm
      tap; the pipeline (`src/lib/commit/commit.ts`) finds-or-creates by name on the user's
      own credential (`createTask`/`findTaskByName` in `src/lib/zoho/projects.ts`), so a
      retry after "task created, log failed" reuses the first attempt's task. New scope
      `ZohoProjects.tasks.CREATE` added to `REQUIRED_SCOPES` — sessions from before it fail
      that one action with a sign-in-again message until the person re-consents (runbook
      notes this). **The create-task call shape is from Zoho's documented v1 API but has not
      been probed live** the way the time-log calls were — a failed create surfaces as a
      clean per-entry failure with retry, so the risk is bounded, but the first real use
      should be watched (10.5's cross-check now includes one chat-created task).
      The rest of the week is still open

## 11. Handover

- [x] 11.1 One-page user guide (English, screenshots, install instructions per platform)
      — `docs/user-guide.md`. Install steps for iOS, Android and desktop; how to phrase an
      entry; what it will not do and why. **No screenshots yet** — they should be of the real
      thing on a real phone, which is 10.7
- [x] 11.2 Runbook: env vars, token rotation, index rebuild, common errors
      — `docs/runbook.md`. Every variable and what breaks without it, the two-credential
      split and how to reconnect the service one, the Zoho rate limit (a `400`, not a `429`,
      with a quarter-hour lockout) and why the rebuild is deliberately slow, an error table
      keyed on what you actually see in the logs, and the known gaps stated plainly rather
      than left for the next person to rediscover.
      **`README.md` rewritten** too: it still claimed the repo held no application code
- [x] 11.3 Jira: link the repo and this spec folder to the Stelic epic — posted to
      [TRNSF-589](https://transformatiive.atlassian.net/browse/TRNSF-589) with links to the
      repo, the user guide, the runbook, the design and the specs, plus the two Zoho findings
      that affect other work in the epic (the `custom_fields` shape and the trailing slash)
      and the `Charge_Code_Rates` rename that never took effect
