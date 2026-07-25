import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { loadConfig } from '@/lib/config'
import { prisma } from '@/lib/db'
import { loadSession } from '@/lib/auth/store'
import { readCookie } from '@/lib/auth/request'
import { StelicMark } from '@/components/stelic-mark'
import { SignOutButton } from './sign-out-button'

/**
 * The signed-in shell. The chat surface itself is task group 8; what exists here now is the
 * authenticated boundary — middleware turns away anyone with no cookie, and this page is the
 * authority on whether that cookie names a live session (AUTH-7).
 */
export const dynamic = 'force-dynamic'

export default async function Home() {
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

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <StelicMark size={36} />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Stelic Assistant</h1>
            <p className="text-sm opacity-70">
              Signed in as {user.displayName ?? user.email}
            </p>
          </div>
        </div>
        <SignOutButton />
      </header>

      <p className="text-sm opacity-70">
        Chat is not wired up yet. Sign-in, sessions and the Zoho credential plumbing are
        in place; the conversation surface is next.
      </p>
    </main>
  )
}
