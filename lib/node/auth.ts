// Cluster-join authentication — Erlang's magic cookie, done right for a web wire. The cookie (a
// shared `secret`) is NEVER sent: the accepting side issues a random per-connection nonce, the
// dialing side returns HMAC-SHA-256(secret, nonce), and the acceptor recomputes and compares. A
// sniffed digest is useless (the next connection's nonce differs — replay-resistant), and the secret
// never crosses the wire. Universal: Web Crypto (`crypto.subtle` + `crypto.getRandomValues`) is
// present on Node, Deno, and browsers. Standalone/dependency-free — liftable like scheduler.ts.
const utf8 = new TextEncoder();

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A fresh 128-bit nonce as hex — the per-connection challenge. Fresh every connection so a replayed
 * digest never matches.
 *
 * ```ts
 * randomNonce().length; // 32 — 16 bytes as hex
 * ```
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * HMAC-SHA-256(`secret`, `nonce`) as hex — the proof a dialing node returns for a challenge. The
 * secret keys the MAC and never leaves the process.
 *
 * ```ts
 * const a = await authDigest('cookie', 'abc');
 * const b = await authDigest('cookie', 'abc');
 * a === b; // true — deterministic for a given (secret, nonce)
 * (await authDigest('other', 'abc')) === a; // false — a different cookie yields a different proof
 * ```
 */
export async function authDigest(secret: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, utf8.encode(nonce));
  return toHex(new Uint8Array(signature));
}

/**
 * Constant-time string compare — verify a digest without leaking, via early return, how many
 * leading characters matched (a timing side channel).
 *
 * ```ts
 * safeEqual('abc', 'abc'); // true
 * safeEqual('abc', 'abd'); // false
 * safeEqual('abc', 'ab'); // false — length mismatch
 * ```
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
