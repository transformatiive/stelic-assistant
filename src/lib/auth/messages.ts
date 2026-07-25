/**
 * Every sentence the auth flow can show a user (auth spec AUTH-1, AUTH-3, AUTH-6).
 *
 * Kept in one place because these are contract text, quoted verbatim in the spec, and the
 * tests assert on them. A Zoho error code, a scope name or a token must never reach the
 * browser — the user gets a sentence and, where one exists, something to do about it.
 */

export const AUTH_MESSAGES = {
  /** State mismatch, expired state cookie, or a replayed authorization code. */
  stale_link: 'That sign-in link is no longer valid. Please try again.',

  /** A real Zoho account, but not a member of the Stelic Projects portal. */
  not_a_member:
    "Your Zoho account isn't a member of the Stelic Projects portal, so time logs can't be " +
    'created for you. Ask your PM to add you, then sign in again.',

  /** Our fault, not theirs: bad configuration, revoked service credential, Zoho down. */
  unavailable: 'Sign-in is temporarily unavailable. This has been reported.',

  /** The user revoked consent, or was disabled in Zoho. */
  reauthenticate: 'Your Zoho access needs to be renewed. Please sign in again.',
} as const

export type AuthErrorReason = keyof typeof AUTH_MESSAGES

/** Reasons that are our fault. They page someone; the others are ordinary user outcomes. */
export const OPERATIONAL_FAULTS: ReadonlySet<AuthErrorReason> = new Set(['unavailable'])
