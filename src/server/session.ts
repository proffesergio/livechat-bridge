/**
 * Visitor session tokens.
 *
 * Signed with HMAC-SHA256 through Web Crypto rather than `jsonwebtoken` so the
 * same code runs on Node, Bun, Workers, and the Vercel edge runtime. The token
 * is `base64url(payload).base64url(signature)` — JWT-shaped minus the header,
 * because the algorithm is not negotiable and an attacker-supplied `alg` is a
 * class of bug we would rather not have.
 *
 * A token is a bearer credential for exactly one `(siteId, visitorId)` pair.
 * Handlers must scope every query by both claims; nothing else in the request
 * is trusted.
 */

import type { SessionClaims, SiteId } from '../types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* -------------------------------------------------------------------------- */
/* base64url                                                                   */
/* -------------------------------------------------------------------------- */

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  // Reject anything outside the alphabet up front; `atob` is lenient about
  // whitespace and we do not want two encodings of the same signature.
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* HMAC                                                                        */
/* -------------------------------------------------------------------------- */

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error('livechat-bridge: Web Crypto (globalThis.crypto.subtle) is unavailable');
  }
  return c.subtle;
}

async function hmac(message: string, secret: string): Promise<Uint8Array> {
  const key = await subtle().importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle().sign('HMAC', key, encoder.encode(message));
  return new Uint8Array(sig);
}

/**
 * Constant-time byte comparison.
 *
 * A `===` on the base64 signature leaks how many leading bytes matched, which
 * is enough to forge a signature one byte at a time over a few thousand
 * requests. Length is compared up front because an HMAC-SHA256 digest is always
 * 32 bytes — the length itself is not a secret.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/* -------------------------------------------------------------------------- */
/* Session tokens                                                              */
/* -------------------------------------------------------------------------- */

/** Claims minus the timestamps, which `signSession` stamps itself. */
export type SessionInput = Omit<SessionClaims, 'issuedAt' | 'expiresAt'> &
  Partial<Pick<SessionClaims, 'issuedAt' | 'expiresAt'>>;

/** Default lifetime when the caller does not supply `expiresAt`. 30 days. */
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function signSession(claims: SessionInput, secret: string): Promise<string> {
  if (!secret) throw new Error('livechat-bridge: session secret is empty');
  const now = Date.now();
  const full: SessionClaims = {
    siteId: claims.siteId,
    visitorId: claims.visitorId,
    anonymous: claims.anonymous,
    issuedAt: claims.issuedAt ?? now,
    expiresAt: claims.expiresAt ?? now + DEFAULT_TTL_MS,
  };
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(full)));
  const signature = bytesToBase64Url(await hmac(payload, secret));
  return `${payload}.${signature}`;
}

/**
 * Verifies signature *and* expiry, returning `null` for every failure mode.
 *
 * Callers get a yes/no answer with no error channel on purpose: distinguishing
 * "bad signature" from "expired" in a response tells an attacker which half of
 * the token to keep working on.
 */
export async function verifySession(token: string, secret: string): Promise<SessionClaims | null> {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  // Exactly one separator — a second dot means this is a differently-shaped
  // token (a JWT, say) and we should not try to interpret it.
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;

  const payloadPart = token.slice(0, dot);
  const signaturePart = token.slice(dot + 1);

  const provided = base64UrlToBytes(signaturePart);
  if (!provided) return null;

  const expected = await hmac(payloadPart, secret);
  if (!timingSafeEqual(expected, provided)) return null;

  const payloadBytes = base64UrlToBytes(payloadPart);
  if (!payloadBytes) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const c = parsed as Record<string, unknown>;
  if (
    typeof c['siteId'] !== 'string' ||
    typeof c['visitorId'] !== 'string' ||
    typeof c['anonymous'] !== 'boolean' ||
    typeof c['issuedAt'] !== 'number' ||
    typeof c['expiresAt'] !== 'number'
  ) {
    return null;
  }
  if (!c['siteId'] || !c['visitorId']) return null;
  if (c['expiresAt'] <= Date.now()) return null;

  return {
    siteId: c['siteId'],
    visitorId: c['visitorId'],
    anonymous: c['anonymous'],
    issuedAt: c['issuedAt'],
    expiresAt: c['expiresAt'],
  };
}

/* -------------------------------------------------------------------------- */
/* Host-vouched identity                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Canonical message for the identity HMAC.
 *
 * `siteId` is bound into the signature so a vouching token minted for one
 * tenant cannot be replayed against another, and the separator keeps
 * `("ab", "c")` from colliding with `("a", "bc")`.
 */
export function identityHmacMessage(siteId: SiteId, identityId: string): string {
  return `${siteId}:${identityId}`;
}

/**
 * Verifies that the host site signed this identity.
 *
 * Accepts the digest as lowercase/uppercase hex or base64url — hosts sign this
 * in whatever language their backend is written in, and both encodings are
 * ubiquitous. Comparison is on raw bytes, so it stays timing-safe either way.
 */
export async function verifyIdentityHmac(
  siteId: SiteId,
  identityId: string,
  providedHmac: string,
  secret: string,
): Promise<boolean> {
  if (!siteId || !identityId || !providedHmac || !secret) return false;

  const provided = hexToBytes(providedHmac) ?? base64UrlToBytes(providedHmac);
  if (!provided) return false;

  const expected = await hmac(identityHmacMessage(siteId, identityId), secret);
  return timingSafeEqual(expected, provided);
}

/** Signs an identity the way a host backend would. Exported for host use and tests. */
export async function signIdentityHmac(
  siteId: SiteId,
  identityId: string,
  secret: string,
): Promise<string> {
  const bytes = await hmac(identityHmacMessage(siteId, identityId), secret);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return hex;
}
