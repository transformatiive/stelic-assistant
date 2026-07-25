import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { loadSession } from '@/lib/auth/store'
import { readCookie } from '@/lib/auth/request'
import { StelicMark } from '@/components/stelic-mark'
import { Chat } from '@/components/chat/chat'
import { serviceCredentialState } from '@/lib/auth/service-connect'
import { formatIso, todayIn } from '@/lib/resolve/civil-date'
import { IndexWarmer } from './index-warmer'
import { ServiceCredentialBanner } from './service-credential'
import { SignOutButton } from './sign-out-button'
import { TimezoneSync } from './timezone-sync'

/**
 * The signed-in shell (task group 8).
 *
 * Middleware turns away anyone with no cookie; this page is the authority on whether that
 * cookie names a live session (AUTH-7). Everything below it assumes a real user.
 *
 * The chat fills the viewport rather than sitting in a padded column: on a phone the
 * composer has to be reachable with the keyboard open, which needs the whole height to work
 * with (PWA-3). The header is deliberately small for the same reason.
 */
export const dynamic = 'force-dynamic'

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const config = loadConfig()
  const cookieHeader = (await headers()).get('cookie') ?? ''
  const lookup = await loadSession(
    prisma,
    readCookie(cookieHeader, config.SESSION_COOKIE_NAME),
    { maxAgeDays: config.SESSION_MAX_AGE_DAYS },
  )

  // A forged or expired id gets past middleware, which can only see that a cookie exists.
  if (lookup.status !== 'valid') redirect('/login')

  const { user } = lookup
  const [service, params] = await Promise.all([
    serviceCredentialState(prisma),
    searchParams,
  ])
  const outcome = Array.isArray(params.service) ? params.service[0] : params.service

  // Computed here, in the user's own zone, so "Today" and "Yesterday" on a card agree with
  // the dates the resolver produced. A browser-side `new Date()` could disagree either side
  // of midnight, which is exactly the seam this app keeps getting wrong.
  const today = formatIso(todayIn(user.timezone))

  return (
    <main className="flex h-dvh flex-col">
      <TimezoneSync stored={user.timezone} />

      <header className="flex items-center justify-between gap-4 border-b border-stelic-navy/10 px-4 py-2 dark:border-white/10">
        <div className="flex items-center gap-2">
          <StelicMark size={28} />
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight">Stelic Assistant</h1>
            <p className="text-xs opacity-60">{user.displayName ?? user.email}</p>
          </div>
        </div>
        <SignOutButton />
      </header>

      {service.connected ? (
        <>
          <IndexWarmer />
          <div className="min-h-0 flex-1">
            <Chat today={today} />
          </div>
        </>
      ) : (
        <div className="mx-auto w-full max-w-md p-6">
          <ServiceCredentialBanner outcome={outcome} />
        </div>
      )}
    </main>
  )
}
