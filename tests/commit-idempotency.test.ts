import { describe, expect, it } from 'vitest'
import { IDEMPOTENCY_KEY_LENGTH, idempotencyKey } from '@/lib/commit/idempotency'

const base = {
  userId: 'user_1',
  projectId: '2620762000000744019',
  taskId: '2620762000000750005',
  logDate: '2026-07-21',
  hours: 8,
  description: 'schedule updates and progress meeting',
}

describe('idempotencyKey', () => {
  it('is stable for the same booking', () => {
    expect(idempotencyKey(base)).toBe(idempotencyKey({ ...base }))
  })

  it('is 32 characters', () => {
    expect(idempotencyKey(base)).toHaveLength(IDEMPOTENCY_KEY_LENGTH)
  })

  it('treats 8 and 8.00 as the same booking', () => {
    expect(idempotencyKey({ ...base, hours: 8.0 })).toBe(idempotencyKey(base))
  })

  it('ignores incidental whitespace and case in the description', () => {
    expect(
      idempotencyKey({
        ...base,
        description: '  Schedule updates and   progress meeting ',
      }),
    ).toBe(idempotencyKey(base))
  })

  it('differs when anything material differs', () => {
    const key = idempotencyKey(base)
    expect(idempotencyKey({ ...base, userId: 'user_2' })).not.toBe(key)
    expect(idempotencyKey({ ...base, projectId: 'other' })).not.toBe(key)
    expect(idempotencyKey({ ...base, taskId: 'other' })).not.toBe(key)
    expect(idempotencyKey({ ...base, logDate: '2026-07-22' })).not.toBe(key)
    expect(idempotencyKey({ ...base, hours: 7.75 })).not.toBe(key)
    expect(idempotencyKey({ ...base, description: 'something else entirely' })).not.toBe(
      key,
    )
  })

  it('does not collide across a field boundary', () => {
    // "ab" + "c" must not hash the same as "a" + "bc".
    const left = idempotencyKey({ ...base, projectId: 'ab', taskId: 'c' })
    const right = idempotencyKey({ ...base, projectId: 'a', taskId: 'bc' })
    expect(left).not.toBe(right)
  })
})
