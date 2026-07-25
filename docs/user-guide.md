# Stelic Assistant — how to log your time

Tell it what you did. It writes it into Zoho Projects.

**https://stelic-assistant-production.up.railway.app**

You sign in with your Zoho account. There is no separate password, and nobody has to add you
to anything — if you can open Zoho Projects, you can use this.

---

## Put it on your phone

You do not have to, but it is worth thirty seconds: installed, it opens straight to the chat
with no address bar, like any other app.

**iPhone (Safari — it has to be Safari)**
Open the link → the share button at the bottom → **Add to Home Screen** → **Add**.

**Android (Chrome)**
Open the link → the ⋮ menu → **Install app** (or **Add to home screen**) → **Install**.

**Desktop**
It works in any browser as it is. Chrome and Edge also offer an install icon in the address
bar if you want it in its own window.

---

## Logging time

Type it the way you would say it.

> 8h on Clayco yesterday — structural review

That is a whole entry: project, day, hours, and what you did. It shows you a card, you tap
**Confirm all**, and it is in Zoho.

**Several at once, in one sentence:**

> 6h on Clayco punch list walkthrough, 2h on Turner for the RFI review

**The same work across several days:**

> 3 hours a day on Clayco Monday, Tuesday and Wednesday — commissioning support

**Ways of saying how long** — all of these work: `8h`, `7.5`, `7:30`, `7h30`, `90m`,
`1h 30m`, `half a day`.

**Ways of saying when** — `today`, `yesterday`, `Monday`, `last Tuesday`, `21/07`, `2026-07-21`.

### If it asks you something

It only asks about things it genuinely cannot work out — usually which project you meant, or
what you were doing. Tap one of the options, or just type the answer.

It will not invent anything. If you did not say how long, it asks; it does not guess.

### What it needs from you

**A real description.** It goes on the client's invoice, so `work`, `stuff` and `misc` get
sent back. `Reviewed shop drawings for the east wing` is what a client can read.

**A day that has happened.** Zoho does not accept future time and neither does this.

---

## The other things it does

**"What did I log this week?"** — shows your week, Sunday to Saturday, day by day with
totals. There is also a **My week** button at the top.

**"Undo that"** — removes something it logged, on the same day it logged it. After that, the
correction happens in Zoho Projects, because by then somebody may have looked at it.

---

## What it will not do

It logs time. It cannot tell you your rate, a project budget, an invoice, or approve
anything — it has no access to any of that. Ask your PM, or look in Zoho.

---

## When something goes wrong

**"You're offline."** It needs a connection to write to Zoho. What you typed stays in the
box — send it when you are back. Nothing is queued behind your back.

**It asks about a project that should be obvious.** The project list refreshes four times a
day. A project created in the last few hours may not be there yet. Say more of the name, or
the client's name.

**"That project has no charge codes set up yet."** Nothing to log against — your PM has to
add one in Zoho. The rest of your entries still go through.

**Anything else.** It tells you in a plain sentence and offers to try again. If it keeps
happening, send the message you typed and roughly when, to whoever set this up.

---

## Where your words go

The sentence you type is sent to a language model to be read — with your recent project
*names* for context, and nothing else. No email address, no Zoho id, no rate, no client
identifier beyond what is already in a project's name. The provider is configured not to
store or train on any of it.

The model only reads. Which project, which day, how many hours — every one of those is
decided by the app afterwards, and nothing is written to Zoho until you tap **Confirm**.
