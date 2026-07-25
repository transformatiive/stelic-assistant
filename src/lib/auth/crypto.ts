import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

/**
 * AES-256-GCM for tokens at rest (task 2.3, AUTH-2).
 *
 * GCM rather than CBC because it authenticates as well as encrypts: a tampered ciphertext
 * fails to decrypt instead of yielding plausible garbage. Each value gets its own random IV,
 * so encrypting the same token twice produces different output and an attacker cannot tell
 * that two users hold the same token.
 */

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // 96 bits, the size GCM is specified for
const TAG_BYTES = 16
const VERSION = 'v1'

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

/**
 * Accepts the key as 64 hex characters or base64, and insists on exactly 32 bytes — a short
 * key would silently weaken every token in the database.
 */
export function readKey(key: string): Buffer {
  const trimmed = key.trim()
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  if (buffer.length !== 32) {
    throw new Error(`Encryption key must be 32 bytes, got ${buffer.length}`)
  }
  return buffer
}

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. Versioned so the scheme can be rotated. */
export function encrypt(plaintext: string, key: string): string {
  const keyBuffer = readKey(key)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decrypt(payload: string, key: string): string {
  const keyBuffer = readKey(key)
  const parts = payload.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError('Ciphertext is not in the expected format')
  }

  const iv = Buffer.from(parts[1]!, 'base64url')
  const tag = Buffer.from(parts[2]!, 'base64url')
  const ciphertext = Buffer.from(parts[3]!, 'base64url')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError('Ciphertext is not in the expected format')
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    // Deliberately opaque: the caller must not be able to distinguish a wrong key from a
    // tampered payload.
    throw new DecryptionError('Could not decrypt')
  }
}

/** Constant-time comparison, for anything an attacker could probe by timing. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}
