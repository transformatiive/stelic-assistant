# Verification plan

The three spec files carry **112 Given/When/Then scenarios** across 32 requirements. This maps
each requirement to what already proves it and what a human still has to do.

It exists because "every scenario passes manually" (tasks 10.1–10.3) is not a thing anyone can
honestly tick without knowing *which* scenarios a machine already covers. Most do. The ones
that do not are listed at the end, and they are the real remaining work.

**Legend** — 🟢 covered by an automated test · 🔵 covered end-to-end against the live portal
(`npm run e2e`, task 10.4) · 🟠 needs a person

---

## Auth — `specs/auth/spec.md` (26 scenarios)

| Requirement | Status | Where |
|---|---|---|
| AUTH-1 Sign in with Zoho is the only login path | 🟢 | `auth-callback-flow`, `auth-oauth-session` — PKCE, state, one-time code, `stale_link` |
| AUTH-2 Tokens stored encrypted, never in the browser | 🟢 | `auth-crypto-pkce`, `auth-store` — AES-256-GCM, per-value IV; `check-bundle` proves no secret reaches the client |
| AUTH-3 Identity maps to a portal user | 🟢 | `auth-callback-flow`; the scope failure raises the operational alert (`hardening`) |
| AUTH-4 CRM user mapping resolved but not required | 🟢 | `billing-role` — matched on **zuid**, absence tolerated and logged |
| AUTH-5 Session survives days of inactivity | 🟢 | `auth-oauth-session` — 30-day sliding expiry, revocation, threshold |
| AUTH-6 Tokens refresh silently; failure forces re-login | 🟢 | `auth-token-sources`, `zoho-client` — exactly one silent refresh per 401 |
| AUTH-7 Unauthenticated access refused consistently | 🟢 🔵 | `auth-proxy`; the E2E suite confirms an anonymous visitor lands on `/login` |
| AUTH-8 Writes use the signed-in user's own credential | 🟢 | `zoho-timelogs`, `commit-confirm` — the person's token **and** an explicit `owner=<zuid>` |

**Still needs a person:** signing in as somebody who is *not* a portal member, to see the
AUTH-3 refusal text as they would (🟠). Everyone at Stelic has an account, so this needs a
deliberately made test user.

---

## Chat — `specs/timesheet-chat/spec.md` (55 scenarios)

| Requirement | Status | Where |
|---|---|---|
| CHAT-1 One message, several entries | 🟢 | `chat-turn`, `resolve-entry` |
| CHAT-2 Project resolves from client, project or deal name | 🟢 | `index-match` — with a fixture of live name shapes, plus a typo case |
| CHAT-3 Task derived, not asked, where possible | 🟢 | `resolve-entry`, `commit-confirm` — and a project with no charge code does not hold back the rest of the day |
| CHAT-4 A description is mandatory | 🟢 | `resolve-hours-description` — filler words rejected |
| CHAT-5 Dates in the user's timezone; future blocked | 🟢 🔵 | `resolve-date`, `auth-timezone`; the E2E suite confirms a future date is blocked and the button disabled |
| CHAT-6 Hours parsed, rounded, bounded | 🟢 | `resolve-hours-description`, `zoho-timelogs` |
| CHAT-7 Slots asked one at a time, most blocking first | 🟢 | `chat-turn` — one question, not three |
| CHAT-8 Nothing written without a confirmation tap | 🟢 🔵 | `chat-turn` (a turn produces a draft and nothing else), `commit-confirm`; E2E confirms cancelling writes nothing |
| CHAT-9 Warnings on the card, not enforced silently | 🟢 | `resolve-warnings`, `chat-ui-render` — warning and block visually and textually distinct |
| CHAT-10 Commits idempotent, audited, per entry | 🟢 | `commit-pipeline` — double confirm, partial failure, in-flight refusal, unparseable success |
| CHAT-11 Same-day undo of app-created logs | 🟢 🔵 | `commit-undo` — including that `approval_status` is **not** consulted; E2E undoes a real log |
| CHAT-12 "What did I log?" reads the week back | 🟢 🔵 | `entries-week` against a captured live response; E2E reads a real week |
| CHAT-13 Degrades rather than failing; stays in remit | 🟢 | `extract-degraded`, `chat-guards`, `chat-turn` — guided form, and the scope guard |
| CHAT-14 Privacy and rate limiting | 🟢 | `chat-turn` asserts no ids, no email in the prompt; `chat-guards` covers 30/minute |

