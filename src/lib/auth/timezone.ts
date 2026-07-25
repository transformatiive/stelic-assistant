/**
 * Each person's own timezone (task 5.10, open question 11 — resolved).
 *
 * Stelic's people are in dispersed timezones, and what a timesheet records is a **day**, not
 * an instant. So "yesterday" has to mean yesterday *where the person is*, and a single
 * app-wide setting would be wrong for most of them — logging to the wrong day for anyone
 * typing either side of midnight.
 *
 * The portal's own `America/Los_Angeles` setting is not the answer either: it describes where
 * the portal was configured, not where the person is sitting.
 *
 * So it comes from the browser, which is the only thing that actually knows.
 */

/** Cheap sanity check before storing something a date resolver will trust. */
export function isUsableTimeZone(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string') return false
  const trimmed = candidate.trim()
  // An IANA name, not a UTC offset: an offset is wrong twice a year, which is exactly the
  // class of bug this whole area exists to avoid.
  if (!/^[A-Za-z]+(?:[/_+-][A-Za-z0-9_+-]+)+$/.test(trimmed)) return false

  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: trimmed })
    return true
  } catch {
    // `Intl` rejects a name the runtime does not know, which is the check that matters.
    return false
  }
}

/**
 * Should the stored zone be replaced by what the browser reports?
 *
 * Only when it genuinely differs and the new one is usable. A person travelling is a real
 * case and their days really do shift; a person on a laptop with a broken clock is not worth
 * protecting against, because they would see the wrong date everywhere else too.
 */
export function shouldUpdateTimeZone(stored: string, reported: unknown): boolean {
  if (!isUsableTimeZone(reported)) return false
  return reported.trim() !== stored
}
