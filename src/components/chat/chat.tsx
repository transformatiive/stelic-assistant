'use client'

import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ChatUi, CardEntry, Chip } from '@/lib/chat/ui'
import type { ConfirmResult } from '@/lib/commit/confirm'
import {
  canSend as canSendNow,
  initialTranscript,
  noticeForStatus,
  transcriptReducer,
  type Bubble,
} from '@/lib/chat/transcript'
import { formatHours } from '@/lib/chat/format'
import { Chips } from './chips'
import { Composer } from './composer'
import { ConfirmationCard } from './confirmation-card'
import { MessageList } from './message-list'
import { NoticeBar } from './notice-bar'
import { ResultCard } from './result-card'
import { WeekPanel } from './week-panel'

/**
 * The chat surface (task group 8).
 *
 * This component does three things — render, call `fetch`, dispatch — and holds no rules of
 * its own. Everything that could be called a rule ("a chip group dies once answered", "a
 * failed send must not lose the sentence", "the composer is disabled while a turn is in
 * flight") lives in `lib/chat/transcript.ts`, where it is unit-tested without a DOM.
 *
 * The layout is `100dvh` with a scrolling middle: `dvh` rather than `vh` because on iOS the
 * latter is the height *without* the browser chrome, so a `100vh` column is taller than the
 * screen and the composer sits below the fold with the keyboard closed (PWA-3).
 */
export function Chat({ today }: { today: string }) {
  const [state, dispatch] = useReducer(transcriptReducer, initialTranscript)
  const [results, setResults] = useState<Record<string, ConfirmResult & { ok: true }>>({})
  const lastSent = useRef<string | null>(null)
  const nextId = useRef(0)
  const id = () => `b${nextId.current++}`

  useEffect(() => {
    const online = () => dispatch({ type: 'online' })
    const offline = () => dispatch({ type: 'offline' })
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    if (!navigator.onLine) offline()
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [])

  /**
   * One place where every request's failure is handled the same way.
   *
   * Anything that reaches the network can be offline, rate limited, 5xx or signed out, and
   * four call sites each inventing their own wording is how a user ends up seeing a raw
   * status code on one screen and a friendly sentence on another.
   */
  const post = useCallback(
    async <T,>(url: string, body: unknown, restore?: string): Promise<T | null> => {
      if (!navigator.onLine) {
        dispatch({
          type: 'failed',
          notice: { kind: 'offline' },
          ...(restore !== undefined ? { restore } : {}),
        })
        return null
      }
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}))
          dispatch({
            type: 'failed',
            notice: noticeForStatus(response.status, payload?.message),
            ...(restore !== undefined ? { restore } : {}),
          })
          return null
        }
        return (await response.json()) as T
      } catch {
        dispatch({
          type: 'failed',
          notice: {
            kind: 'error',
            message:
              'I couldn’t reach the server. Your message is still here — try again.',
            retryable: true,
          },
          ...(restore !== undefined ? { restore } : {}),
        })
        return null
      }
    },
    [],
  )

  const send = useCallback(
    async (text: string) => {
      lastSent.current = text
      dispatch({ type: 'send', id: id(), text })
      const result = await post<{ reply: string; ui: ChatUi }>(
        '/api/chat',
        { message: text },
        text,
      )
      if (result) dispatch({ type: 'reply', id: id(), text: result.reply, ui: result.ui })
    },
    [post],
  )

  const confirm = useCallback(
    async (bubble: Bubble, draftId: string) => {
      dispatch({ type: 'settle', bubbleId: bubble.id })
      // No body: the server re-reads the draft and ignores anything a client might send.
      const result = await post<ConfirmResult & { ok: true }>(
        `/api/drafts/${draftId}/confirm`,
        {},
      )
      if (!result) return

      setResults((current) => ({ ...current, [bubble.id]: result }))
      dispatch({ type: 'reply', id: id(), text: summarise(result) })
    },
    [post],
  )

  const cancel = useCallback(
    async (bubble: Bubble, draftId: string) => {
      dispatch({ type: 'settle', bubbleId: bubble.id })
      const result = await post<unknown>(`/api/drafts/${draftId}/cancel`, {})
      if (result) {
        dispatch({ type: 'reply', id: id(), text: 'Dropped it. Nothing was logged.' })
      }
    },
    [post],
  )

  const undo = useCallback(
    async (bubble: Bubble, chip: Chip) => {
      dispatch({
        type: 'tap',
        id: id(),
        bubbleId: bubble.id,
        label: `Undo ${chip.label}`,
      })
      const result = await post<{ ok: true }>(`/api/entries/${chip.value}/undo`, {})
      if (result) {
        dispatch({ type: 'reply', id: id(), text: 'Removed it from Zoho.' })
      }
    },
    [post],
  )

  function renderUi(bubble: Bubble) {
    const ui = bubble.ui
    if (!ui) return null

    if (ui.kind === 'question') {
      // A suggested reply is a shortcut for typing it, so tapping one goes down the exact
      // same path as the composer. Typing and tapping were two code paths before, and the
      // one that mattered less was the one that worked.
      return (
        <Chips
          chips={ui.options.map((option) => ({ value: option, label: option }))}
          {...(bubble.answered ? { answered: true } : {})}
          disabled={state.busy}
          onPick={(chip) => {
            dispatch({ type: 'settle', bubbleId: bubble.id })
            void send(chip.value)
          }}
        />
      )
    }

    if (ui.kind === 'confirmation') {
      const result = results[bubble.id]
      if (result) {
        return (
          <ResultCard
            outcomes={result.outcomes}
            notCommitted={result.notCommitted}
            labels={labelsFor(ui.entries)}
            busy={state.busy}
            onRetry={() => void confirm(bubble, ui.draftId)}
          />
        )
      }
      return (
        <ConfirmationCard
          entries={ui.entries}
          totalHours={ui.totalHours}
          today={today}
          busy={state.busy}
          {...(bubble.answered ? { settled: true } : {})}
          onConfirm={() => void confirm(bubble, ui.draftId)}
          onCancel={() => void cancel(bubble, ui.draftId)}
        />
      )
    }

    if (ui.kind === 'undo') {
      return (
        <Chips
          chips={ui.candidates.map((candidate) => ({
            value: candidate.commitLogId,
            label: `${candidate.projectName} · ${formatHours(candidate.hours)}`,
            hint: candidate.date,
          }))}
          {...(bubble.answered ? { answered: true } : {})}
          disabled={state.busy}
          onPick={(chip) => void undo(bubble, chip)}
        />
      )
    }

    return null
  }

  return (
    // Fills whatever the page gives it — the page owns the `dvh`, this owns the column. The
    // `min-h-0` further in is what lets the transcript shrink instead of pushing the composer
    // off the bottom of the screen.
    <div className="flex h-full flex-col">
      <Header onWeek={() => dispatch({ type: 'openWeek' })} />

      {state.notice ? (
        <NoticeBar
          notice={state.notice}
          onRetry={() => {
            dispatch({ type: 'clearNotice' })
            if (lastSent.current) void send(lastSent.current)
          }}
        />
      ) : null}

      {state.weekOpen ? (
        <div className="mx-auto w-full max-w-2xl px-4">
          <WeekPanel onClose={() => dispatch({ type: 'closeWeek' })} />
        </div>
      ) : null}

      {state.bubbles.length === 0 ? (
        <Empty />
      ) : (
        <MessageList bubbles={state.bubbles} busy={state.busy} renderUi={renderUi} />
      )}

      <Composer
        value={state.draftText}
        disabled={state.busy || state.notice?.kind === 'signed_out'}
        canSend={canSendNow(state)}
        onChange={(text) => dispatch({ type: 'type', text })}
        onSend={() => void send(state.draftText.trim())}
      />
    </div>
  )
}

