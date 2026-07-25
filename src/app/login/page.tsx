import { AUTH_MESSAGES, type AuthErrorReason } from '@/lib/auth/messages'
import { safeReturnTo } from '@/lib/auth/oauth-state'

/**
 * The login screen (task 2.10, AUTH-1).
 *
 * Exactly one action. No password field, no username field, no registration link — Stelic
 * manages people in the Zoho One console and nowhere else, which is the whole point of
 * signing in with Zoho.
 */

export const metadata = {
  title: 'Sign in · Stelic Assistant',
}

function messageFor(reason: string | undefined): string | null {
  if (!reason) return null
  return reason in AUTH_MESSAGES ? AUTH_MESSAGES[reason as AuthErrorReason] : null
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value

  const error = messageFor(first(params.error))
  const returnTo = safeReturnTo(first(params.returnTo))

  const href =
    returnTo === '/'
      ? '/api/auth/login'
      : `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-8 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Stelic Assistant</h1>
        <p className="text-sm opacity-70">
          Log your time by chatting. Sign in with the same Zoho account you use for
          Projects.
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {error}
        </p>
      ) : null}

      {/* A plain link, not a form: this is a GET that starts a redirect chain, and it must
          work before any JavaScript has loaded. */}
      <a
        href={href}
        rel="nofollow"
        className="flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-4 text-center text-base font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 dark:bg-white dark:text-neutral-900"
      >
        Sign in with Zoho
      </a>

      <p className="text-xs opacity-60">
        Stelic never sees your Zoho password. Time is logged in Zoho Projects under your
        own name.
      </p>
    </main>
  )
}
