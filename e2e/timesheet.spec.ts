import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/**
 * Login → log a day → confirm → verify in Zoho → undo (task 10.4).
 *
 * **This writes to the real portal.** That is deliberate and it is the only reason the suite
 * is worth having: everything below the API boundary is already covered by 641 unit tests
 * against recorded shapes, and what those cannot tell you is whether the shapes are still
 * true. Both of this project's worst bugs — `custom_fields` silently matching nothing, and a
 * trailing slash turning a working endpoint into "Given URL is wrong" — would have passed a
 * mocked end-to-end run.
 *
 * It cleans up after itself by using the app's own undo, so a run leaves the timesheet as it
 * found it. If a run dies between the confirm and the undo, it leaves **one** log on the
 * chosen project for today, which a person can delete in seconds.
 *
 * Skipped, not failed, when it has no credentials. A red run that only means "not configured
 * here" is a red run people stop reading.
 */

const BASE_URL = process.env.E2E_BASE_URL
const SESSION = process.env.E2E_SESSION
/** A project the signed-in user can log to. Its name is what gets typed at the bot. */
const PROJECT = process.env.E2E_PROJECT ?? 'Clayco'

test.describe('logging a day end to end', () => {
  test.skip(
    !BASE_URL || !SESSION,
    'Set E2E_BASE_URL and E2E_SESSION (the stelic_session cookie) to run against a deployment.',
  )

  test.beforeEach(async ({ context }) => {
    await signIn(context)
  })

  test('a sentence becomes a Zoho log, and undo takes it back', async ({
    page,
    request,
  }) => {
    // Distinctive, so the assertion cannot pass on somebody else's entry, and so a stranded
    // log is obvious in the Zoho UI for whoever has to clean it up.
    const marker = `e2e check ${Date.now()}`

    await page.goto('/')
    await expect(page.getByLabel('What did you work on?')).toBeVisible()

    await send(page, `15m on ${PROJECT} today — ${marker}`)

    // The bot may need to ask something — an ambiguous project, a missing charge code. The
    // suite answers with the first option rather than assuming a clean run, because a clean
    // run is a property of the portal's data and not of the app.
    await answerAnyQuestions(page)

    const card = page.getByRole('region', { name: 'Entries to confirm' })
    await expect(card).toBeVisible()
    await expect(card).toContainText(marker)
    await expect(card).toContainText('15m')

    await card.getByRole('button', { name: 'Confirm all' }).click()

    const result = page.getByRole('region', { name: 'What was logged' })
    await expect(result).toBeVisible()
    await expect(result).toContainText('1 logged')

    // Verified in Zoho, not on our own screen. The card saying "logged" is this app's claim;
    // the week read-back is the portal's answer.
    const week = await request.get('/api/entries/week')
    expect(week.ok()).toBe(true)
    const body = (await week.json()) as {
      days: { entries: { description: string; hours: number }[] }[]
    }
    const written = body.days
      .flatMap((day) => day.entries)
      .find((entry) => entry.description.includes(marker))
    expect(written, 'the entry should be readable back from Zoho').toBeTruthy()
    expect(written!.hours).toBeCloseTo(0.25, 2)

    // …and undo it, so the run leaves the timesheet as it found it.
    await send(page, 'undo that')
    const undoChips = page.getByRole('group', { name: 'Options' })
    await expect(undoChips).toBeVisible()
    await undoChips.getByRole('button').first().click()
    await expect(page.getByText('Removed it from Zoho.')).toBeVisible()

    const after = await request.get('/api/entries/week')
    const afterBody = (await after.json()) as {
      days: { entries: { description: string }[] }[]
    }
    const stillThere = afterBody.days
      .flatMap((day) => day.entries)
      .some((entry) => entry.description.includes(marker))
    expect(stillThere, 'undo should have removed it from Zoho').toBe(false)
  })

  test('a future date is refused rather than logged', async ({ page }) => {
    await page.goto('/')
    await send(page, `8h on ${PROJECT} next Friday — e2e future check`)
    await answerAnyQuestions(page)

    const card = page.getByRole('region', { name: 'Entries to confirm' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('Blocked')
    // Nothing on the card is loggable, so the button cannot be pressed at all.
    await expect(card.getByRole('button', { name: 'Confirm all' })).toBeDisabled()
  })

  test('cancelling writes nothing', async ({ page, request }) => {
    const marker = `e2e cancel ${Date.now()}`
    await page.goto('/')
    await send(page, `30m on ${PROJECT} today — ${marker}`)
    await answerAnyQuestions(page)

    const card = page.getByRole('region', { name: 'Entries to confirm' })
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('Dropped it. Nothing was logged.')).toBeVisible()

    const week = await request.get('/api/entries/week')
    const body = (await week.json()) as { days: { entries: { description: string }[] }[] }
    const present = body.days
      .flatMap((day) => day.entries)
      .some((entry) => entry.description.includes(marker))
    expect(present).toBe(false)
  })
})

test.describe('the shell without a session', () => {
  test.skip(!BASE_URL, 'Set E2E_BASE_URL.')

  test('sends an anonymous visitor to sign in, and serves the PWA files anyway', async ({
    page,
    request,
  }) => {
    // A browser fetches the manifest and the icons before anyone signs in. If those redirect,
    // *Add to Home Screen* falls back to a screenshot and the wrong name.
    await page.goto('/')
    await expect(page).toHaveURL(/\/login/)

    for (const path of ['/manifest.webmanifest', '/sw.js', '/apple-touch-icon.png']) {
      const response = await request.get(path)
      expect(response.status(), `${path} should be public`).toBe(200)
    }

    const health = await request.get('/api/health')
    expect(health.status()).toBe(200)
  })
})

async function signIn(context: BrowserContext) {
  await context.addCookies([
    {
      name: process.env.E2E_COOKIE_NAME ?? 'stelic_session',
      value: SESSION!,
      url: BASE_URL!,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ])
}

async function send(page: Page, message: string) {
  const composer = page.getByLabel('What did you work on?')
  await composer.fill(message)
  await page.getByRole('button', { name: 'Send' }).click()
  // The composer clears on send and is disabled until the turn comes back.
  await expect(composer).toBeEnabled({ timeout: 90_000 })
}

/**
 * Answer whatever the bot asks, by taking the first offered option.
 *
 * Bounded, so a bot that asks the same thing forever fails the test rather than hanging it.
 */
async function answerAnyQuestions(page: Page, limit = 4) {
  for (let i = 0; i < limit; i += 1) {
    const chips = page.getByRole('group', { name: 'Options' }).last()
    if (!(await chips.isVisible().catch(() => false))) return
    await chips.getByRole('button').first().click()
    await expect(page.getByLabel('What did you work on?')).toBeEnabled({
      timeout: 90_000,
    })
  }
}
