# Design: Stelic Timesheet Chatbot

> Implementation detail lives here. Behaviour contracts live in `specs/*/spec.md`.

---

## 1. Architecture overview

A single Next.js application. The browser holds no credentials and never talks to Zoho or
the model gateway directly. Each inbound chat message runs through a four-stage server pipeline —
**extract → resolve → clarify/confirm → commit** — where only the first stage uses the LLM.
Postgres holds sessions, encrypted Zoho refresh tokens, the conversation transcript, a cached
index of projects/tasks/charge codes, and an append-only commit log used for idempotency and
audit.

```
┌───────────────────────────┐
│  PWA (Next.js client)     │  chat surface, quick-reply chips, confirmation card
│  installable, no secrets  │
└─────────────┬─────────────┘
              │ fetch /api/chat  (session cookie)
┌─────────────▼─────────────────────────────────────────────────┐
│  Next.js route handlers (server)                              │
│                                                               │
│  1 EXTRACT   OpenRouter → claude-sonnet-5, tools → DraftEntry[]│
│  2 RESOLVE   deterministic: project → task → date → hours      │
│  3 CLARIFY   emit chips for every unresolved slot              │
│  4 CONFIRM   summary card → user taps Confirm                  │
│  5 COMMIT    POST time log per entry, idempotent + audited     │
└──────┬──────────────────────┬─────────────────────┬───────────┘
       │                      │                     │
┌──────▼──────┐      ┌────────▼────────┐   ┌────────▼─────────┐
│ PostgreSQL  │      │ Zoho Projects   │   │ Zoho CRM         │
│ (Railway)   │      │ portal 911636649│   │ Accounts, Deals, │
│             │      │ projects, tasks,│   │ Project_Charge_  │
│ sessions,   │      │ users, TIME LOGS│   │ Code_Rates       │
│ index cache,│      └────────┬────────┘   └──────────────────┘
│ commit_log  │               │
└─────────────┘      ┌────────▼──────────────────────────────┐
                     │ existing automation (untouched):      │
                     │ stampRoleOnTimelog → billing_role     │
                     │ → n8n invoice pipeline → Books        │
                     └───────────────────────────────────────┘
```

---

## 2. Decisions

### Decision: Sign in with Zoho (OAuth authorization code) instead of app-managed passwords

**Choice.** The login screen has one button, *Sign in with Zoho*. The user lands on Zoho's
own login page, enters their Stelic email and password there, and returns with an
authorization code. We exchange it for an access token (1 h) plus a refresh token, encrypt
the refresh token at rest, and keep the session alive indefinitely by refreshing on demand.

**Why.**
1. **No password custody.** We never store, transmit or reset a Stelic password. This removes
   the entire credential-breach surface from a client-facing app.
2. **Correct log ownership.** Time logs are created *by the user's own token*, so `owner` is
   right, permissions are enforced by Zoho, and nobody can log hours for someone else. With a
   shared service token we would be impersonating users on a billing-relevant record.
3. **Identity is guaranteed.** The token's user *is* the Zoho Projects portal user, so the
   email join key (the standard across CRM / Projects / Books in this estate) is exact rather
   than inferred.
4. **Offboarding is free.** Disable the Zoho user, the app dies with it.
5. It still satisfies "log in with email and password" from the user's point of view — the
   credentials are the ones they already know.

**Alternatives considered.**
- *App-managed email + bcrypt password.* Rejected: password custody for a third party's
  staff, and a second set of credentials to distribute and reset. Retained only if open
  question #2 shows some timesheet users have no Zoho account.
- *Magic-link email login.* Rejected: adds an email provider dependency, and the link flow is
  awkward on mobile when the mail client opens a different browser than the installed PWA.
- *Reusing the existing Stelic service credential for the write path too.* This is the
  decision below — reads yes, writes only if the spike proves it possible.

**Reuse the existing OAuth client.** The registered client behind the vault token already
uses a redirect URI, so it is a server-based application, not a self-client. Add this app's
redirect URI to it rather than registering a new one — no new client, no new consent, one
place to rotate.

---

### Decision: the existing Stelic service credential does all reads; the user's own token does the writes

**Choice.** Two credentials, split by direction:

