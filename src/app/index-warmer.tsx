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

/**
 * Is the browser-triggered rebuild actually warranted?
 *
 * Only for the gap this component exists for: an index with nothing in it yet. An index that
 * is merely stale by an hour still has projects to match against, and the schedule (task 3.4)
 * catches it within the next few hours regardless — rebuilding it from the browser instead
 * would show every visiting user a multi-minute "Loading your projects from Zoho…" banner for a
 * staleness window that was never actually broken, and turn one slow Zoho walk into as many as
 * there are concurrent tabs.
 */
export function shouldWarm(check: { stale: boolean; projects: number }): boolean {
  return check.stale && check.projects === 0
}

export function IndexWarmer() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  useEffect(() => {
    let cancelled = false

    async function warm() {
      try {
        const check = await fetch('/api/index/refresh', { credentials: 'same-origin' })
        if (!check.ok) return
        const body = (await check.json()) as { stale: boolean; projects: number }
        if (!shouldWarm(body) || cancelled) return

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
