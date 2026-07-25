import { describe, expect, it } from 'vitest'
import {
  canSend,
  initialTranscript,
  noticeForStatus,
  pendingQuestion,
  transcriptReducer,
  type TranscriptAction,
  type TranscriptState,
} from '@/lib/chat/transcript'

const run = (actions: TranscriptAction[], from = initialTranscript): TranscriptState =>
  actions.reduce(transcriptReducer, from)

const typed = (text: string): TranscriptAction[] => [{ type: 'type', text }]

describe('sending', () => {
  it('moves the text out of the composer and into the transcript', () => {
    const state = run([
      ...typed('8h clayco'),
      { type: 'send', id: 'b1', text: '8h clayco' },
    ])
    expect(state.draftText).toBe('')
    expect(state.bubbles).toEqual([{ id: 'b1', role: 'user', text: '8h clayco' }])
    expect(state.busy).toBe(true)
  })

  it('disables sending while a turn is in flight', () => {
    const state = run([
      ...typed('8h clayco'),
      { type: 'send', id: 'b1', text: '8h clayco' },
    ])
    expect(canSend({ ...state, draftText: 'more' })).toBe(false)
  })

  it('refuses to send nothing', () => {
    expect(canSend({ ...initialTranscript, draftText: '   ' })).toBe(false)
    expect(canSend({ ...initialTranscript, draftText: 'x' })).toBe(true)
  })

  it('refuses to send once signed out', () => {
    expect(
      canSend({ ...initialTranscript, draftText: 'x', notice: { kind: 'signed_out' } }),
    ).toBe(false)
  })
})

describe('a send that fails', () => {
  // Losing what someone typed is unforgivable — they have to remember it and type it again.
  it('puts the words back in the composer', () => {
    const state = run([
      ...typed('8h clayco'),
      { type: 'send', id: 'b1', text: '8h clayco' },
      {
        type: 'failed',
        notice: { kind: 'error', message: 'nope', retryable: true },
        restore: '8h clayco',
      },
    ])
    expect(state.draftText).toBe('8h clayco')
    expect(state.busy).toBe(false)
  })

  it('takes the optimistic bubble back out, so the transcript is not a lie', () => {
    const state = run([
      { type: 'send', id: 'b1', text: '8h clayco' },
      {
        type: 'failed',
        notice: { kind: 'error', message: 'nope', retryable: true },
        restore: '8h clayco',
      },
    ])
    expect(state.bubbles).toEqual([])
  })

  it('leaves the transcript alone when there is nothing to restore', () => {
    // A failed chip tap, say: the tap is already in the transcript and belongs there.
    const state = run([
      { type: 'send', id: 'b1', text: '8h clayco' },
      { type: 'failed', notice: { kind: 'error', message: 'nope', retryable: true } },
    ])
    expect(state.bubbles).toHaveLength(1)
  })

  it('clears a stale error the moment they try again', () => {
    const state = run([
      { type: 'failed', notice: { kind: 'error', message: 'nope', retryable: true } },
      { type: 'send', id: 'b1', text: 'again' },
    ])
    expect(state.notice).toBeNull()
  })
})

describe('chips', () => {
  const asked: TranscriptState = {
    ...initialTranscript,
    bubbles: [{ id: 'a1', role: 'assistant', text: 'Which day?', ui: { kind: 'week' } }],
  }

  it('echoes the tap so the conversation reads correctly', () => {
    const state = run(
      [{ type: 'tap', id: 'u1', bubbleId: 'a1', label: 'Yesterday' }],
      asked,
    )
    expect(state.bubbles.at(-1)).toEqual({ id: 'u1', role: 'user', text: 'Yesterday' })
  })

  it('kills the group it came from, so an answered question cannot be re-answered', () => {
    const state = run(
      [{ type: 'tap', id: 'u1', bubbleId: 'a1', label: 'Yesterday' }],
      asked,
    )
    expect(state.bubbles[0]!.answered).toBe(true)
  })

  it('leaves the group visible, because the transcript should still read as a conversation', () => {
    const state = run(
      [{ type: 'tap', id: 'u1', bubbleId: 'a1', label: 'Yesterday' }],
      asked,
    )
    expect(state.bubbles[0]!.text).toBe('Which day?')
  })
})

