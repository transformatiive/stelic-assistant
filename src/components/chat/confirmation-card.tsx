import type { CardEntry } from '@/lib/chat/ui'
import { dateDetail, formatDate, formatHours } from '@/lib/chat/format'

/**
 * The card a person checks before anything is written (task 8.7, PWA-5).
 *
 * This is the only screen between a sentence and an invoice line, so every field carries a
 * **visible label**. A dense line like "Clayco · Engineering · 21 Jul · 8h" reads fine to
 * whoever built it and is guesswork to everyone else.
 *
 * No rate, no currency, no budget figure appears here or anywhere else in the app. There is
 * no code path that fetches one.
 *
 * A blocked line is shown, marked, and **excluded from the total** — hiding it would leave
 * someone wondering where their hours went; including it in the total would tell them a
 * number that is not going to be logged.
 */
export function ConfirmationCard({
  entries,
  totalHours,
  today,
  busy,
  settled,
  onConfirm,
  onCancel,
}: {
  entries: readonly CardEntry[]
  totalHours: number
  today?: string
  busy?: boolean
  /** Already confirmed or cancelled: the card stays readable but stops being actionable. */
  settled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const anyReady = entries.some((entry) => entry.state === 'ready')
  const disabled = Boolean(busy || settled || !anyReady)

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border border-stelic-navy/15 bg-white shadow-sm dark:border-white/15 dark:bg-white/5"
      aria-label="Entries to confirm"
    >
      <ul className="divide-y divide-stelic-navy/10 dark:divide-white/10">
        {entries.map((entry) => (
          <EntryLine key={entry.entryId} entry={entry} today={today} />
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stelic-navy/10 bg-stelic-navy/[0.03] px-4 py-3 dark:border-white/10 dark:bg-white/5">
        <p className="text-sm">
          <span className="opacity-70">Total</span>{' '}
          <strong className="text-base">{formatHours(totalHours)}</strong>
        </p>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={Boolean(busy || settled)}
            className="min-h-11 rounded-full px-4 py-2 text-sm font-medium text-stelic-navy underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-45 disabled:hover:no-underline dark:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled}
            // The busy state is the double-tap protection (PWA-5): once tapped, further taps
            // do nothing until the result arrives.
            aria-busy={busy ? true : undefined}
            className="min-h-11 rounded-full bg-stelic-blue px-5 py-2 text-sm font-semibold text-stelic-navy transition-colors hover:bg-stelic-sky focus-visible:ring-2 focus-visible:ring-stelic-navy focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none dark:focus-visible:ring-white"
          >
            {busy ? 'Logging…' : 'Confirm all'}
          </button>
        </div>
      </div>
    </section>
  )
}

function EntryLine({ entry, today }: { entry: CardEntry; today?: string }) {
  const blocked = entry.state === 'blocked'

  return (
    <li className={`px-4 py-3 ${blocked ? 'bg-red-50 dark:bg-red-950/30' : ''}`}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <Field label="Project" value={entry.projectName} />
        <Field
          label="Charge code"
          value={entry.taskName}
          // In words, not a style: this task does not exist in Zoho yet, and confirming is
          // what creates it — the one thing on this card that writes something beyond a log.
          detail={entry.taskIsNew ? 'new — will be added to the project' : undefined}
        />
        <Field
          label="Date"
          value={entry.date ? formatDate(entry.date, today) : null}
          // Both, always: a relative word is what they said, an absolute date is what gets
          // billed, and nobody should have to trust the first one alone.
          detail={
            entry.date && formatDate(entry.date, today) !== dateDetail(entry.date)
              ? dateDetail(entry.date)
              : undefined
          }
        />
        <Field
          label="Hours"
          value={entry.hours === null ? null : formatHours(entry.hours)}
        />
        <Field label="What you did" value={entry.description} />
        <Field label="Billable" value={entry.billable ? 'Yes' : 'No'} />
      </dl>

      {blocked && entry.blocked ? (
        <p className="mt-2 flex gap-2 text-sm font-medium text-red-800 dark:text-red-300">
          {/* A word, not only a colour — colour alone is not a distinction everyone can see. */}
          <span aria-hidden>⛔</span>
          <span>
            <span className="sr-only">Blocked: </span>
            {entry.blocked} It won’t be logged.
          </span>
        </p>
      ) : null}

      {entry.state === 'needs_answer' ? (
        <p className="mt-2 text-sm font-medium opacity-70">Still needs an answer.</p>
      ) : null}

      {entry.warnings.map((warning, i) => (
        <p key={i} className="mt-2 flex gap-2 text-sm text-amber-800 dark:text-amber-300">
          <span aria-hidden>⚠</span>
          <span>
            <span className="sr-only">Warning: </span>
            {warning.message}
          </span>
        </p>
      ))}

      {entry.why.project ? (
        <p className="mt-2 text-xs opacity-60">Picked because it {entry.why.project}.</p>
      ) : null}
    </li>
  )
}

function Field({
  label,
  value,
  detail,
}: {
  label: string
  value: string | null
  detail?: string | undefined
}) {
  return (
    <>
      <dt className="opacity-60">{label}</dt>
      <dd className={value === null ? 'italic opacity-50' : ''}>
        {value ?? 'not set yet'}
        {detail ? <span className="ml-2 text-xs opacity-60">{detail}</span> : null}
      </dd>
    </>
  )
}
