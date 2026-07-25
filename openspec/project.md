# Project: Stelic Assistant (timesheet chatbot)

## Purpose

A conversational, installable web app (PWA) that lets Stelic staff record timesheet entries
in Zoho Projects by chatting, on mobile or desktop, instead of navigating the Zoho Projects
timesheet grid.

## Repository

`https://github.com/transformatiive/stelic-assistant`

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router), TypeScript, React Server Components where sensible |
| Styling | Tailwind CSS + shadcn/ui |
| Data | PostgreSQL (Railway) via Prisma |
| LLM | **OpenRouter** (OpenAI-compatible) → `anthropic/claude-sonnet-5`, server-side only, function calling for extraction |
| Auth | Zoho OAuth 2.0 (authorization code) — see `changes/stelic-timesheet-chatbot/specs/auth/spec.md` |
| Hosting | Railway (same environment family as the existing n8n instance and credential vault) |
| Package manager | npm |
| Tests | Vitest (unit) + Playwright (E2E happy paths) |

## Conventions

- **Server-only integrations.** No Zoho token, OpenRouter key, or client secret ever reaches
  the browser. All third-party calls happen in route handlers or server actions.
- **The model gateway is swappable.** All model traffic goes through one `Extractor`
  interface. No OpenRouter-specific type leaks past `lib/llm/`.
- **Nothing identifying goes into a prompt.** User words and their own project names only —
  no email, no Zoho id, no rate. Routing is pinned to `data_collection: "deny"` and
  `zdr: true`; if that leaves no eligible endpoint, fail closed and escalate.
- **Deterministic where it matters.** The LLM extracts intent only. Project matching, date
  arithmetic, validation, and the write to Zoho are plain TypeScript with unit tests.
- **No `localStorage` for auth.** Session lives in an HTTP-only, `Secure`, `SameSite=Lax`
  cookie. IndexedDB is allowed for non-sensitive UI cache only.
- **Every Zoho write is idempotent** and recorded in the `CommitLog` table before the call
  is made, updated after. See `changes/stelic-timesheet-chatbot/design.md` §3 and §4.5.
- **Errors are user-facing sentences, not stack traces.** Log the detail server-side with a
  request id; show the user what to do next.
- **Timezone:** all user-facing date reasoning happens in the user's IANA timezone (default
  `America/New_York`). Storage is UTC. Zoho Projects expects `MM-DD-YYYY`.
- **Language:** the app UI and bot replies are in **English** (Stelic is US-based). Code
  comments and commits in English.

## Integration surface (do not modify these systems)

- **Zoho Projects** portal `911636649` — read projects/tasks/users (service credential from
  vault `TRNSF-600`), create/delete time logs (user credential).
- **Zoho CRM** — read-only: Accounts, Deals, `Project_Charge_Code_Rates`. Domain
  `https://www.zohoapis.com` (US DC).
- **Credential vault** (`TRNSF-600`) — the single source for Zoho credentials. Never
  hardcode, never register a parallel service credential.
- **Existing automations** — the `stampRoleOnTimelog` workflow (TRNSF-914) fires on time-log
  creation and stamps `billing_role`. This app must not duplicate or bypass it.
- **Existing invoice pipeline** — `invoiced_logs` ledger and the n8n invoice workflow are
  downstream. This app never writes to them.

## Definition of done for any task

1. The relevant Given/When/Then scenario passes manually.
2. Unit tests cover the deterministic logic touched.
3. No new lint errors, no `any` without a comment explaining why.
4. `tasks.md` updated.