| Direction | Credential | Why |
|---|---|---|
| **Reads** — project list, tasks, portal users, CRM Accounts/Deals/PCCR, existing logs for duplicate and cap checks | The existing Stelic refresh token held in the credential vault under **`TRNSF-600`** | Already provisioned, already scoped, already trusted. Nothing to register, nothing to ask Alex for. |
| **Writes** — creating and deleting time logs | The signed-in user's own token | A time log's owner is the person whose utilisation, approval queue and invoice line it becomes. It cannot be a service account. |

**Why this split.** The service credential lets us build and refresh the per-user project
index *before* a user has ever signed in, keeps CRM scopes off individual user tokens, and
removes a per-message dependency on the freshness of each user's token. The write path is the
one place where identity is not an implementation detail but the record itself.

**Verified state of the vault entry** (`TRNSF-600`, checked 2026-07-25):

- Domain `https://www.zohoapis.com` (US DC), portal `stelic` / `911636649`, Books org `911636705`
- Scopes: `ZohoCRM.settings.ALL, ZohoCRM.modules.ALL, ZohoProjects.portals.ALL,
  ZohoProjects.projects.ALL, ZohoProjects.tasks.ALL, ZohoProjects.timesheets.ALL,
  ZohoProjects.custom_fields.ALL, ZohoBooks.fullaccess.all`
- Declared deploy capabilities include `projects_api` and `timesheets_api`

**Gap to close (task 0.2):** the scope string has no `ZohoProjects.users.*`. Mapping a
signed-in email to a portal user id — the join key the whole design rests on — reads
`/portal/{id}/users/`. Confirm whether `portals.ALL` covers it; if not, re-consent the token
with the users scope added.

**Alternatives considered.**
- *Proxy every Zoho call through n8n, which already holds the credentials.* Rejected for the
  hot path: it adds a network hop and a second failure domain to a user-facing app where the
  target is a sub-second reply, and it puts chat traffic through an automation runtime sized
  for batch work. The app reads the credential from the vault at boot and calls Zoho directly.
  n8n stays the owner of the batch and billing workflows, untouched.
- *A second, app-specific service token.* Rejected: two tokens to rotate for the same estate,
  and no benefit — the vault entry already has the scopes this app reads.

---

### Decision (PROVISIONAL — gated on spike 1.4): who owns an API-created time log

**The question.** Can a portal-admin token create a time log owned by a different user? If
yes, the service credential could do the writes too and per-user OAuth becomes optional. If
no, per-user OAuth is mandatory and is not a security preference but a functional
requirement.

**Current evidence points to *no*.** The documented create-log parameters are `date`,
`hours`, `bill_status` and `notes` — there is no owner field — and Zoho's own support
position on logging time for other portal members has been that it is not supported by
design. That evidence is indicative, not conclusive: it predates the current API version and
was not tested against this portal.

**So it gets tested before anything is built on it.** Task 1.4 runs the experiment against
the real portal with the real vault token. The result decides the auth path:

- **Cannot set owner** → per-user OAuth as specified. Task group 2 stands as written.
- **Can set owner** → the service credential may do the writes, and login can be simplified
  (an app-managed identity becomes viable). Task group 2 shrinks; task group 6 gains an owner
  parameter; §8's audit requirements get *stricter*, because Zoho's own audit trail would then
  attribute every log to the service account and ours becomes the only record of who actually
  said what.

Do not start task group 2 before 1.4 has an answer.

---

### Decision: OpenRouter as the model gateway

**Choice.** All model traffic goes through OpenRouter's OpenAI-compatible endpoint
(`https://openrouter.ai/api/v1/chat/completions`), primary model `anthropic/claude-sonnet-5`,
with a declared fallback and explicit provider-routing policy.

**Why.**
1. **One vendor relationship, one key, one bill** across Transformatiive's client apps —
   consistent with how other tooling in this estate is wired.
2. **Model portability without a code change.** The model slug is an environment variable.
   If Sonnet 5 is unavailable, degrades, or a cheaper model proves sufficient for what is
   fundamentally a slot-extraction task, it is a config change, not a refactor.
3. **Built-in failover.** OpenRouter routes across providers hosting the same model and
   retries the next-best on error, plus a `models` fallback array for model-level failover.
   Building that against a single provider API would be our own work.
