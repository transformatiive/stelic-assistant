/**
 * The service-credential banner (task 0.1).
 *
 * Reads run on a shared credential the app has to hold itself, and there is no way to obtain
 * one except by asking Zoho for it — so this is a real setup step, not an error to hide. It
 * appears only while the credential is missing, and says what it is for rather than just
 * demanding a click.
 */
export function ServiceCredentialBanner({ outcome }: { outcome?: string }) {
  const message = outcome ? OUTCOMES[outcome] : undefined

  return (
    <div className="border-stelic-blue/40 bg-stelic-blue/5 flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Zoho isn’t connected for reading yet</p>
        <p className="text-sm opacity-70">
          The assistant needs its own read access to list your projects and tasks. Your
          own sign-in stays separate — time is still logged under your name.
        </p>
      </div>

      {message ? (
        <p role="alert" className="text-sm opacity-80">
          {message}
        </p>
      ) : null}

      <a
        href="/api/admin/zoho/connect"
        rel="nofollow"
        className="bg-stelic-navy dark:bg-stelic-blue dark:text-stelic-navy flex min-h-11 items-center justify-center self-start rounded-lg px-4 text-sm font-medium text-white transition-opacity hover:opacity-90"
      >
        Connect Zoho
      </a>
    </div>
  )
}

/** Deliberately vague about Zoho internals; specific about what to do next. */
const OUTCOMES: Record<string, string> = {
  stale: 'That took too long. Try again.',
  failed:
    'Zoho refused the connection. Try again, and check the account has portal access.',
  no_refresh_token:
    'Zoho reused an existing grant. Revoke this app under accounts.zoho.com → Security → OAuth Apps, then try again.',
  unauthenticated: 'Sign in again, then connect.',
}
