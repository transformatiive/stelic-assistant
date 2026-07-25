# Stelic Assistant — timesheet chatbot

Log your time by saying what you did. A conversational timesheet PWA for Stelic, LLC, writing
into Zoho Projects.

> **8h on Clayco yesterday — structural review**

**https://stelic-assistant-production.up.railway.app**

Client: Stelic, LLC · Epic: [TRNSF-589](https://transformatiive.atlassian.net/browse/TRNSF-589) ·
Build ticket: [TRNSF-1321](https://transformatiive.atlassian.net/browse/TRNSF-1321)

| I want to… | Read |
|---|---|
| use it | [`docs/user-guide.md`](docs/user-guide.md) |
| run it, fix it, rotate a credential | [`docs/runbook.md`](docs/runbook.md) |
| understand why it is built this way | [`openspec/…/design.md`](openspec/changes/stelic-timesheet-chatbot/design.md) |
| know what it must do | the three [`spec.md`](openspec/changes/stelic-timesheet-chatbot/specs) files |

---

## The one idea

**The model extracts; deterministic code decides.**

A language model reads the sentence and hands back *phrases* — "clayco", "yesterday", "8h".
Nothing it returns becomes a project, a date or a number of hours: the project comes from a
scoring matcher over an index of the portal, the date from civil-date arithmetic in the
person's own timezone, the hours from a bounds checker. Then a human taps **Confirm** and only
then does anything reach Zoho.

That boundary is why prompt injection is uninteresting here. The widest a crafted message can
get is a draft card that looks wrong to whoever typed it — there are tests for each link in
that chain, including a model insisting it has already logged 100 hours (it produces no draft
at all) and one returning 100 hours (a blocked line, and a total of zero).

## How it hangs together

```
sentence → scope check → OpenRouter (phrases) → resolvers (decisions) → card → Zoho
                ↓                    ↓                     ↓                       ↓
          refuse rates,      no ids, no email,     project index,          owner = the person,
          budgets, approvals  no rates in prompt   civil dates, bounds     idempotency key
```

- **Auth** is Zoho's own login, so Stelic manages people in the Zoho One console and nowhere
  else. Reads use one shared service credential; **writes use each person's own token**,
  because a time log's owner is whose utilisation and invoice line it becomes.
- **The project index** is shared and rebuilt on a schedule four times a day. 145 projects is
  145 Zoho calls, so one copy serves everybody.
- **The commit pipeline** writes its ledger row *before* calling Zoho and updates it after. An
  accepted write whose response cannot be parsed is recorded as a **success** — calling it a
  failure would invite the retry that books the hours twice.

## Layout

```
src/
  app/                 routes and the chat surface
  components/chat/     transcript, chips, confirmation card, week panel
  lib/
    auth/              Zoho OAuth, sessions, per-user timezone
    zoho/              typed clients: projects, tasks, time logs, CRM
    extract/           OpenRouter, tool schemas, degradation
    resolve/           the deterministic half — dates, hours, matching, drafts
    commit/            idempotency, the write pipeline, undo
    chat/              turn orchestration, rate limit, scope guard
    observability/     one logger, one alert channel
docs/                  user guide, runbook
openspec/              proposal, design, specs, task list
e2e/                   Playwright, against a real deployment
```

## Working on it

```bash
npm install
npm run dev

npx tsc --noEmit && npx eslint . && npx vitest run   # 641 tests
npm run build && npm run check:bundle                # …and no secret in the client bundle
```

Environment variables are listed in the [runbook](docs/runbook.md#1-environment-variables).

### Two things this codebase learned the hard way

**Never guess a Zoho shape.** `custom_fields` is not `{label_name, value}` pairs — it is one
single-key object per field, with the label as the key. The wrong assumption matched nothing
and silently cost every project its client name, across all 145, for as long as nobody looked.

**A trailing slash is a contract.** `GET .../logs/` answers `6891 "Given URL is wrong"`;
`GET .../logs` answers `200`. Nine parameter variants were tried against the wrong form and
all nine failed identically, which is precisely what a missing endpoint looks like.

Both were found by probing the live portal. Test fixtures in this repo are captured
responses, not invented ones.

## Status

Built and deployed. What remains is verification that needs real people and real devices —
`tasks.md` group 10 — and the two configuration items in the runbook's
[known gaps](docs/runbook.md#6-known-gaps).