4. **Privacy is controllable per request.** Time-entry descriptions are client work detail,
   so every request pins `provider: { data_collection: "deny", zdr: true }` — no provider
   that trains on inputs, and only Zero Data Retention endpoints. These are two different
   guarantees and both are required here.
5. **Tool-calling reliability is selectable.** The whole design depends on the model
   returning a well-formed tool call; OpenRouter's tool-accuracy-optimised routing mode is
   the right setting for this workload, and `require_parameters: true` excludes any endpoint
   that would silently drop the `tools` payload.

**Cost.** At roughly 1.5k input + 300 output tokens per message, ~$0.006 per message at the
current $2/$10 per million rate. Thirty users at five messages a day lands near **$20/month**.
Note the Sonnet 5 rate moves to $3/$15 on 1 September 2026 — budget ~$30/month after that.
Prompt caching of the system prompt reduces this further.

**Alternatives considered.**
- *Anthropic API direct.* One less hop and marginally lower latency, but a second vendor
  account for this client, no cross-provider failover, and a model swap becomes a code
  change. Kept as the emergency path — the extraction module is behind an interface, so
  swapping the gateway is one file.
- *`openrouter/auto` routing.* Rejected: the pool composition changes, and a silent model
  change under a billing-critical extractor is exactly the kind of non-determinism this
  design is trying to remove.

**Consequence.** The prompt-injection guard (task 9.3) matters slightly more here: requests
traverse a third-party proxy, so no Zoho identifier, token, or rate ever appears in a prompt.

---

### Decision: the LLM extracts, deterministic code resolves

**Choice.** One model call per user message. The model's only job is to turn free text
into a typed `DraftEntry[]` via a tool schema, plus a short natural-language reply. Project
matching, date arithmetic, hour parsing, validation, duplicate detection and the Zoho write
are ordinary TypeScript with unit tests.