describe('answering a pending question by typing', () => {
  // A slot with no chips — date, hours, description — same as the live field report: "July
  // 25th" was asked about, and the user typed "saturday" instead of tapping anything, because
  // there was nothing to tap.
  const question: TranscriptState = {
    ...initialTranscript,
    bubbles: [
      {
        id: 'a1',
        role: 'assistant',
        text: 'Which day was that?',
        ui: { kind: 'question', draftId: 'd1', entryId: 'e1', slot: 'date', chips: [] },
      },
    ],
  }

  it('finds the pending question from the last bubble', () => {
    expect(pendingQuestion(question)?.id).toBe('a1')
  })

  it('sees nothing pending once the bot has moved on to something else', () => {
    const state = run([{ type: 'reply', id: 'a2', text: 'Got it.' }], question)
    expect(pendingQuestion(state)).toBeNull()
  })

  it('sees nothing pending for a card that is not a question', () => {
    const card: TranscriptState = {
      ...initialTranscript,
      bubbles: [{ id: 'a1', role: 'assistant', text: 'Here', ui: { kind: 'week' } }],
    }
    expect(pendingQuestion(card)).toBeNull()
  })

  it('echoes the typed answer and empties the composer, like an ordinary send', () => {
    const state = run(
      [...typed('saturday'), { type: 'answer', id: 'u1', bubbleId: 'a1', text: 'saturday' }],
      question,
    )
    expect(state.bubbles.at(-1)).toEqual({ id: 'u1', role: 'user', text: 'saturday' })
    expect(state.draftText).toBe('')
    expect(state.busy).toBe(true)
  })

  it('kills the question it answered, same as a chip tap would', () => {
    const state = run([{ type: 'answer', id: 'u1', bubbleId: 'a1', text: 'saturday' }], question)
    expect(state.bubbles[0]!.answered).toBe(true)
  })

  it('clears a stale error the moment they answer, same as an ordinary send', () => {
    const state = run([{ type: 'answer', id: 'u1', bubbleId: 'a1', text: 'saturday' }], {
      ...question,
      notice: { kind: 'error', message: 'nope', retryable: true },
    })
    expect(state.notice).toBeNull()
  })

  it('still recognises the question as pending after a failed retry restores it', () => {
    // The exact sequence behind the field report: the answer fails, `failed` pops the echo
    // bubble back off and puts the question back in last place — with `answered: true` still on
    // it from the `answer` dispatch. Position, not the flag, is what has to say "pending", or a
    // retry would silently start a brand new turn instead of answering the question on screen.
    const state = run(
      [
        { type: 'answer', id: 'u1', bubbleId: 'a1', text: 'saturday' },
        {
          type: 'failed',
          notice: { kind: 'error', message: 'nope', retryable: true },
          restore: 'saturday',
        },
      ],
      question,
    )
    expect(state.bubbles).toHaveLength(1)
    expect(state.bubbles[0]!.answered).toBe(true)
    expect(pendingQuestion(state)?.id).toBe('a1')
  })
})

describe('a card that has been acted on', () => {
  it('stops being actionable', () => {
    const state = run([{ type: 'settle', bubbleId: 'a1' }], {
      ...initialTranscript,
      bubbles: [{ id: 'a1', role: 'assistant', text: 'Here’s what I have.' }],
    })
    expect(state.bubbles[0]!.answered).toBe(true)
    // Busy until the result lands, which is the double-tap protection.
    expect(state.busy).toBe(true)
  })
})

describe('offline', () => {
  it('clears itself when the connection returns', () => {
    const state = run([{ type: 'offline' }, { type: 'online' }])
    expect(state.notice).toBeNull()
  })

  it('does not clear an error, which still wants a deliberate retry', () => {
    const state = run([
      { type: 'failed', notice: { kind: 'error', message: 'nope', retryable: true } },
      { type: 'online' },
    ])
    expect(state.notice).toMatchObject({ kind: 'error' })
  })

  it('never hides a signed-out notice behind an offline one', () => {
    // Being logged out is the more urgent fact, and it does not resolve itself when the
    // network comes back.
    const state = run([
      { type: 'failed', notice: { kind: 'signed_out' } },
      { type: 'offline' },
    ])
    expect(state.notice).toEqual({ kind: 'signed_out' })
  })

  it('does not queue or auto-send anything', () => {
    // PWA-8: offline queueing is explicitly out of scope. The text stays in the composer and
    // the person decides when to send it.
    const state = run([...typed('8h clayco'), { type: 'offline' }])
    expect(state.draftText).toBe('8h clayco')
    expect(state.bubbles).toEqual([])
  })
})

describe('the week panel', () => {
  it('opens when the bot answers a question about the week', () => {
    const state = run([
      { type: 'reply', id: 'a1', text: 'Here it is.', ui: { kind: 'week' } },
    ])
    expect(state.weekOpen).toBe(true)
  })

  it('stays shut for an ordinary reply', () => {
    const state = run([{ type: 'reply', id: 'a1', text: 'Sure.' }])
    expect(state.weekOpen).toBe(false)
  })
})

describe('what a failure says', () => {
  it('sends an expired session to sign in rather than showing an error', () => {
    expect(noticeForStatus(401)).toEqual({ kind: 'signed_out' })
  })

  it('offers a retry on a server error and keeps the message', () => {
    const notice = noticeForStatus(503)
    expect(notice).toMatchObject({ kind: 'error', retryable: true })
    expect(notice.kind === 'error' && notice.message).toContain('still here')
  })

  it('never puts a bare status code in front of a person', () => {
    for (const status of [400, 401, 429, 500, 503]) {
      const notice = noticeForStatus(status)
      if (notice.kind !== 'error') continue
      expect(notice.message).not.toMatch(/\b[45]\d\d\b/)
    }
  })

  it('prefers the server’s own sentence where it wrote one', () => {
    const notice = noticeForStatus(429, 'Give me a few seconds.')
    expect(notice.kind === 'error' && notice.message).toBe('Give me a few seconds.')
  })
})
