# Spec: Authentication, session and identity mapping

> Behaviour contract. Implementation detail lives in `../../design.md` §2, §3, §8.
> Tasks: group 2 (and 0.2, 0.3, 1.4 as prerequisites).

A user is a Stelic person who signs in with their own Zoho account. The app never holds a
Stelic password. The signed-in identity must resolve to a **Zoho Projects portal user** on
portal `911636649`, because that portal user is the owner of every time log the app creates.

> **Gated on spike 1.4.** If the spike shows a portal-admin token *can* create a log owned by
> another user, requirements AUTH-2 (per-user token) and AUTH-8 (write credential) may be
> relaxed to an app-managed identity. Everything else in this spec stands either way. Do not
> implement against the relaxed reading until 1.4 has an answer recorded in `design.md §5`.

---

## ADDED Requirements

### Requirement: AUTH-1 — Sign in with Zoho is the only login path

The login screen SHALL offer exactly one authentication action, *Sign in with Zoho*. It SHALL
NOT contain a password field, a username field, or a registration link. Authentication SHALL
use the OAuth 2.0 authorization code flow with PKCE and an anti-CSRF `state` parameter,
against the **existing** Stelic OAuth client (`design.md §2`), with this app's redirect URI
added to it.

#### Scenario: First-time sign in

- **GIVEN** a Stelic consultant with a Zoho account and portal membership
- **AND** they have never used the app
- **WHEN** they open the app and tap *Sign in with Zoho*
- **THEN** the browser is redirected to Zoho's own hosted login page
- **AND** the authorize URL carries `state`, `code_challenge` (S256), the configured
  `client_id`, the configured `redirect_uri`, and `access_type=offline`
- **AND** after they authenticate at Zoho they return to the app already signed in, on the
  chat screen

#### Scenario: No password is ever handled by the app

- **WHEN** any page of the app is rendered
- **THEN** no input of `type="password"` exists anywhere in the app
- **AND** no route accepts a password field in its request body

#### Scenario: State mismatch is rejected

- **GIVEN** a callback request whose `state` does not match the value issued for that browser
- **WHEN** `/api/auth/callback` handles it
- **THEN** no code exchange is attempted
- **AND** no session is issued
- **AND** the user sees "That sign-in link is no longer valid. Please try again." with a
  retry action

#### Scenario: Replayed authorization code

- **GIVEN** an authorization code that has already been exchanged
- **WHEN** the same callback URL is requested a second time
- **THEN** the exchange fails, no second session is issued, and the failure is logged with a
  request id

---

### Requirement: AUTH-2 — Per-user tokens are stored encrypted, never in the browser

