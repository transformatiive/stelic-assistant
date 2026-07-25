import { isEnvValidationSkipped, loadConfig } from '@/lib/config'

/**
 * Next runs this once per server process before it serves anything, which makes it the
 * boot that task 1.6 means: a missing or malformed credential kills the process here
 * rather than surfacing as a 500 on whichever request first needed it.
 *
 * `SKIP_ENV_VALIDATION=1` is for `next build` and CI, where no credential exists and the
 * build must not require one.
 */
export async function register(): Promise<void> {
  if (isEnvValidationSkipped()) return
  loadConfig()
}
