import { defineConfig } from '@playwright/test'

/**
 * End-to-end against a **running deployment** (task 10.4).
 *
 * Not against a dev server with a mocked Zoho. The whole point of this suite is the part
 * unit tests cannot reach: that a sentence typed by a real person becomes a real row in the
 * real portal, and that undo removes it again. A mocked run would pass on the day the portal
 * changed a field name — which is the exact failure this project has already had twice.
 *
 * It therefore needs two things it cannot invent: a URL and a signed-in session cookie.
 * Without them the suite **skips rather than fails**, because a red CI run that only means
 * "no credentials here" is a red run people learn to ignore.
 *
 *   E2E_BASE_URL=https://…  E2E_SESSION=<stelic_session cookie>  npm run e2e
 */
const baseURL = process.env.E2E_BASE_URL

export default defineConfig({
  testDir: './e2e',
  // Serial: the tests share one Zoho portal and one draft at a time. Parallel runs would
  // race each other's drafts and produce failures that are about the test, not the app.
  workers: 1,
  fullyParallel: false,
  // Nothing here is retried. A flake in a suite that writes to a live timesheet is
  // information, not noise — and a retry could log the same hours twice.
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  use: {
    ...(baseURL ? { baseURL } : {}),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Preinstalled in this environment; `playwright install` is not needed and not wanted.
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
})