The app SHALL exchange the authorization code for an access token and a refresh token, and
SHALL store both encrypted at rest with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`. No Zoho
token, client secret, or refresh token SHALL be sent to the browser, embedded in the client
bundle, or written to `localStorage`, `sessionStorage`, or IndexedDB.

#### Scenario: Tokens at rest

- **WHEN** a user completes sign-in
- **THEN** `OAuthToken.refresh_token_encrypted` and `OAuthToken.access_token_encrypted` are
  ciphertext, each with its own IV and auth tag
- **AND** reading the row without `TOKEN_ENCRYPTION_KEY` yields no usable token

#### Scenario: Nothing leaks to the client

- **WHEN** the production bundle is built and the app is loaded
- **THEN** no Zoho token, `ZOHO_CLIENT_SECRET`, `OPENROUTER_API_KEY`, or
  `ZOHO_SERVICE_REFRESH_TOKEN` value appears in any client-served asset or any API response

---

### Requirement: AUTH-3 — Identity maps to a Zoho Projects portal user

On every login the app SHALL establish, **from the signed-in user's own token**, that they are
a member of `ZOHO_PORTAL_ID`, and SHALL store their zuid as `zoho_projects_user_id` on the
`User` row. It SHALL also store their email, which is the join key across CRM, Projects and
Books in this estate; matching SHALL be case-insensitive and whitespace-trimmed.

> **Resolved by task 0.2 and spike 1.4.** This requirement originally specified an email →
> portal-user lookup on the **service** credential. That is not possible: both
> `GET /portal/{id}/users/` and `GET /projects/{id}/users/` return
> `403 {"code":6403,"message":"Invalid OAuth scope."}`, and no project-scoped workaround
> exists. It is also no longer needed. `GET /restapi/portals/` works on an ordinary user
> token and returns `login_id` — the caller's zuid — alongside the portals they belong to, so
> the signed-in user self-identifies and membership is proven by the same call. Spike 1.4
> confirmed the zuid is exactly what the time-log `owner` parameter takes. Email and display
> name come from `GET /oauth/user/info` on the accounts server, which the portals endpoint
> does not carry.

#### Scenario: Valid Zoho account without portal membership

- **GIVEN** a person with a valid Zoho account on the Stelic org
- **AND** that email is not a user on portal `911636649`
- **WHEN** they complete the Zoho OAuth flow
- **THEN** no session cookie is issued
- **AND** they see "Your Zoho account isn't a member of the Stelic Projects portal, so time
  logs can't be created for you. Ask your PM to add you, then sign in again."
- **AND** the failure is logged server-side with the email and a request id

#### Scenario: Portal user found

- **GIVEN** the signed-in user's own token lists `ZOHO_PORTAL_ID` among their portals
- **WHEN** the callback completes
- **THEN** `User.zoho_projects_user_id` is set to their zuid (`login_id`)
- **AND** `User.email` and `User.display_name` are taken from the Zoho profile
- **AND** the session is issued

#### Scenario: Portal lookup is unavailable

- **GIVEN** `GET /restapi/portals/` or `GET /oauth/user/info` fails, or answers something the
  app cannot read
- **WHEN** a user attempts to sign in
- **THEN** no session is issued
- **AND** the user sees "Sign-in is temporarily unavailable. This has been reported." rather
  than a scope or token error
- **AND** an operational alert is raised — this is a configuration fault, not a user fault

#### Scenario: Membership is never assumed

- **GIVEN** the portals response is unreadable, so membership can be neither confirmed nor
  denied
- **THEN** the app SHALL fail closed and issue no session
- **AND** it SHALL NOT fall back to treating an unreadable answer as membership

#### Scenario: A person whose Zoho email changed

- **GIVEN** an existing `User` row created under a previous email address
- **WHEN** that person signs in and Zoho reports a new email for the same zuid
- **THEN** the existing row is updated with the new address
- **AND** no second `User` row is created, so their history stays attached to them

---

### Requirement: AUTH-4 — CRM user mapping is resolved but not required

The app SHALL also resolve the signed-in email to a Zoho CRM user id and store it as
`User.crm_user_id`. The CRM id is used only for charge-code resolution
(`Project_Charge_Code_Rates.Resource`). Its absence SHALL NOT block sign-in.

#### Scenario: CRM user present

- **WHEN** the email matches an active CRM user
- **THEN** `crm_user_id` is stored and charge-code resolution can run

#### Scenario: CRM user absent

- **GIVEN** the email matches no active CRM user
- **WHEN** sign-in completes
- **THEN** the session is issued normally
- **AND** `crm_user_id` is null and the user is flagged as having no CRM mapping
- **AND** when that user later needs a charge code, the bot asks them to pick a task with
  chips instead of failing, and never shows a rate

---

### Requirement: AUTH-5 — Session survives days of inactivity

The session SHALL be carried in a cookie named `SESSION_COOKIE_NAME` with `HttpOnly`,
`Secure`, `SameSite=Lax` and `Path=/`. Expiry SHALL be sliding, `SESSION_MAX_AGE_DAYS`
(default 30) from last use. The cookie value SHALL be an opaque session id, never a token and
never a serialised user object. Sessions SHALL be revocable server-side.

#### Scenario: Return after a week

- **GIVEN** a user signed in eight days ago and last used the app six days ago
- **AND** `SESSION_MAX_AGE_DAYS` is 30
- **WHEN** they open the installed app
- **THEN** they land on the chat screen without re-authenticating
- **AND** `Session.last_used_at` and `expires_at` are pushed forward

#### Scenario: Session past its expiry

- **GIVEN** a session whose `expires_at` is in the past
- **WHEN** any request presents it
- **THEN** it is treated as absent, the cookie is cleared, and the user is sent to the login
  screen

#### Scenario: Cookie attributes

- **WHEN** the session cookie is set
- **THEN** it carries `HttpOnly`, `Secure` and `SameSite=Lax`
- **AND** it is not readable from `document.cookie`

#### Scenario: Multiple devices

- **GIVEN** a user signed in on a phone and on a desktop browser
- **WHEN** they sign out on the phone
- **THEN** only the phone session is revoked and the desktop session continues to work

---

### Requirement: AUTH-6 — Access tokens refresh silently; refresh failure forces re-login

Before any Zoho call on the user credential, the app SHALL use the stored access token if it
is unexpired, and otherwise refresh it with the stored refresh token. A Zoho `401` on a call
SHALL trigger exactly one refresh-and-retry. If the refresh itself fails (revoked consent,
disabled user, invalid grant), the session SHALL be revoked and the user sent to re-login.

#### Scenario: Expired access token

- **GIVEN** a valid session whose Zoho access token expired 10 minutes ago
- **WHEN** the user sends a message that requires a Zoho call
- **THEN** the token is refreshed transparently and the request succeeds
- **AND** the user sees no interruption

#### Scenario: Consent revoked in Zoho

- **GIVEN** the user revoked the app's access from their Zoho account
- **WHEN** the app attempts a refresh
- **THEN** the refresh fails, the session is revoked, `OAuthToken` is cleared
- **AND** the user sees "Your Zoho access needs to be renewed. Please sign in again." with a
  sign-in action

#### Scenario: Zoho user disabled (offboarding)

- **GIVEN** a Stelic person whose Zoho user has been disabled
- **WHEN** they open the app with an unexpired session cookie and act
- **THEN** the next Zoho call fails, the refresh fails, and the session is revoked
- **AND** no time log can be created after that point

---

### Requirement: AUTH-7 — Unauthenticated access is refused consistently

Every route except `/api/auth/*` and the login page SHALL require a valid session. API routes
SHALL answer `401` with a JSON body; page routes SHALL redirect to the login screen.

#### Scenario: Unauthenticated API call

- **WHEN** `POST /api/chat` is called with no session cookie
- **THEN** the response is `401` with `{ "error": "unauthenticated" }`
- **AND** no LLM call and no Zoho call is made

#### Scenario: Unauthenticated page load

- **WHEN** an unauthenticated browser requests `/` or `/week`
- **THEN** it is redirected to the login screen

#### Scenario: Session belonging to another user cannot be forged

- **GIVEN** an attacker supplies a syntactically valid but unknown session id
- **WHEN** it is presented
- **THEN** it is treated as unauthenticated, and the attempt is logged with a request id

---

### Requirement: AUTH-8 — Writes use the signed-in user's own credential

Creating and deleting a time log SHALL use the signed-in user's own Zoho token, so that the
log's owner is the person the hours belong to. Reads (project list, tasks, portal users, CRM
Accounts/Deals/PCCR, existing logs) SHALL use the service credential from the vault
(`TRNSF-600`). The app SHALL NOT create a time log on behalf of a user who has no usable user
token.

#### Scenario: Log ownership

- **GIVEN** a signed-in user commits an entry
- **WHEN** the log is created in Zoho Projects
- **THEN** its owner in the Zoho Projects UI is that user, not a service account
- **AND** the log is indistinguishable from one created in the Zoho UI, including
  `billing_role` (verified by task 10.5)

#### Scenario: Reads work before a user has ever signed in

- **GIVEN** the project index build job runs
- **WHEN** it fetches projects, tasks and CRM data
- **THEN** it uses the service credential and requires no user session

#### Scenario: Sign out

- **WHEN** the user activates *Sign out*
- **THEN** `POST /api/auth/logout` revokes the session, clears the cookie, and returns them to
  the login screen
- **AND** the stored refresh token for that user is retained only if another active session
  exists for them; otherwise it is cleared
