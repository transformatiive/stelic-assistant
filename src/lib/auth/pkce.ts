import { createHash, randomBytes } from 'node:crypto'

/**
 * PKCE and CSRF state (task 2.1, AUTH-1).
 *
 * PKCE stops an intercepted authorization code being redeemed by anyone but us: the code is
 * only exchangeable together with the verifier, which never leaves the server. `state` is a
 * separate concern — it proves the callback belongs to a flow *we* started.
 */

/** RFC 7636 allows 43–128 characters; 32 random bytes base64url-encodes to 43. */
export function createCodeVerifier(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function createState(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export type PkcePair = {
  verifier: string
  challenge: string
  method: 'S256'
}

export function createPkcePair(): PkcePair {
  const verifier = createCodeVerifier()
  return { verifier, challenge: deriveCodeChallenge(verifier), method: 'S256' }
}