function Header({ onWeek }: { onWeek: () => void }) {
  return (
    <div className="flex items-center justify-end px-4 py-2">
      <button
        type="button"
        onClick={onWeek}
        className="min-h-11 rounded-full px-3 text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-stelic-blue focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        My week
      </button>
    </div>
  )
}

function Empty() {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col justify-end px-4 pb-4">
      <p className="text-sm opacity-70">
        Tell me what you worked on. Something like{' '}
        <em>“8h on Clayco yesterday, structural review”</em> — or two at once:{' '}
        <em>“6h Clayco punch list, 2h Turner RFI review”</em>.
      </p>
    </div>
  )
}

/** Entry id → something the person recognises on the result card. */
function labelsFor(entries: readonly CardEntry[]): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const entry of entries) {
    const hours = entry.hours === null ? '' : ` · ${formatHours(entry.hours)}`
    labels[entry.entryId] = `${entry.projectName ?? 'Entry'}${hours}`
  }
  return labels
}

function summarise(result: ConfirmResult & { ok: true }): string {
  const logged = result.created + result.duplicates
  if (result.failed === 0 && result.skipped === 0 && result.notCommitted.length === 0) {
    return logged === 1 ? 'Logged it.' : `Logged all ${logged}.`
  }
  if (logged === 0) return 'None of those went through.'
  return `Logged ${logged}. The rest didn’t go through — details below.`
}
