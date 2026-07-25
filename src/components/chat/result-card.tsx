import type { EntryOutcome } from '@/lib/commit/commit'
import type { SkippedEntry } from '@/lib/commit/confirm'

/**
 * What happened, per entry (task 8.8, PWA-6).
 *
 * Per entry rather than in aggregate, because "2 of 3 logged" leaves the person to work out
 * which one is missing — and the one that failed is the one they have to do something about.
 *
 * *Retry failed* retries **only** what failed. The idempotency key makes that safe: the
 * entries that succeeded come back as duplicates without a second Zoho call, so a retry can
 * never double-book even if the client sends everything again.
 */
export function ResultCard({
  outcomes,
  notCommitted,
  labels,
  busy,
  onRetry,
}: {
  outcomes: readonly EntryOutcome[]
  notCommitted: readonly SkippedEntry[]
  /** Entry id → something a person recognises, from the card they just confirmed. */
  labels: Record<string, string>
  busy?: boolean
  onRetry: () => void
}) {
  const failed = outcomes.filter(
    (outcome) => outcome.status === 'failed' || outcome.status === 'skipped',
  )
  const logged = outcomes.filter(
    (outcome) => outcome.status === 'created' || outcome.status === 'duplicate',
  )

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border border-stelic-navy/15 bg-white shadow-sm dark:border-white/15 dark:bg-white/5"
      aria-label="What was logged"
    >
      <ul className="divide-y divide-stelic-navy/10 text-sm dark:divide-white/10">
        {outcomes.map((outcome) => (
          <li key={outcome.entryId} className="flex gap-3 px-4 py-3">
            <span aria-hidden>{icon(outcome.status)}</span>
            <div>
              <p className="font-medium">
                <span className="sr-only">{describe(outcome.status)}: </span>
                {labels[outcome.entryId] ?? 'Entry'}
              </p>
              {outcome.status === 'duplicate' ? (
                // Not a failure and not a new log: saying so is better than a bare tick,
                // which would imply it was written twice.
                <p className="opacity-70">Already logged — nothing was duplicated.</p>
              ) : null}
              {outcome.status === 'failed' || outcome.status === 'skipped' ? (
                <p className="text-red-800 dark:text-red-300">{outcome.detail}</p>
              ) : null}
            </div>
          </li>
        ))}

        {notCommitted.map((entry) => (
          <li key={entry.entryId} className="flex gap-3 px-4 py-3">
            <span aria-hidden>⛔</span>
            <div>
              <p className="font-medium">
                <span className="sr-only">Not logged: </span>
                {labels[entry.entryId] ?? 'Entry'}
              </p>
              <p className="opacity-70">
                {entry.reason ?? 'This one still needs an answer, so it wasn’t logged.'}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stelic-navy/10 bg-stelic-navy/[0.03] px-4 py-3 text-sm dark:border-white/10 dark:bg-white/5">
        <p>
          {logged.length} logged
          {failed.length > 0 ? `, ${failed.length} not` : ''}
        </p>
        {failed.length > 0 ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            aria-busy={busy ? true : undefined}
            className="min-h-11 rounded-full bg-stelic-blue px-5 py-2 font-semibold text-stelic-navy transition-colors hover:bg-stelic-sky focus-visible:ring-2 focus-visible:ring-stelic-navy focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-45 motion-reduce:transition-none dark:focus-visible:ring-white"
          >
            {busy ? 'Retrying…' : 'Retry failed'}
          </button>
        ) : null}
      </div>
    </section>
  )
}

function icon(status: EntryOutcome['status']): string {
  if (status === 'created') return '✅'
  if (status === 'duplicate') return '↩︎'
  return '⚠'
}

function describe(status: EntryOutcome['status']): string {
  if (status === 'created') return 'Logged'
  if (status === 'duplicate') return 'Already logged'
  if (status === 'skipped') return 'Not attempted'
  return 'Failed'
}
