'use client'

import { useEffect, useState } from 'react'

/**
 * A safety net for the scheduled rebuild (task 3.4).
 *
 * The schedule is what keeps the index current — sessions last thirty days, so a returning
 * user goes straight to the chat and may never trigger a page load that happens to be the
 * first of the hour. This covers the gap before a first scheduled run, and a schedule that
 * has stopped.
 *
 * Runs from the browser rather than the page render: a full rebuild walks every project and
 * its tasks, and blocking first paint on a minute of Zoho calls would make the app feel
 * broken. The `GET` costs no Zoho call, so the common case — a warm index — is one cheap
 * request and nothing is rendered at all.
 */

type Status =
  | { kind: 'idle' }
  | { kind: 'building' }
  | { kind: 'built'; projects: number }
  | { kind: 'failed'; detail: string }

export function IndexWarmer() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false

    async function warm() {
      try {
        const check = await fetch('/api/index/refresh', { credentials: 'same-origin' })
        if (!check.ok) return
        const { stale } = (await check.json()) as { stale: boolean }
        if (!stale || cancelled) return

        setStatus({ kind: 'building' })
        const built = await fetch('/api/index/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        })
        const result = (await built.json()) as {
          ok?: boolean
          written?: number
          detail?: string
        }
        if (cancelled) return

        setStatus(
          result.ok
            ? { kind: 'built', projects: result.written ?? 0 }
            : { kind: 'failed', detail: result.detail ?? 'The rebuild failed.' },
        )
      } catch {
        if (!cancelled)
          setStatus({ kind: 'failed', detail: 'The rebuild could not run.' })
      }
    }

    void warm()
    return () => {
      cancelled = true
    }
  }, [])

  if (status.kind === 'idle') return null

  return (
    <p className="text-sm opacity-70" role="status">
      {status.kind === 'building' && 'Loading your projects from Zoho…'}
      {status.kind === 'built' && `${status.projects} projects ready.`}
      {status.kind === 'failed' && status.detail}
    </p>
  )
}
