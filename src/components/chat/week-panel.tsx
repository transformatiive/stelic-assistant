'use client'

import { useEffect, useState } from 'react'
import type { WeekView } from '@/lib/entries/week'
import { formatHours, formatRange, weekdayName } from '@/lib/chat/format'

/**
 * "What did I log this week?" (task 8.9, PWA-7).
 *
 * Every day is listed, including the empty ones — a week that silently omits Thursday reads
 * as "nothing to see", whereas Thursday at `0h` answers the question that was asked.
 *
 * No rate, no currency, no figure beyond hours. Same rule as the confirmation card, and the
 * same reason: there is no code path in this app that fetches one.
 */
export function WeekPanel({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'ready'; week: WeekView } | { status: 'error' }
  >({ status: 'loading' })

  useEffect(() => {
    let live = true
    fetch('/api/entries/week', { headers: { accept: 'application/json' } })
      .then((response) =>
        response.ok ? response.json() : Promise.reject(response.status),
      )
      .then((week: WeekView) => live && setState({ status: 'ready', week }))
      .catch(() => live && setState({ status: 'error' }))
    return () => {
      live = false
    }
  }, [])

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border border-stelic-navy/15 bg-white shadow-sm dark:border-white/15 dark:bg-white/5"
      aria-label="Your week"
    >
      <header className="flex items-center justify-between gap-3 border-b border-stelic-navy/10 px-4 py-3 dark:border-white/10">
        <h2 className="text-sm font-semibold">
          {state.status === 'ready'
            ? formatRange(state.week.weekStart, state.week.weekEnd)
            : 'Your week'}
        </h2>
        <div className="flex items-center gap-3">
          {state.status === 'ready' ? (
            <p className="text-sm">
              <span className="opacity-70">Total</span>{' '}
              <strong>{formatHours(state.week.totalHours)}</strong>
            </p>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-full px-3 text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            Close
          </button>
        </div>
      </header>

      {state.status === 'loading' ? (
        <p className="px-4 py-6 text-sm opacity-70">Reading your week from Zoho…</p>
      ) : null}

      {state.status === 'error' ? (
        <p className="px-4 py-6 text-sm">
          I couldn’t read your week just now. Try again in a moment.
        </p>
      ) : null}

      {state.status === 'ready' ? (
        state.week.totalHours === 0 ? (
          // An empty state that says what to do, not a blank panel (PWA-7).
          <p className="px-4 py-6 text-sm">
            Nothing logged this week yet. Tell me what you worked on — something like “8h
            on Clayco yesterday, structural review” — and I’ll put it in.
          </p>
        ) : (
          <ul className="divide-y divide-stelic-navy/10 dark:divide-white/10">
            {state.week.days.map((day) => (
              <li key={day.date} className="px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold">
                    {weekdayName(day.date)}
                    <span className="ml-2 font-normal opacity-60">{day.date}</span>
                  </h3>
                  <p className="text-sm tabular-nums">
                    {day.hours === 0 ? (
                      <span className="opacity-50">—</span>
                    ) : (
                      formatHours(day.hours)
                    )}
                  </p>
                </div>

                {day.entries.length > 0 ? (
                  <ul className="mt-2 space-y-2">
                    {day.entries.map((entry) => (
                      <li key={entry.logId} className="text-sm">
                        <p className="font-medium">
                          {entry.projectName ?? 'Unnamed project'}
                        </p>
                        <p className="opacity-70">
                          {entry.taskName ?? 'No charge code'} ·{' '}
                          {formatHours(entry.hours)}
                          {entry.billable ? '' : ' · non-billable'}
                        </p>
                        {entry.description ? (
                          <p className="opacity-70">{entry.description}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  )
}
