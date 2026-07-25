'use client'

import { useRef, type KeyboardEvent } from 'react'

/**
 * The composer (tasks 8.4, 8.11, PWA-3, PWA-9).
 *
 * Three constraints that are all invisible until they are wrong:
 *
 * **`text-base` is not a style choice.** iOS Safari zooms the page when a focused input has a
 * font smaller than 16px, and the zoom does not undo itself — the whole layout is left
 * oversized for the rest of the session.
 *
 * **The safe-area inset goes on the composer, not the page.** On a device with a home
 * indicator the send button otherwise sits under it, and the one control that must always be
 * tappable is the one that is not.
 *
 * **Enter sends, Shift+Enter is a newline** (PWA-9) — but only where there is a real keyboard.
 * On a phone, Enter has to insert a newline, because the on-screen return key is the only way
 * to get one and hijacking it would make multi-line entries impossible.
 */
export function Composer({
  value,
  disabled,
  canSend,
  onChange,
  onSend,
}: {
  value: string
  disabled: boolean
  canSend: boolean
  onChange: (text: string) => void
  onSend: () => void
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)

  function grow() {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    // Capped so a long entry does not push the transcript off the screen entirely.
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // `hover: hover` is the closest thing to "has a real keyboard" the platform offers, and
    // it is right far more often than a user-agent sniff.
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return
    event.preventDefault()
    if (canSend) onSend()
  }

  return (
    <form
      className="border-t border-stelic-navy/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-black/40"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (canSend) onSend()
      }}
    >
      <div className="mx-auto flex w-full max-w-2xl items-center gap-2 px-4 py-3">
        <label htmlFor="composer" className="sr-only">
          What did you work on?
        </label>
        <textarea
          id="composer"
          ref={textarea}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value)
            grow()
          }}
          onKeyDown={onKeyDown}
          placeholder="8h on Clayco yesterday, structural review"
          // Dictation arrives here as ordinary text; nothing about it is special to the app,
          // and no audio ever reaches it (PWA-3).
          className="max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-stelic-navy/20 bg-white px-4 py-2.5 text-base leading-6 focus-visible:border-stelic-blue focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:outline-none disabled:opacity-60 dark:border-white/20 dark:bg-white/10"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="min-h-11 min-w-11 rounded-full bg-stelic-blue px-5 font-semibold text-stelic-navy transition-colors hover:bg-stelic-sky focus-visible:ring-2 focus-visible:ring-stelic-navy focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none dark:focus-visible:ring-white"
        >
          Send
        </button>
      </div>
    </form>
  )
}