**Why.** Matching "clayco" to the right one of 120 projects is a search problem with a right
answer, not a judgement call — and a wrong match silently mis-bills a client. Deterministic
resolution is testable, cheap, and explainable ("I matched *Clayco* to *Clayco — MS Data
Center* because you logged to it last week"). It also keeps the prompt small: we never paste
the full project list into the context.

**Alternatives considered.**
- *Give the model tools and let it call Zoho directly in a loop.* Rejected for v1: more
  latency, more tokens, non-deterministic matching, and a much harder failure mode to reason
  about when a write happens mid-loop. Reconsider once the deterministic loop is proven.
- *No LLM at all — regex/grammar parsing.* Rejected: brittle against natural phrasing, and
  the multi-entry sentence ("6h on A doing X, then 2h on B doing Y") is exactly where a
  grammar falls apart.

---

### Decision: a cached, per-user project index is the matching corpus

**Choice.** On login and then hourly (and on cache miss), build a per-user index of the
projects that user can log to. Each row carries: Zoho Projects `project_id` and name, the
linked CRM deal name and account name (via the project's `crm_deal_id` custom field), the
user's charge codes on that project, and a recency score from their last 60 days of logs.
Match with normalised token search plus fuzzy scoring, boosted by recency.

**Why.** Users say the *client* name ("Clayco"), not the project name ("Clayco — MS Data
Center"), and sometimes the deal name. All three must resolve. Doing that live against three
Zoho APIs per message would be slow and rate-limit-prone; the index makes matching a
sub-millisecond local operation and gives us the recency signal that resolves most ambiguity
without asking the user anything.

**Alternatives considered.**
- *Live CRM/Projects search per message.* Kept, but only as the fallback path when the index
  returns nothing — a genuinely new project should still be findable without waiting an hour.
- *Postgres full-text / pg_trgm.* Viable, but the corpus is a few hundred rows per user; an
  in-process matcher (Fuse.js or a hand-rolled trigram score) is simpler and easier to unit
  test.

---

### Decision: charge code resolved from the user's `Project_Charge_Code_Rates` row

**Choice.** A time log must attach to a task. The task is derived, not asked for, whenever
possible: user email → CRM user → the project's deal → the `Project_Charge_Code_Rates` (PCCR)
row where `Resource` = that user → `Labor_Category` → the task in that project whose name or
charge-code field matches. Only when that chain returns zero or multiple candidates does the
bot ask, with buttons.

**Why.** This mirrors the rate-resolution rule already in production (`stampRoleOnTimelog`,
TRNSF-914). Asking a consultant which charge code to use invites the wrong answer and
mis-billed hours; the system already knows. Consultants should be asked about *work*, never
about *billing structure*.

**Alternatives considered.**
- *Always ask the user to pick a task.* Rejected: slower, and exposes budget-category naming
  ("Change Order 1") to people who shouldn't have to reason about it.
- *Log against the project with no task.* Rejected: breaks budget-category roll-up and the
  invoice line structure, which are per-tasklist.

**Explicit non-behaviour.** The app never creates a task, a tasklist or a PCCR row. If the
user has no charge code on that project, it says so and points them at their PM.

---

### Decision: nothing is written to Zoho without an explicit confirmation tap

**Choice.** Every commit is gated by a summary card listing each entry (project, task, date,
hours, description, billable) with **Confirm all**, **Edit**, **Cancel**. The confirmation
payload references a server-held draft id; the client cannot submit arbitrary entry data.

**Why.** These records are billing source data. A misheard dictation that silently books 8
hours to the wrong client is worse than a slower flow. The tap is also the natural place to
surface warnings (daily cap, possible duplicate, backdating).

**Alternatives considered.**
- *Auto-commit when confidence is high, undo afterwards.* Rejected for v1. Undo exists, but
  as a correction path, not as the primary safety net.

---

### Decision: Railway + Next.js, not Replit

**Choice.** Deploy on Railway, in **its own Railway project with its own Postgres service** —
not inside the existing `Stelic Financials` project.

**Why Railway.** Same operational surface Nuno already runs and monitors, stable custom domain
(a hard requirement for both PWA installability and the OAuth redirect URI), managed Postgres,
and no cold-start behaviour on a user-facing app that must feel instant.

**Why its own project.** Two reasons, one forward-looking and one about blast radius:

1. **This is a separate product, not a feature of the billing app.** The likely direction is a
   general Stelic assistant — a knowledge-base chat with timesheet entry as its first
   capability. That does not belong inside a project scoped to financials, and moving it later
   costs a domain change, which is the one thing an installed PWA and a registered OAuth
   redirect URI both hate.
2. **Its database holds different material.** Encrypted per-user Zoho refresh tokens, session
   ids and the full chat transcript have a different sensitivity and a different retention
   profile from billing data, and two applications should not run Prisma migrations against
   one schema.

The app therefore reaches Zoho and CRM over their APIs like any other client. It has no
database-level relationship with the billing app, and it never writes to the `invoiced_logs`
ledger or the n8n invoice pipeline (see `project.md` → *Integration surface*).

**Separate database does not mean separate time records.** Zoho Projects is the single system
of record for time. A bot-created log is written to portal `911636649` exactly as the Zoho UI
would write it — same task, same owner, same `bill_status`, and still triggering
`stampRoleOnTimelog`. Anything downstream that sources time from Zoho, including the billing
app and the invoice pipeline, therefore picks up bot-created entries with no second copy to
reconcile. This app's Postgres holds only its own operational state (sessions, encrypted
tokens, transcript, project index, `CommitLog`); it is an audit trail of what the app did, not
a parallel record of time. Tasks 10.5 and 10.6 verify this end to end.

**One writer, not two.** The app SHALL NOT write time rows into the billing app's database,
even if that database mirrors time. Two independent writers into a billing-relevant table with
no shared idempotency contract diverge silently, and the divergence surfaces as a wrong
invoice. If the billing app needs bot-created entries, it sources them from Zoho like every
other consumer. See open question 10 — this rests on the billing app deriving time from Zoho
rather than authoring it, which is **not yet verified**.

**Alternatives considered.**
- *A second service inside the existing `Stelic Financials` project* (which already contains
  an app service and a Postgres). Rejected per the reasoning above — it saves one project and
  costs product independence.
- *Replit Reserved VM* — used for the analytics app, and workable, but splits hosting across
  two providers for one client with no benefit.
- *Vercel* — good fit for Next.js, but adds a third vendor and moves Postgres away from the app.

---

### Decision: quick-reply chips are server-driven, typed UI elements

**Choice.** The chat API returns, alongside the assistant text, an optional array of typed
UI actions (`chips`, `confirmation_card`, `entry_list`). The client renders them; tapping one
posts a structured action back, not a synthesised sentence.

**Why.** Round-tripping a tap as "the user said *Clayco — MS Data Center*" would push the
choice back through the LLM and reintroduce ambiguity that was just resolved. A typed action
resolves the slot directly and deterministically, and keeps mobile typing near zero — the
stated goal.

---

## 3. Data model (Prisma, PostgreSQL)

```
User
  id, zoho_user_id, zoho_projects_user_id, crm_user_id, email (unique),
  display_name, timezone (default 'America/New_York'), is_active,
  created_at, last_seen_at

OAuthToken                       -- one row per user
  user_id (unique FK), refresh_token_encrypted, access_token_encrypted,
  access_token_expires_at, scope, updated_at

Session
  id (cuid, = cookie value), user_id FK, user_agent, ip_hash,
  created_at, last_used_at, expires_at, revoked_at

Conversation
  id, user_id FK, started_at, last_message_at

Message
  id, conversation_id FK, role ('user' | 'assistant'), content,
  ui_payload jsonb NULL, created_at,
  -- gateway accounting (task 4.6); null on assistant turns produced without a model call
  generation_id NULL, model_requested NULL, model_served NULL,
  prompt_tokens NULL, completion_tokens NULL, cost_usd decimal NULL

ServiceToken                     -- single row; the vault TRNSF-600 credential, reads only
  id, access_token_encrypted, expires_at, refreshed_at
  -- rapid successive refreshes on this tenant trigger rate limiting, so the access token is
  -- cached here and refreshed at most once per expiry window across all app instances.
  -- The refresh token itself is never stored here: it comes from the vault at boot (§7).

RateLimit                        -- fixed-window counter, per user per route
  id, user_id FK, bucket,            -- e.g. 'chat'
  window_started_at, count
  @@unique([user_id, bucket, window_started_at])

Draft                            -- a pending set of entries awaiting confirmation
  id, conversation_id FK, user_id FK, status ('pending'|'confirmed'|'cancelled'|'expired'),
  entries jsonb, created_at, expires_at (default now() + 30 min)

CommitLog                        -- append-only, one row per attempted entry
  id, draft_id FK, user_id FK, idempotency_key (unique),
  project_id, project_name, task_id, task_name, log_date, hours_decimal,
  billable, description, status ('pending'|'success'|'failed'|'undone'),
  zoho_log_id NULL, zoho_response jsonb NULL, error_message NULL,
  source_message_id FK, created_at, completed_at

ProjectIndex                     -- per-user matching corpus
  id, user_id FK, project_id, project_name, project_id_string,
  crm_deal_id NULL, deal_name NULL, account_name NULL,
  aliases text[], charge_codes jsonb,   -- [{task_id, task_name, labor_category, tasklist}]
  last_logged_at NULL, refreshed_at
  @@unique([user_id, project_id])
```

**Idempotency key:** `sha256(user_id | project_id | task_id | log_date | hours | description)`
truncated to 32 chars. A repeat confirmation of the same draft therefore cannot double-book.

---

## 4. Resolution pipeline

### 4.1 Extract (LLM via OpenRouter)

One chat-completions call per user turn:

```jsonc
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer $OPENROUTER_API_KEY
HTTP-Referer: <app origin>          // attribution
X-Title: Stelic Assistant

{
  "model": "anthropic/claude-sonnet-5",        // from OPENROUTER_MODEL
  "models": ["anthropic/claude-sonnet-4.5"],   // model-level fallback
  "max_tokens": 1500,
  "temperature": 0,
  "tools": [ /* the two schemas below, OpenAI function format */ ],
  "tool_choice": "required",
  "provider": {
    "data_collection": "deny",   // no provider that trains on inputs
    "zdr": true,                 // Zero Data Retention endpoints only
    "require_parameters": true   // only endpoints honouring `tools`
  },
  "usage": { "include": true },  // token + cost accounting per call
  "user": "<opaque user hash>",  // per-user attribution, never the email
  "messages": [ /* system + windowed conversation */ ]
}
```

The system prompt is compact and contains: today's date in the user's timezone, the user's
display name, the user's 8 most recent projects (name + account) as *hints only*, and the
rules (description mandatory, never invent hours, never invent a project). It carries no
Zoho identifier, no rate, and no token.

The model must reply through one of two tools:

```jsonc
// tool: submit_time_entries
{
  "entries": [
    {
      "project_query": "clayco",          // verbatim user wording, not a guess at the real name
      "date_expression": "yesterday",     // verbatim; resolved deterministically downstream
      "hours": 8,                          // decimal, null if not stated
      "description": "schedule updates and progress meeting",  // null if not stated
      "billable": null,                    // true/false only if explicitly stated
      "charge_code_hint": null             // e.g. "as scheduler", only if stated
    }
  ],
  "reply": "Got it — one entry to review."
}

// tool: reply_only        (questions, chit-chat, "what did I log this week")
{ "reply": "...", "intent": "question" | "week_summary" | "undo" | "smalltalk" }
```

The model never sees the project index in full and never decides the final project id.

### 4.2 Resolve (deterministic)

For each `DraftEntry`, in order:

1. **Date.** Parse `date_expression` in the user's timezone with an explicit resolver
   (`today`, `yesterday`, weekday names → most recent past occurrence, `dd/mm`, `mm-dd`, ISO,
   "last Friday"). Ambiguous or future → unresolved slot. Store as ISO `YYYY-MM-DD`, format
   as `MM-DD-YYYY` at the API boundary.
2. **Hours.** Accept decimal (`7.5`), `h:mm` (`7:30`), `7h30`. Round to the nearest 0.25.
   Reject `< 0.25` or `> 24`. Missing → unresolved slot.
3. **Project.** Score `project_query` against `ProjectIndex` over project name, account name,
   deal name and aliases (normalised: lowercase, strip punctuation, strip the "STE-" style id
   prefix). Score = best token/trigram similarity + recency boost.
   - one candidate ≥ 0.85 and next-best gap ≥ 0.15 → resolved
   - otherwise take the top 4 above 0.45 → unresolved slot with chips
   - nothing above 0.45 → live search fallback (CRM Accounts by name → Deals → projects by
     `crm_deal_id`; Zoho Projects project search by name). Still nothing → tell the user, and
     offer their 5 most recent projects as chips.
4. **Task / charge code.** PCCR chain (see decision above). One match → resolved. Several →
   chips labelled with the labour category, never the rate. None → blocked entry with an
   explanatory message.
5. **Description.** Present, trimmed, ≥ 5 characters and not a single filler word
   (`work`, `stuff`, `misc`, `n/a`) → resolved. Otherwise unresolved slot; the bot asks.
6. **Billable.** Explicit statement wins; otherwise the configured default
   (`DEFAULT_BILL_STATUS`, open question #5).

### 4.3 Clarify

Unresolved slots are asked **one at a time, entry by entry**, most-blocking first (project →
task → date → hours → description). Each question carries chips where a finite candidate set
exists, plus a free-text fallback. Answers are applied to the stored `Draft`, then resolution
re-runs.

### 4.4 Confirm

When every entry is fully resolved, render the confirmation card. Warnings shown inline on
the affected line:

| Warning | Condition |
|---|---|
| Daily cap | user's total for that date (existing Zoho logs + this draft) > `DAILY_HOUR_CAP` |
| Possible duplicate | an existing log for the same user/project/task/date with ≥ 0.8 description similarity |
| Backdating | `log_date` older than `BACKDATE_WARN_DAYS` |
| Future date | `log_date > today` → **blocked**, not a warning |

### 4.5 Commit

For each entry, in sequence: write `CommitLog` row (`pending`) → call Zoho → update row
(`success` + `zoho_log_id`, or `failed` + error). Partial failure is reported per line with a
**Retry failed** chip that reuses the same idempotency keys. Nothing is rolled back
automatically.

---

## 5. External API contracts

### Zoho Projects (portal `911636649`, base `https://projectsapi.zoho.com/restapi/portal/911636649/`)

Reads use the vault service credential; writes use the signed-in user's token (see §2).
Zoho API domain for CRM/Books calls: `https://www.zohoapis.com` (US DC).

| Purpose | Call | Credential |
|---|---|---|
| Create time log | `POST projects/{projectId}/tasks/{taskId}/logs/` — `date` (`MM-DD-YYYY`), `hours` (`hh:mm`), `bill_status` (`Billable`/`Non Billable`), `notes` | user |
| Delete time log (undo) | `DELETE projects/{projectId}/tasks/{taskId}/logs/{logId}/` | user |
| My logs for a range | `GET logs?users_list={userId}&view_type=custom_date&custom_date={start_date:MM-DD-YYYY,end_date:MM-DD-YYYY}&bill_status=all&component_type=task` | service |
| Projects | `GET projects/` (paged, `index`/`range`) | service |
| Tasks in a project | `GET projects/{projectId}/tasks/` (paged) | service |
| Portal users | `GET users/` — needed for the email → user id mapping; verify scope (task 0.2) | service |

> **Spike first (task 1.4):** whether a log can be created with an owner other than the token
> holder (decides the auth path — see §2), and whether API-created logs trigger the
> `stampRoleOnTimelog` workflow. If they do not, `billing_role` must be written by this app
> after creation, and that becomes a new task.

### Zoho CRM (v8)

| Purpose | Call |
|---|---|
| Find account | `GET /crm/v8/Accounts/search?word={q}` |
| Deals for account | `GET /crm/v8/Deals/search?criteria=(Account_Name:equals:{id})` |
| Charge code row | `GET /crm/v8/Project_Charge_Code_Rates/search?criteria=((Deal:equals:{dealId})and(Resource:equals:{crmUserId}))` |
| Users | `GET /crm/v8/users?type=ActiveUsers` |

### OpenRouter

`POST https://openrouter.ai/api/v1/chat/completions` — OpenAI-compatible, so any OpenAI SDK
works by swapping `baseURL`. Full request shape in §4.1. Server-side only, key from
`OPENROUTER_API_KEY`.

- **Response handling:** read `choices[0].message.tool_calls[0].function.arguments`, parse,
  validate against the schema with Zod before use. A malformed or absent tool call is a
  failed extraction → degraded mode, never a guess.
- **Accounting:** with `usage.include`, each response carries token counts and cost. Persist
  `generation_id`, model actually served (the `model` field reflects the concrete model), and
  cost against the message row — this is how we answer "what does the bot cost per month".
- **Errors:** 402 (credit exhausted) and 429 are distinct failure modes from a model error —
  402 must alert operations, not just degrade silently for the user.
- **Verify at build time (task 4.1):** confirm the current slug and that ZDR endpoints are
  available for it; treat ZDR as a routing constraint to be checked, not a property of the
  model slug. If `zdr: true` leaves no eligible endpoint, escalate before shipping rather
  than dropping the flag.

### Internal API (browser ↔ server)

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/login` | GET | redirect to Zoho authorize |
| `/api/auth/callback` | GET | code exchange, user upsert, session cookie |
| `/api/auth/logout` | POST | revoke session |
| `/api/me` | GET | current user, timezone, recent projects |
| `/api/chat` | POST | `{ message }` → `{ reply, ui }` |
| `/api/chat/action` | POST | `{ draftId, slot, value }` → `{ reply, ui }` (chip tap) |
| `/api/drafts/{id}/confirm` | POST | commit; returns per-entry result |
| `/api/drafts/{id}/cancel` | POST | discard |
| `/api/entries/week` | GET | this week's logs + total |
| `/api/entries/{commitLogId}/undo` | POST | delete in Zoho, mark `undone` |

All routes except `/api/auth/*` require a valid session and are rate-limited per user
(`/api/chat`: 30/min).

---

## 6. Files / modules to create

```
app/
  (auth)/login/page.tsx                 — single "Sign in with Zoho" screen           NEW
  (app)/page.tsx                        — chat surface                                NEW
  (app)/week/page.tsx                   — this week's entries                         NEW
  api/auth/[...]/route.ts               — login, callback, logout                     NEW
  api/chat/route.ts                     — extract → resolve → respond                 NEW
  api/chat/action/route.ts              — chip taps                                   NEW
  api/drafts/[id]/confirm/route.ts      — commit pipeline                             NEW
  api/entries/week/route.ts             — week read-back                              NEW
  api/entries/[id]/undo/route.ts        — undo                                        NEW
  manifest.ts                           — PWA manifest                                NEW
components/
  chat/{MessageList,Composer,Chips,ConfirmationCard,EntryLine,WeekSummary}.tsx        NEW
lib/
  auth/{zohoOAuth,session,crypto}.ts    — code exchange, cookie, token encryption     NEW
  zoho/{projects,crm,client,rateLimit}.ts — typed Zoho clients + retry/backoff        NEW
  llm/{openrouter,extract,prompt,tools}.ts — gateway client, tool schemas, Zod parse  NEW
  resolve/{date,hours,project,task,description,validate}.ts — deterministic resolvers NEW
  index/{build,match}.ts                — project index build + matcher               NEW
  commit/{commit,idempotency,undo}.ts   — write pipeline                              NEW
prisma/schema.prisma                                                                   NEW
public/{icon-192,icon-512,icon-maskable}.png, sw.js                                    NEW
tests/…                                                                                NEW
```

---

## 7. Configuration (environment variables — names only, never values)

```
DATABASE_URL
OPENROUTER_API_KEY
OPENROUTER_MODEL                # anthropic/claude-sonnet-5
OPENROUTER_FALLBACK_MODELS      # comma-separated, e.g. anthropic/claude-sonnet-4.5
OPENROUTER_SITE_URL             # sent as HTTP-Referer for attribution
OPENROUTER_APP_TITLE            # sent as X-Title
ZOHO_CLIENT_ID                  # reuse the existing Stelic OAuth client
ZOHO_CLIENT_SECRET
ZOHO_REDIRECT_URI               # added to the existing client, not a new registration
ZOHO_ACCOUNTS_DOMAIN            # https://accounts.zoho.com
ZOHO_API_DOMAIN                 # https://www.zohoapis.com  (US DC)
ZOHO_PORTAL_ID                  # 911636649
ZOHO_SERVICE_REFRESH_TOKEN      # the vault TRNSF-600 token — reads only
VAULT_URL                       # credential vault webhook, source of the above at deploy time
VAULT_EPIC_KEY                  # TRNSF-600
TOKEN_ENCRYPTION_KEY            # 32-byte key, AES-256-GCM
SESSION_COOKIE_NAME
SESSION_MAX_AGE_DAYS            # default 30, sliding
DAILY_HOUR_CAP                  # open question #4
BACKDATE_WARN_DAYS              # open question #6
DEFAULT_BILL_STATUS             # open question #5
DEFAULT_TIMEZONE                # America/New_York
```

**The vault is the source, the environment is the interface.** Credentials are resolved from
the credential vault (`TRNSF-600`) **at deploy time** and injected as Railway environment
variables. The running application reads credentials only from its environment — it does not
call `VAULT_URL` on the hot path, at boot, or on token refresh. `VAULT_URL` and
`VAULT_EPIC_KEY` exist for the deploy-time fetch and for the operational runbook (task 11.2),
not for runtime resolution. Where §2 says the app "reads the credential from the vault", read
it as *the deploy pipeline does* — there is one runtime source of truth, and it is
`ZOHO_SERVICE_REFRESH_TOKEN`.

Config is validated at boot and the process fails fast on a missing or malformed variable
(task 1.6). No credential is committed to the repository. The existing Stelic service refresh
token **is** reused — for reads only — and the existing OAuth client is extended with a
redirect URI rather than replaced. Per-user refresh tokens are separate, encrypted, and never
leave the server.

---

## 8. Security & operational notes

- Session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, sliding 30-day expiry, revocable
  server-side. Refresh tokens encrypted at rest (AES-256-GCM).
- The client never receives a Zoho id it did not first get from the server, and
  `/api/drafts/{id}/confirm` re-reads the draft server-side — the browser cannot alter hours,
  project or owner at confirmation time.
- Zoho 401 → one silent token refresh, then re-auth prompt. Zoho 429 → exponential backoff
  with jitter; user sees "Zoho is busy, retrying".
- Model gateway failure (OpenRouter unreachable, no eligible endpoint, malformed tool call)
  → the pipeline degrades to a guided form ("Which project? / Which date? / How many hours? /
  What did you do?") rather than failing the message outright. A 402 also raises an
  operational alert.
- Requests to the gateway carry the user's own words plus their recent project names, and
  nothing else — no email, no Zoho id, no rate, no token. Routing is pinned to
  `data_collection: "deny"` and `zdr: true`, and the app fails closed rather than relaxing
  either flag.
- Structured logs with a request id on every route; no message content in third-party log
  sinks.
- Every committed entry is traceable from the Zoho log id back to the exact user sentence via
  `CommitLog.source_message_id`.
