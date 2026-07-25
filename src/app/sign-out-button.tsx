'use client'

import { useState } from 'react'

/**
 * The Sign out control (task 2.9, AUTH-8).
 *
 * A button that POSTs, not a link: sign-out must not be reachable by a prefetch, a crawler or
 * an `<img src>` on someone else's page. On success the browser is sent to the login screen
 * with a full navigation, so nothing stale is left in memory.
 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      // Even if the request failed, the safe destination is the login screen.
      window.location.assign('/login')
    }
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={busy}
      className="min-h-11 rounded-lg px-3 text-sm underline underline-offset-4 opacity-70 hover:opacity-100 disabled:opacity-40"
    >
      {busy ? 'Signing out…' : 'Sign out'}
    </button>
  )
}
