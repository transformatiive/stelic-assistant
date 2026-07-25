#!/usr/bin/env node
/**
 * Build the project index without waiting for the schedule (task 9.5).
 *
 * The index is **shared**, not per user — that is what makes this a script and not a loop
 * over people. One rebuild serves everybody, which is also why the scheduled job is possible
 * at all: 145 projects against a 100-per-120-seconds limit is one slow run, and fifteen
 * copies of it would be three quarters of an hour.
 *
 * So this is a deliberate trigger of the same endpoint the schedule calls, for the two cases
 * where waiting is wrong: a fresh deployment with an empty index, and a schedule that has
 * stopped. It runs the identical code path — there is no second, subtly different rebuild
 * for operators to keep in sync.
 *
 *   BASE_URL=https://… CRON_SECRET=… node scripts/warm-index.mjs
 *
 * Takes minutes, on purpose. The pacing between Zoho calls is what keeps the portal from
 * locking us out for a quarter of an hour, and a faster script would simply fail.
 */
// APP_URL is accepted as well as BASE_URL because the scheduled container runs this same
// script, and that service already names the app's address APP_URL. Two names for one thing
// beats a rebuild that exits 1 twice a day because the obvious-looking variable was set.
const baseUrl = (process.env.BASE_URL ?? process.env.APP_URL ?? '').replace(/\/$/, '')
const secret = process.env.CRON_SECRET

if (!baseUrl || !secret) {
  console.error(
    'warm-index: BASE_URL (or APP_URL) and CRON_SECRET are both required.\n' +
      '  BASE_URL=https://stelic-assistant-production.up.railway.app \\\n' +
      '  CRON_SECRET=… node scripts/warm-index.mjs',
  )
  process.exit(1)
}

const started = Date.now()
console.log(`warm-index: rebuilding via ${baseUrl}/api/cron/refresh-index …`)
console.log(
  'warm-index: this walks every project and paces itself; expect several minutes.',
)

let response
try {
  response = await fetch(`${baseUrl}/api/cron/refresh-index`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
    // Longer than the route's own 800s ceiling, so a timeout here always means the network
    // rather than the rebuild.
    signal: AbortSignal.timeout(900_000),
  })
} catch (error) {
  console.error(`warm-index: could not reach the app — ${error.name}`)
  process.exit(1)
}

const seconds = Math.round((Date.now() - started) / 1000)

if (response.status === 401) {
  console.error('warm-index: refused — CRON_SECRET does not match the deployment.')
  process.exit(1)
}
if (response.status === 503) {
  console.error(
    'warm-index: the deployment has no CRON_SECRET configured, so it refuses.',
  )
  process.exit(1)
}

const body = await response.json().catch(() => null)
if (!body) {
  console.error(`warm-index: unreadable response (${response.status}) after ${seconds}s`)
  process.exit(1)
}

// The route answers 200 even when the rebuild failed — a scheduler retrying a rebuild that
// failed on a missing scope would hammer the portal for nothing. So read the body, not the
// status.
if (!body.ok) {
  console.error(
    `warm-index: rebuild failed after ${seconds}s — ${body.reason}: ${body.detail}`,
  )
  process.exit(1)
}

const s = body.stats ?? {}
console.log(
  `warm-index: ${seconds}s — ${s.projectsIndexed}/${s.projectsSeen} projects, ` +
    `${s.projectsWithTasksFetched} with charge codes read, ` +
    `${s.projectsWithTaskFailures} task reads failed, ` +
    `${s.dealsResolved}/${s.dealsRequested} CRM deals resolved, ` +
    `${body.written} written, ${body.removed} removed.`,
)

if (s.projectsWithTaskFailures > 0) {
  // Not a failure: every project is still matchable. But an index with no charge codes can
  // match a project and have nothing to log against, so it is worth saying out loud.
  console.warn(
    `warm-index: ${s.projectsWithTaskFailures} project(s) have no charge codes this run — ` +
      'usually a throttle. The next scheduled run fills them in.',
  )
}
