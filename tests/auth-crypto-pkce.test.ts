import { describe, expect, it } from 'vitest'
import { DecryptionError, decrypt, encrypt, readKey, safeEqual } from '@/lib/auth/crypto'
import { createPkcePair, createState, deriveCodeChallenge } from '@/lib/auth/pkce'

const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')

describe('token encryption', () => {
  it('round-trips a refresh token', () => {
    const token = '1000.abcdef0123456789.fedcba9876543210'
    expect(decrypt(encrypt(token, KEY), KEY)).toBe(token)
  })

  it('produces different ciphertext each time, so identical tokens are not identifiable', () => {
    const a = encrypt('same-token', KEY)
    const b = encrypt('same-token', KEY)
    expect(a).not.toBe(b)
    expect(decrypt(a, KEY)).toBe(decrypt(b, KEY))
  })

  it('never leaks the plaintext into the ciphertext', () => {
    expect(encrypt('1000.secret-token', KEY)).not.toContain('secret-token')
  })

  it('refuses a wrong key', () => {
    const payload = encrypt('token', KEY)
    expect(() => decrypt(payload, OTHER_KEY)).toThrow(DecryptionError)
  })

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const payload = encrypt('8 hours on Clayco', KEY)
    const parts = payload.split('.')
    const flipped = Buffer.from(parts[3]!, 'base64url')
    flipped[0] = flipped[0]! ^ 0xff
    parts[3] = flipped.toString('base64url')
    expect(() => decrypt(parts.join('.'), KEY)).toThrow(DecryptionError)
  })

  it('refuses a tampered auth tag', () => {
    const parts = encrypt('token', KEY).split('.')
    const tag = Buffer.from(parts[2]!, 'base64url')
    tag[0] = tag[0]! ^ 0xff
    parts[2] = tag.toString('base64url')
    expect(() => decrypt(parts.join('.'), KEY)).toThrow(DecryptionError)
  })

  it('refuses a malformed payload', () => {
    for (const bad of ['', 'nope', 'v1.a.b', 'v2.a.b.c', 'v1...']) {
      expect(() => decrypt(bad, KEY)).toThrow(DecryptionError)
    }
  })

  it('accepts a hex or base64 key of exactly 32 bytes', () => {
    expect(readKey('a'.repeat(64))).toHaveLength(32)
    expect(readKey(KEY)).toHaveLength(32)
  })

  it('rejects a key of the wrong length', () => {
    expect(() => readKey(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/)
    expect(() => encrypt('x', 'short')).toThrow(/32 bytes/)
  })

  it('handles unicode and empty strings', () => {
    expect(decrypt(encrypt('reunião com o Alex — 3h', KEY), KEY)).toBe(
      'reunião com o Alex — 3h',
    )
    expect(decrypt(encrypt('', KEY), KEY)).toBe('')
  })
})

describe('safeEqual', () => {
  it('compares without leaking length-independent timing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
  })
})

describe('PKCE', () => {
  it('derives the challenge as base64url sha256 of the verifier', () => {
    // Known-answer test from RFC 7636 appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(deriveCodeChallenge(verifier)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('produces a verifier within the RFC length bounds', () => {
    for (let i = 0; i < 20; i += 1) {
      const { verifier } = createPkcePair()
      expect(verifier.length).toBeGreaterThanOrEqual(43)
      expect(verifier.length).toBeLessThanOrEqual(128)
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('never repeats a verifier or a state', () => {
    const verifiers = new Set(
      Array.from({ length: 200 }, () => createPkcePair().verifier),
    )
    const states = new Set(Array.from({ length: 200 }, () => createState()))
    expect(verifiers.size).toBe(200)
    expect(states.size).toBe(200)
  })

  it('always declares S256, never plain', () => {
    expect(createPkcePair().method).toBe('S256')
  })
})
