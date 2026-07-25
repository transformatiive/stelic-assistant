import type { Notice } from '@/lib/chat/transcript'

/**
 * Offline and error states (task 8.10, PWA-8).
 *
 * A plain sentence with a next step. Never a status code on its own, never a stack, never a
 * silent failure — the server has already logged the detail against a request id, and
 * repeating it here would put something unactionable on a person's screen.
 *
 * `assertive` rather than `polite`: this always interrupts something the person was about to
 * do, and finding out afterwards is worse than being told.
 */
export function NoticeBar({ notice, onRetry }: { notice: Notice; onRetry?: () => void }) {
  if (notice.kind === 'signed_out') {
    return (
      <Bar tone="warning">
        <span>You’ve been signed out. Sign in again to keep logging.</span>
        <a
          href="/login"
          className="min-h-11 shrink-0 self-center rounded-full bg-stelic-navy px-4 py-2 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Sign in
        </a>
      </Bar>
    )
  }

  if (notice.kind === 'offline') {
    return (
      <Bar tone="info">
        {/* No auto-send and no queue: nothing is written without the person acting. */}
        <span>
          You’re offline, so I can’t log anything right now. Your message is safe — send
          it when you’re back.
        </span>
      </Bar>
    )
  }

  return (
    <Bar tone="warning">
      <span>{notice.message}</span>
      {notice.retryable && onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="min-h-11 shrink-0 self-center rounded-full bg-stelic-navy px-4 py-2 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Try again
        </button>
      ) : null}
    </Bar>
  )
}

function Bar({
  tone,
  children,
}: {
  tone: 'info' | 'warning'
  children: React.ReactNode
}) {
  return (
    <div
      role="status"
      aria-live="assertive"
      className={`flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm ${
        tone === 'warning'
          ? 'bg-amber-100 text-amber-950 dark:bg-amber-950/60 dark:text-amber-100'
          : 'bg-stelic-sky/20 text-stelic-navy dark:bg-stelic-sky/15 dark:text-white'
      }`}
    >
      {children}
    </div>
  )
}
