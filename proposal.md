# Proposal: Stelic Timesheet Chatbot

> **Generated:** 2026-07-25
> **Client:** Stelic, LLC — Zoho One implementation (epic TRNSF-589)
> **Target agent:** Claude Code
> **Repo:** greenfield (new repository), integrating with a live brownfield Zoho estate

---

## Intent

### Problem

Stelic's billing chain starts with a time log. Every invoice line, every budget-vs-actual
figure, and every utilisation number depends on consultants entering hours accurately and on
time. Today that means opening Zoho Projects, finding the right project among ~120, picking
the right task, and filling a grid — on a laptop. Field and site-based staff do not do this
daily; they reconstruct the week on Friday, or later. Late and low-quality time entry delays
invoicing, corrupts capacity planning, and forces PMs to chase people.

The entry *effort* is the bottleneck, not the entry *rules*. Anyone can say "8 hours on
Clayco yesterday, schedule updates and progress meeting" in five seconds. Nobody wants to
navigate three dropdowns to say the same thing.

### Goal

A consultant opens an app icon on their phone, types (or dictates) one sentence, taps
**Confirm**, and the hours are in Zoho Projects against the correct project, task, date and
charge code — with a mandatory task description attached. Time to log a day: under 15
seconds. No Zoho navigation, no training, no VPN, no desktop required.

Success is observable as: (a) time logs created through the app are indistinguishable from
logs created in the Zoho UI, including `billing_role` stamping; (b) median lag between work
date and log date drops; (c) PM chasing of missing timesheets falls.

### Why now

Billing runs on Zoho from mid-July 2026 in parallel with BigTime. Timesheet quality is the
single largest input risk to that parallel run, and the approval workflow (TRNSF-1248) plus
budget-vs-actual reporting both assume complete, timely logs.

---

## Scope

### In scope

- **Installable PWA** — one codebase serving mobile (add-to-home-screen, standalone display)
  and desktop browsers.
- **Authenticated login** with a session that survives days of inactivity without re-login.
- **Identity mapping** from the logged-in email to a Zoho Projects portal user, and to the
  matching Zoho CRM user record used for rate/role resolution.
- **Conversational entry** of one or many time entries from a single message.
- **Project resolution** by client name, project name or deal name, searching Zoho Projects,
  CRM Accounts and CRM Deals, with **button-based disambiguation** when more than one
  candidate matches.
- **Task / charge-code resolution**, automatic where the user's charge code on that project
  is unambiguous, button-based where it is not.
- **Mandatory task description** — the bot refuses to commit an entry without one and asks
  for it.
- **Explicit confirmation step** — a summary card with quick-reply buttons before anything is
  written to Zoho.
- **Multi-entry in one turn** — several projects, dates and durations parsed from one message
  and confirmed together.
- **Validation** — hours bounds, duplicate detection, date sanity, daily-cap warning.
- **Undo** — delete a time log created by the app, same day.
- **"What did I log?"** — read back the current week's entries and weekly total.
- **Audit trail** — every committed entry recorded server-side with the originating message.

### Out of scope (explicit non-goals)

- **Editing or approving existing time logs.** Corrections beyond same-day undo happen in
  Zoho Projects. Approval remains the PM/Zoho workflow (TRNSF-1248).
- **Expenses, mileage, receipts.** Zoho Expense is a separate track.
- **Invoicing, budget or rate display.** The bot never shows a rate, a bill amount, or a
  budget consumption figure to a consultant.
- **Creating or modifying projects, tasks, tasklists, deals or users.** The app is a
  read-and-log client; project structure comes from the Deal-Won automation.
- **Offline entry queueing.** The app requires connectivity to commit. (Candidate for v2.)
- **Push notifications and reminder nudges.** (Candidate for v2.)
- **BigTime writes.** During the parallel run, BigTime entry remains a manual, separate
  process. The app writes only to Zoho.
- **Voice transcription built in-house.** The app relies on the native mobile keyboard's
  dictation; no audio is uploaded or processed by the app.
- **Admin console / user management UI.** Access is governed by Zoho portal membership.
- **Non-Stelic tenants.** Single-tenant by design; multi-tenant is a later commercial
  decision.

### Smallest viable version

A logged-in user sends *"8 hours on Clayco yesterday — schedule updates and progress
meeting"*, sees one disambiguation prompt if needed, sees a confirmation card, taps
**Confirm**, and one time log appears in Zoho Projects on the right task. Single entry, text
only, no undo, no week view. Everything else builds on that loop.

---

## Approach

Next.js PWA on Railway. The browser talks only to our own API. Reads run on the Stelic
service credential already held in the vault (`TRNSF-600`); writes run on the signed-in
user's own Zoho token, so a time log is owned by the person it belongs to. A single model call via OpenRouter per
message extracts structured draft entries via tool use; all matching, date resolution and
validation is deterministic TypeScript against a cached project index. Unresolved slots come
back to the user as tappable chips; a confirmation card gates every write; each write is
idempotent and audited.

Detailed architecture, decisions and API contracts: see `design.md`.

---

## Open questions

| # | Question | Owner | Needed by |
|---|---|---|---|
| 1 | ~~Auth model~~ — now gated on spike 1.4 rather than a decision: if Zoho refuses to create a log owned by another user, per-user OAuth is mandatory. Reads use the existing vault credential either way. | Spike 1.4 | Before task group 2 |
| 2 | Are all timesheet users **licensed Zoho Projects portal users** with a Zoho account on the Stelic org (not just CRM users)? Determines whether OAuth is viable for 100% of staff. | Nuno / Alex | Before task group 2 |
| 3a | Does the vault token's scope set cover `GET /portal/{id}/users/`? The email → portal-user mapping depends on it. | Nuno (task 0.2) | Before task group 2 |
| 3 | **Daily hour cap** value and whether it is a hard block or a soft warning (TRNSF-1249). | Werner | Before go-live |
| 4 | Default **billable status** for chat-created logs — always `Billable` unless the user says otherwise, or inherit from the task? | Werner / Brooke | Before task group 6 |
| 5 | **Backdating window** — how many days back may a consultant log without PM involvement? | Alex | Before go-live |
| 6 | Does the app need to respect the **timesheet approval state** (i.e. refuse to log into a week already submitted/approved)? | Alex | Before task group 6 |
| 7 | ~~OAuth client registration~~ — **resolved**: reuse the existing Stelic server-based client from vault `TRNSF-600`, adding a redirect URI. No new registration. | — | Done |
| 8 | Production **domain** for the PWA (installability and OAuth redirect both depend on a stable HTTPS origin). | Nuno | Before task group 1 |