**Still needs a person:**

- 🟠 **A real conversation.** Every test above uses a stubbed extractor with a fixed answer.
  Whether the *model* reliably returns "clayco" rather than inventing a project name is not
  something a stub can tell you. This is what the pilot (10.8) is for.
- 🟠 **Prompt injection in practice.** The structural guarantee is tested — two tools, whole
  discard, deterministic re-derivation. Whether a determined person can make the *model*
  produce something odd within those bounds is worth an hour of somebody trying.

---

## PWA shell — `specs/pwa-shell/spec.md` (31 scenarios)

| Requirement | Status | Where |
|---|---|---|
| PWA-1 Installable on mobile and desktop | 🟢 🔵 | `pwa-shell` — manifest, three icons, every declared icon actually shipped; verified serving live |
| PWA-2 Service worker caches the shell, never data | 🟢 | `pwa-shell` — the worker is **executed** against a fake `self`, not grepped |
| PWA-3 Works with a mobile keyboard open | 🟠 | Cannot be faked. Needs a real handset |
| PWA-4 Server-driven chips post typed actions | 🟢 | `chat-transcript`, `chat-ui-render`, `chat-turn` — including the stale-option refusal |
| PWA-5 Confirmation card legible and safe to tap | 🟢 | `chat-ui-render` — every field labelled, blocked line excluded from the total, no currency anywhere |
| PWA-6 Result reports per entry, offers retry | 🟢 | `chat-ui-render` |
| PWA-7 Week view | 🟢 🔵 | `entries-week`, `chat-ui-render` |
| PWA-8 Offline and error states explicit | 🟢 | `chat-transcript` — nothing queued, the sentence survives a failed send, no bare status codes |
| PWA-9 Desktop: readable column, Enter to send | 🟠 | The logic is in `composer.tsx`; whether it *feels* right at 1920px is a human judgement |
| PWA-10 Accessible | 🟢 🟠 | Roles, labels and live regions are asserted in `chat-ui-render`; contrast, focus order and a real screen reader need a person |

---

## What actually remains

Nothing on this list can be closed from a terminal.

1. **Install on a real iPhone and a real Android handset** (10.7). Specifically: the composer
   stays above the keyboard, the send button clears the home indicator, and focusing the input
   does not zoom the page. Take the screenshots the user guide is missing while you are there.
2. **Run the E2E suite against production** (10.4 is written, not executed). Needs a live
   `stelic_session` cookie. It writes one 15-minute log and undoes it.
3. **Cross-check five app-created logs against the Zoho UI** (10.5): owner, task, tasklist,
   date, hours, bill status. The owner is the one that matters.
4. **Put one through the invoice pipeline in a test period** (10.6). The app's claim is that an
   API-created log is indistinguishable from a UI one to everything downstream; this is where
   that gets tested rather than asserted.
5. **Pilot with three people for a week** (10.8), and write down every message it got wrong.
   That list is worth more than any of the above — it is the only source of truth about
   whether the matcher and the model are good enough in real hands.
6. **An hour of somebody trying to break it**, especially the description field, which is the
   one piece of user text that reaches a client's invoice.

Two smaller ones a person could do at a desk:

- **Sign in as a non-portal-member** to see the AUTH-3 message (needs a test account).
- **Set a spend limit on the OpenRouter key.** The per-user rate limit bounds a runaway loop
  per user; the account has no ceiling of its own.
