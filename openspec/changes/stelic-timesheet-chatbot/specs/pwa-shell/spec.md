# Spec: PWA shell and chat surface

> Behaviour contract. Implementation detail lives in `../../design.md` §1, §2 (chips
> decision), §6. Tasks: group 8.

One codebase, installable on a phone home screen and usable in a desktop browser. The target
is under 15 seconds from opening the icon to a logged day, with near-zero typing.

---

## ADDED Requirements

### Requirement: PWA-1 — The app is installable on mobile and desktop

The app SHALL serve a web app manifest with `display: standalone`, a theme colour, a start
URL, and icons at 192×192, 512×512 and a maskable variant. It SHALL be served over HTTPS from
a stable origin.

#### Scenario: Android install

- **GIVEN** a user opens the app in Chrome on Android over HTTPS
- **WHEN** they use *Add to home screen*
- **THEN** an icon is added
- **AND** launching it opens the app standalone, with no browser address bar

#### Scenario: iOS install

- **GIVEN** a user opens the app in Safari on iOS
- **WHEN** they use *Add to Home Screen*
- **THEN** the correct `apple-touch-icon` and app name are used
- **AND** launching it opens standalone with the configured status-bar style and no visible
  browser chrome

#### Scenario: Desktop browser

- **WHEN** the app is opened in a desktop browser without installing
- **THEN** it is fully usable, with no mobile-only affordance blocking anything

---

### Requirement: PWA-2 — The service worker caches the shell, never data

The service worker SHALL cache the application shell (HTML shell, JS, CSS, icons, fonts) and
SHALL NOT cache any `/api/*` response. A new deployment SHALL be picked up without the user
manually clearing storage.

#### Scenario: API responses are never cached

- **WHEN** any `/api/*` request passes through the service worker
- **THEN** it goes to the network and its response is not stored in the cache

#### Scenario: Shell update

- **GIVEN** a new version is deployed
- **WHEN** the user next opens the installed app
- **THEN** the new shell is fetched and activated, without a manual cache clear

#### Scenario: No credentials in cache

- **WHEN** the caches are inspected after normal use
- **THEN** no session cookie value, token, or message content is present

---

### Requirement: PWA-3 — The chat surface works with a mobile keyboard open

The chat layout SHALL use dynamic viewport height, keep the composer visible above the
on-screen keyboard, respect safe-area insets on notched devices, and use a minimum 16px input
font so iOS does not zoom on focus.

#### Scenario: Keyboard open

- **GIVEN** a phone with the on-screen keyboard open
- **WHEN** the user is typing
- **THEN** the composer and the most recent message are both visible
- **AND** the composer is not hidden behind the keyboard or the home indicator

#### Scenario: No zoom on focus

- **WHEN** the input is focused on iOS
- **THEN** the page does not zoom, because the input font size is at least 16px

#### Scenario: Safe areas

- **WHEN** the app runs standalone on a notched device
- **THEN** no content is obscured by the notch or the home indicator, in either orientation

#### Scenario: Dictation

- **WHEN** the user dictates into the composer using the native keyboard
- **THEN** the text arrives in the input like typed text
- **AND** no audio is uploaded or processed by the app

---

### Requirement: PWA-4 — Server-driven chips render as tappable typed actions

The client SHALL render the `ui` payload returned by the chat API (`chips`,
`confirmation_card`, `entry_list`) and SHALL post a structured action back — never a
synthesised sentence.

#### Scenario: Chips render and post typed values

- **GIVEN** a reply carrying four project chips
- **WHEN** the user taps one
- **THEN** `POST /api/chat/action` is sent with the draft id, the slot and the typed value
- **AND** the tapped chip is echoed into the transcript so the conversation reads correctly

#### Scenario: Stale options

- **GIVEN** the user scrolls back and taps a chip from an earlier question that has already
  been answered, or whose draft has since been cancelled or expired
- **WHEN** the action is posted
- **THEN** the server refuses it
- **AND** the bot replies "That option is no longer available" and re-states the current
  question
- **AND** no slot value is changed and nothing is written to Zoho

#### Scenario: Chips are disabled once answered

- **WHEN** a chip group has been answered
- **THEN** its chips are visually and functionally disabled in the transcript

---

### Requirement: PWA-5 — The confirmation card is legible and safe to tap

The confirmation card SHALL show, per entry: project, task, date, hours, description and
billable status with visible field labels; warnings inline on the affected line; blocked lines
visibly marked and excluded from the total; and a total. Its actions SHALL be disabled while a
commit is in flight.

#### Scenario: Card contents

- **WHEN** a two-entry card is rendered
- **THEN** every field is labelled, both lines are readable without horizontal scrolling on a
  375px-wide screen, and the total is shown

