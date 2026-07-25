'use client'

import { useEffect } from 'react'

/**
 * Tells the server which timezone this person is actually in (task 5.10).
 *
 * A timesheet records a day, and Stelic's people are spread across timezones — so "yesterday"
 * has to mean yesterday where they are, not where the app or the portal is configured. Only
 * the browser knows this.
 *
 * Renders nothing and reports only when the value differs from what is stored, so the common
 * case is a single cheap request and someone who travels is picked up on their next visit.
 */
export function TimezoneSync({ stored }: { stored: string }) {
  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!detected || detected === stored) return

    void fetch('/api/me/timezone', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeZone: detected }),
      // Failing is not worth surfacing: the stored zone still works, it is just less right.
    }).catch(() => {})
  }, [stored])

  return null
}
