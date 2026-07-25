import { NextResponse } from 'next/server'
import { currentRequestId, log, withRequestId } from './log'

/**
 * Wraps a route handler (task 9.1).
 *
 * Two jobs, both of which are the kind of thing that is only ever *nearly* done when it is
 * left to each handler:
 *
 * **A request id for the whole call.** Taken from the incoming header when a proxy set one,
 * so a line here joins to a line in Railway's own log; generated otherwise. Every `log` call
 * anywhere beneath this — several layers down, in code that has never heard of a request —
 * carries it, because it travels in async context rather than in a parameter.
 *
 * **An uncaught error becomes a logged 500 with that id**, rather than Next's default page
 * and no log line at all. The user gets a sentence and an id; the detail stays server-side,
 * which is what PWA-8 asks for.
 */
export function route<A extends unknown[]>(
  handler: (request: Request, ...args: A) => Promise<NextResponse>,
): (request: Request, ...args: A) => Promise<NextResponse> {
  return (request, ...args) =>
    withRequestId(request, async () => {
      try {
        return await handler(request, ...args)
      } catch (error) {
        const requestId = currentRequestId()
        log.error('route.unhandled', {
          path: new URL(request.url).pathname,
          method: request.method,
          // The name, not the message: a message can quote a Zoho body, and a body can carry
          // a client name and a timesheet note.
          error: error instanceof Error ? error.name : 'unknown',
        })
        return NextResponse.json(
          {
            error: 'unexpected',
            message: 'Something went wrong at our end. Try again in a moment.',
            requestId,
          },
          { status: 500 },
        )
      }
    })
}
