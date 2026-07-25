import type { Chip } from '@/lib/chat/ui'

/**
 * The options a question offers (task 8.6, PWA-4).
 *
 * A chip posts a **typed value** — a project id, a task id — never a synthesised sentence.
 * The label is for the person; the value is for the server, and it is only ever a value the
 * server put there. That is what stops a crafted client logging to a project nobody offered.
 *
 * Disabled once the group is answered rather than removed: the transcript should still read
 * as a conversation, but tapping a question you already answered is how a draft gets silently
 * rewritten.
 */
export function Chips({
  chips,
  answered,
  disabled,
  onPick,
}: {
  chips: readonly Chip[]
  answered?: boolean
  disabled?: boolean
  onPick: (chip: Chip) => void
}) {
  if (chips.length === 0) return null
  const dead = Boolean(answered || disabled)

  return (
    <div
      className="mt-3 flex flex-wrap gap-2"
      role="group"
      aria-label={answered ? 'Options (already answered)' : 'Options'}
    >
      {chips.map((chip) => (
        <button
          key={chip.value}
          type="button"
          disabled={dead}
          onClick={() => onPick(chip)}
          // 44px minimum touch target (PWA-10), and a focus ring that is visible against both
          // themes rather than the browser's default outline on a coloured background.
          className="min-h-11 rounded-full border border-stelic-navy/25 bg-white px-4 py-2 text-left text-sm font-medium text-stelic-navy transition-colors hover:bg-stelic-sky/15 focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-white motion-reduce:transition-none dark:border-white/25 dark:bg-white/10 dark:text-white dark:hover:bg-white/20 dark:disabled:hover:bg-white/10"
        >
          {chip.label}
          {chip.hint ? (
            <span className="ml-2 text-xs font-normal opacity-70">{chip.hint}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
