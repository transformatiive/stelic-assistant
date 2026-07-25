'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Bubble } from '@/lib/chat/transcript'

/**
 * The transcript (task 8.5, PWA-10).
 *
 * Two behaviours that are easy to get subtly wrong:
 *
 * **Auto-scroll only when already at the bottom.** Yanking someone back down while they are
 * reading history is the single most irritating thing a chat surface can do. When they are
 * scrolled up, a button appears instead and they decide.
 *
 * **A polite live region, and it holds only the newest reply.** Marking the whole transcript
 * `aria-live` re-announces everything on every change. Focus never moves — the composer keeps
 * it, so a screen-reader user can keep typing while the answer is read out.
 */
export function MessageList({
  bubbles,
  busy = false,
  renderUi,
}: {
  bubbles: readonly Bubble[]
  /** A turn is in flight: show the typing indicator so the wait reads as work, not silence. */
  busy?: boolean
  renderUi: (bubble: Bubble) => ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const [pinned, setPinned] = useState(true)

  // Whether the user is at the bottom is a property of the scroll position, not something to
  // track through every interaction — so it is read from the element.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      setPinned(distance < 48)
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    if (!pinned) return
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [bubbles.length, busy, pinned])

  const newest = bubbles.at(-1)

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        className="h-full overflow-y-auto overscroll-contain px-4 py-4"
        // Not a live region itself: that would re-announce the whole history on every change.
        role="log"
        aria-label="Conversation"
      >
        <ul className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {bubbles.map((bubble) => (
            <li
              key={bubble.id}
              className={
                bubble.role === 'user' ? 'flex justify-end' : 'flex justify-start'
              }
            >
              <div
                className={
                  bubble.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-stelic-navy px-4 py-2.5 text-white'
                    : 'w-full max-w-[95%]'
                }
              >
                <p className="whitespace-pre-wrap">{bubble.text}</p>
                {bubble.role === 'assistant' ? renderUi(bubble) : null}
              </div>
            </li>
          ))}
          {busy ? (
            <li className="flex justify-start" data-testid="thinking">
              {/* Feedback that the bot is working (field report, second round): a turn can now
                  take a few seconds — two model calls on a continuation — and a silent screen
                  reads as broken. Dots, not words: no fixed sentence survives every kind of
                  turn (extracting, classifying, matching), and a wrong one is worse than none. */}
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-stelic-navy/10 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/10">
                <span className="sr-only">Thinking…</span>
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    aria-hidden="true"
                    className="size-1.5 animate-bounce rounded-full bg-stelic-navy/50 motion-reduce:animate-none dark:bg-white/60"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </li>
          ) : null}
        </ul>
        <div ref={bottom} />
      </div>

      {/* Only the newest reply, announced politely, with focus left where it was. The busy
          announcement reassures a screen-reader user the same way the dots do a sighted one. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {busy ? 'Thinking…' : newest?.role === 'assistant' ? newest.text : ''}
      </p>

      {!pinned ? (
        <button
          type="button"
          onClick={() => {
            setPinned(true)
            bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
          }}
          className="absolute inset-x-0 bottom-3 mx-auto w-fit rounded-full bg-stelic-navy px-4 py-2 text-sm font-medium text-white shadow-lg focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}