#### Scenario: Double-tap protection

- **WHEN** the user taps *Confirm all*
- **THEN** the button enters a busy state and further taps do nothing until the result arrives

#### Scenario: Warnings and blocks are distinguishable

- **GIVEN** one line has a backdating warning and another is blocked for a future date
- **WHEN** the card is rendered
- **THEN** the two are visually distinct, and only the blocked line is excluded from the total
  and from the commit

#### Scenario: No financial data on the card

- **WHEN** the card is rendered
- **THEN** it shows no rate, currency amount or budget figure anywhere

---

### Requirement: PWA-6 — The result state reports per entry and offers retry

After a commit, the client SHALL show a per-entry result with success or failure, and a
*Retry failed* action when any entry failed.

#### Scenario: All succeeded

- **WHEN** every entry commits
- **THEN** each line shows a success state and the bot confirms the total logged

#### Scenario: Partial failure

- **GIVEN** one of three entries failed
- **WHEN** the result renders
- **THEN** the two successes and the one failure are individually visible with the failure
  reason
- **AND** *Retry failed* retries only the failed entry

---

### Requirement: PWA-7 — A week view shows what has been logged

The app SHALL provide a week screen listing the current week's entries grouped by day, with a
daily and weekly total, reachable from the chat surface.

#### Scenario: Week screen

- **WHEN** the user opens the week screen
- **THEN** entries are grouped by day with per-day and weekly totals
- **AND** each entry shows project, task, hours and description, and no financial figure

#### Scenario: Empty week

- **GIVEN** nothing logged this week
- **WHEN** the screen renders
- **THEN** it shows an empty state that explains how to log something, not a blank page

---

### Requirement: PWA-8 — Offline and error states are explicit

The app requires connectivity to commit. Loss of connectivity and server errors SHALL be
shown as plain sentences with a next step, never as a stack trace, an error code alone, or a
silent failure.

#### Scenario: Offline

- **GIVEN** the device is offline
- **WHEN** the user tries to send a message
- **THEN** the shell still loads from cache
- **AND** the app says it needs a connection to log time, and the message is not lost from the
  composer

#### Scenario: Connectivity returns

- **WHEN** the device comes back online
- **THEN** the offline notice clears and the pending message can be sent by the user
- **AND** nothing is auto-sent or auto-queued without the user acting (offline queueing is out
  of scope)

#### Scenario: Server error

- **GIVEN** an API call returns 5xx
- **WHEN** the client handles it
- **THEN** the user sees a readable sentence with a retry action, and the detail is logged
  server-side against a request id

#### Scenario: Session expired mid-conversation

- **GIVEN** the session has been revoked or has expired
- **WHEN** the user sends a message
- **THEN** they are told they need to sign in again and are taken to the login screen, with no
  half-committed draft left behind

---

### Requirement: PWA-9 — Desktop behaves like a desktop app

On a wide viewport the transcript SHALL be constrained to a readable column. `Enter` SHALL
send and `Shift+Enter` SHALL insert a newline.

#### Scenario: Keyboard

- **WHEN** the user presses `Enter` in the composer on desktop
- **THEN** the message is sent
- **WHEN** they press `Shift+Enter`
- **THEN** a newline is inserted and nothing is sent

#### Scenario: Readable column

- **WHEN** the app is viewed at 1920px wide
- **THEN** the transcript is constrained to a readable measure rather than spanning the full
  width

---

### Requirement: PWA-10 — The chat surface is accessible

New messages SHALL be announced to screen readers. Every interactive element SHALL have an
accessible name, a visible focus indicator, and a touch target of at least 44×44px. Text
contrast SHALL meet WCAG AA. Motion SHALL respect `prefers-reduced-motion`.

#### Scenario: New message announced

- **GIVEN** a screen reader is active
- **WHEN** the assistant replies
- **THEN** the new message is announced via a polite live region, without moving focus away
  from the composer

#### Scenario: Focus order

- **WHEN** the user tabs through a reply carrying chips and then the composer
- **THEN** focus moves in reading order, every stop is visibly indicated, and no focus trap
  exists

#### Scenario: Auto-scroll

- **GIVEN** the user is scrolled to the bottom
- **WHEN** a new message arrives
- **THEN** the transcript scrolls to it
- **GIVEN** the user has scrolled up to read history
- **WHEN** a new message arrives
- **THEN** the view is not yanked; an affordance indicates there is a new message below

#### Scenario: Reduced motion

- **GIVEN** the OS setting prefers reduced motion
- **WHEN** messages appear and chips animate
- **THEN** transitions are reduced or removed
