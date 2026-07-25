# Stelic Timesheet Chatbot — SDD Spec

Spec-Driven Development artifacts for **Chrono** *(working name)* — a conversational
timesheet-entry PWA for Stelic, LLC, backed by Zoho Projects + Zoho CRM.

Generated: 2026-07-25 · Client: Stelic, LLC · Epic: TRNSF-589 · Target agent: Claude Code
Repo: `https://github.com/transformatiive/stelic-assistant` · Model gateway: OpenRouter

---

## What's in here

```
openspec/
├── project.md                                  # Repo conventions + stack for the agent
└── changes/
    └── stelic-timesheet-chatbot/
        ├── proposal.md                         # Why, scope, non-goals, MVP
        ├── design.md                           # Architecture, decisions, data model, API contracts
        ├── tasks.md                            # Implementation checklist (11 groups, ~90 tasks)
        └── specs/
            ├── auth/spec.md                    # Login, session, identity mapping
            ├── timesheet-chat/spec.md          # NLU, resolution, confirmation, commit
            └── pwa-shell/spec.md               # Installability, mobile UX, chat surface
```

## How to use

### 1. Land the spec in the repo

```bash
git clone git@github.com:transformatiive/stelic-assistant.git
cd stelic-assistant
npm install -g @fission-ai/openspec@latest
openspec init
```

Then copy this `openspec/` folder into the repo root, merging with what `init` created, and
commit it before any application code — the spec is the first commit, not an afterthought.

### 2. Start work in Claude Code

Paste this as the first prompt:

```
Read openspec/project.md, then openspec/changes/stelic-timesheet-chatbot/proposal.md,
design.md and the three delta specs under specs/.

Use proposal.md and design.md as context. Before writing any code, confirm that every
requirement in the three spec.md files is covered by a task in tasks.md, and report any gap.

Then implement tasks.md group by group, in order. After each task: mark it complete in
tasks.md, state what changed, and self-check against the relevant Given/When/Then scenario.
Do not skip ahead. Do not implement anything that is not in tasks.md. If a scenario is
ambiguous or a decision in design.md conflicts with reality (API shape, field name), stop
and ask instead of guessing.

Never hardcode credentials. All secrets come from environment variables listed in
design.md §7.
```

### 3. Close out

After implementation run `/opsx:archive` to fold the delta specs into the main specs.

---

## Before the first line of code

**Credentials are already provisioned.** The Stelic Zoho credential lives in the vault under
**`TRNSF-600`** — portal `911636649`, domain `https://www.zohoapis.com`, CRM + Books +
Projects + timesheets scopes. Reuse it for all reads; register nothing new. The existing
OAuth client just needs this app's redirect URI added (task 0.3). Two things to verify: that
the token's scopes cover `GET /portal/{id}/users/` (task 0.2), and the production domain.

**One spike decides the shape of the auth module** (task 1.4): can a portal-admin token
create a time log owned by a *different* user? Zoho's documented parameters say no and their
support position has said no, but that evidence predates the current API and was never tested
against this portal. If it is no, per-user Zoho login is mandatory — the log's owner *is* the
timesheet. If it is yes, the service credential can do the writes and login gets simpler.
Do not build task group 2 before this has an answer.

**Still open:** the daily hour cap (Werner, TRNSF-1249), default billable status, backdating
window.

The model gateway is OpenRouter, pinned to `anthropic/claude-sonnet-5` with
`data_collection: "deny"` and `zdr: true`. Task 4.1 must confirm ZDR endpoints are available
for that slug — if not, escalate rather than dropping the flag. Running cost lands near
$20/month at 30 users, rising to ~$30 when Sonnet 5 pricing changes on 1 September 2026.
