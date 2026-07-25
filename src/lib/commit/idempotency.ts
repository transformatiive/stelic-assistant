import { createHash } from 'node:crypto'
import { normaliseDescription } from '../resolve/description'

/**
 * Idempotency key derivation (task 6.1, CHAT-10).
 *
 * `sha256(user_id | project_id | task_id | log_date | hours | description)` truncated to 32
 * characters, enforced by a unique constraint on `CommitLog`. A repeated confirmation of the
 * same draft therefore cannot double-book, whether it came from a double tap, a retry, or a
 * replayed request.
 */

export const IDEMPOTENCY_KEY_LENGTH = 32

export type IdempotencyInput = {
  userId: string
  projectId: string
  taskId: string
  /** ISO `YYYY-MM-DD`. */
  logDate: string
  hours: number
  description: string
}

export function idempotencyKey(input: IdempotencyInput): string {
  // Hours are fixed to two decimals and the description is whitespace-normalised so that
  // 8 vs 8.00, and "a  b" vs "a b", cannot produce two keys for the same booking.
  const parts = [
    input.userId,
    input.projectId,
    input.taskId,
    input.logDate,
    input.hours.toFixed(2),
    normaliseDescription(input.description).toLowerCase(),
  ]
  return createHash('sha256')
    .update(parts.join('|'))
    .digest('hex')
    .slice(0, IDEMPOTENCY_KEY_LENGTH)
}
