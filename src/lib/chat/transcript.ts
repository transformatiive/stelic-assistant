import type { ChatUi } from './ui'

/**
 * The transcript, as a reducer (task group 8).
 *
 * The interaction rules live here rather than inside a component, because they are rules —
 * "a chip group is dead once answered", "a failed send must not lose what was typed",
 * "the composer is disabled while a turn is in flight" — and a rule you can only exercise
 * through a rendered tree is a rule that quietly stops being tested.
 *
 * The component around this does three things: render, call `fetch`, and dispatch.
 */

export type Bubble = {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Attached to the assistant bubble it arrived with, so it scrolls away with it. */
  ui?: ChatUi
  /**
   * Once answered, a chip group stays visible but stops working (PWA-4).
   *
   * Visible because the transcript should still read as a conversation; dead because tapping
   * a question you already answered is how a draft gets silently rewritten.
   */
  answered?: boolean
}

export type Notice =
  | { kind: 'offline' }
  | { kind: 'error'; message: string; retryable: boolean }
  | { kind: 'signed_out' }

export type TranscriptState = {
  bubbles: Bubble[]
  /** What the composer holds. Survives a failed send — losing it is unforgivable. */
  draftText: string
  /** A turn is in flight: the composer and every action are disabled. */
  busy: boolean
  notice: Notice | null
  /** The week panel, when the bot has offered it. */
  weekOpen: boolean
}

export const initialTranscript: TranscriptState = {
  bubbles: [],
  draftText: '',
  busy: false,
  notice: null,
  weekOpen: false,
}

export type TranscriptAction =
  | { type: 'type'; text: string }
  /** The user pressed send. The text moves into the transcript and out of the composer. */
  | { type: 'send'; id: string; text: string }
  | { type: 'reply'; id: string; text: string; ui?: ChatUi }
  /** A chip was tapped: echo it, and kill the group it came from. */
  | { type: 'tap'; id: string; bubbleId: string; label: string }
  | { type: 'failed'; notice: Notice; restore?: string }
  | { type: 'clearNotice' }
  | { type: 'offline' }
  | { type: 'online' }
  | { type: 'openWeek' }
  | { type: 'closeWeek' }
  /** A card was acted on — confirmed or cancelled — so it must not be actionable again. */
  | { type: 'settle'; bubbleId: string }

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case 'type':
      return { ...state, draftText: action.text }

    case 'send':
      return {
        ...state,
        bubbles: [...state.bubbles, { id: action.id, role: 'user', text: action.text }],
        draftText: '',
        busy: true,
        // A previous failure is not news once they have tried again.
        notice: state.notice?.kind === 'error' ? null : state.notice,
      }

    case 'reply':
      return {
        ...state,
        bubbles: [
          ...state.bubbles,
          {
            id: action.id,
            role: 'assistant',
            text: action.text,
            ...(action.ui ? { ui: action.ui } : {}),
          },
        ],
        busy: false,
        // The bot offering the week is the bot answering a question about it.
        weekOpen: action.ui?.kind === 'week' ? true : state.weekOpen,
      }

    case 'tap':
      return {
        ...state,
        bubbles: [
          ...state.bubbles.map((bubble) =>
            bubble.id === action.bubbleId ? { ...bubble, answered: true } : bubble,
          ),
          { id: action.id, role: 'user', text: action.label },
        ],
        busy: true,
      }

    case 'settle':
      return {
        ...state,
        bubbles: state.bubbles.map((bubble) =>
          bubble.id === action.bubbleId ? { ...bubble, answered: true } : bubble,
        ),
        busy: true,
      }

    case 'failed':
      return {
        ...state,
        busy: false,
        notice: action.notice,
        // Put the words back in the composer. A send that failed must not cost the sentence.
        draftText: action.restore ?? state.draftText,
        bubbles:
          action.restore === undefined
            ? state.bubbles
            : // …and take the optimistic bubble back out, so the transcript does not show a
              // message that was never received.
              state.bubbles.slice(0, -1),
      }

    case 'clearNotice':
      return { ...state, notice: null }

    case 'offline':
      // Never clobbers a signed-out notice: being logged out is the more urgent fact, and it
      // does not resolve itself when the network returns.
      return state.notice?.kind === 'signed_out'
        ? state
        : { ...state, notice: { kind: 'offline' } }

    case 'online':
      // Only the offline notice clears by itself. An error still wants a deliberate retry.
      return state.notice?.kind === 'offline' ? { ...state, notice: null } : state

    case 'openWeek':
      return { ...state, weekOpen: true }

    case 'closeWeek':
      return { ...state, weekOpen: false }
  }
}

/** Can the user send right now? */
export function canSend(state: TranscriptState): boolean {
  if (state.busy) return false
  if (state.notice?.kind === 'signed_out') return false
  return state.draftText.trim().length > 0
}

/**
 * The message a failed request should show.
 *
 * Plain sentences with a next step (PWA-8) — never a status code on its own, never a stack.
 * The server has already logged the detail against a request id; repeating it here would only
 * put something unactionable on a person's screen.
 */
export function noticeForStatus(status: number, serverMessage?: string): Notice {
  if (status === 401) return { kind: 'signed_out' }
  if (status === 429) {
    return {
      kind: 'error',
      message:
        serverMessage ?? 'That’s a lot at once. Give it a few seconds and try again.',
      retryable: true,
    }
  }
  if (status >= 500) {
    return {
      kind: 'error',
      message: 'Something went wrong at our end. Your message is still here — try again.',
      retryable: true,
    }
  }
  return {
    kind: 'error',
    message: serverMessage ?? 'That didn’t work. Try rephrasing it.',
    retryable: false,
  }
}
