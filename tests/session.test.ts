import { describe, expect, it } from 'vitest';

import {
  identityHmacMessage,
  signIdentityHmac,
  signSession,
  verifyIdentityHmac,
  verifySession,
} from '../src/server/session.js';

const SECRET = 'correct-horse-battery-staple';

describe('signSession / verifySession', () => {
  it('round-trips claims', async () => {
    const token = await signSession(
      { siteId: 'site-a', visitorId: 'a:123', anonymous: true },
      SECRET,
    );
    expect(token.split('.')).toHaveLength(2);

    const claims = await verifySession(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.siteId).toBe('site-a');
    expect(claims?.visitorId).toBe('a:123');
    expect(claims?.anonymous).toBe(true);
    expect(claims?.expiresAt).toBeGreaterThan(Date.now());
  });

  it('honours an explicit expiry', async () => {
    const expiresAt = Date.now() + 60_000;
    const token = await signSession(
      { siteId: 's', visitorId: 'v', anonymous: false, expiresAt },
      SECRET,
    );
    const claims = await verifySession(token, SECRET);
    expect(claims?.expiresAt).toBe(expiresAt);
    expect(claims?.anonymous).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await signSession(
      { siteId: 's', visitorId: 'v', anonymous: true, expiresAt: Date.now() - 1 },
      SECRET,
    );
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it('rejects a tampered signature', async () => {
    const token = await signSession({ siteId: 's', visitorId: 'v', anonymous: true }, SECRET);
    const [payload, sig] = token.split('.') as [string, string];
    // Flip one character of the signature.
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await verifySession(`${payload}.${flipped}`, SECRET)).toBeNull();
  });

  it('rejects a tampered payload (privilege escalation attempt)', async () => {
    const token = await signSession(
      { siteId: 'site-a', visitorId: 'a:1', anonymous: true },
      SECRET,
    );
    const sig = token.split('.')[1] as string;
    const forged = Buffer.from(
      JSON.stringify({
        siteId: 'site-b',
        visitorId: 'a:1',
        anonymous: true,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    ).toString('base64url');
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signSession({ siteId: 's', visitorId: 'v', anonymous: true }, 'other');
    expect(await verifySession(token, SECRET)).toBeNull();
  });

  it('rejects structurally invalid tokens', async () => {
    expect(await verifySession('', SECRET)).toBeNull();
    expect(await verifySession('no-dot', SECRET)).toBeNull();
    expect(await verifySession('a.b.c', SECRET)).toBeNull();
    expect(await verifySession('.sig', SECRET)).toBeNull();
    expect(await verifySession('payload.!!!', SECRET)).toBeNull();
  });

  it('rejects a well-signed payload that is not a claims object', async () => {
    // Signature is valid, contents are not — verification must still fail.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    const token = await signSession({ siteId: 's', visitorId: 'v', anonymous: true }, SECRET);
    const realPayload = token.split('.')[0] as string;
    expect(realPayload).not.toBe(payload);

    // Re-sign the bogus payload properly so only the shape check can reject it.
    const bogusToken = await (async () => {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
      return `${payload}.${Buffer.from(sig).toString('base64url')}`;
    })();

    expect(await verifySession(bogusToken, SECRET)).toBeNull();
  });
});

describe('verifyIdentityHmac', () => {
  it('accepts a digest the host signed', async () => {
    const hmac = await signIdentityHmac('site-a', 'user-42', SECRET);
    expect(await verifyIdentityHmac('site-a', 'user-42', hmac, SECRET)).toBe(true);
  });

  it('accepts the digest in base64url as well as hex', async () => {
    const hex = await signIdentityHmac('site-a', 'user-42', SECRET);
    const b64 = Buffer.from(hex, 'hex').toString('base64url');
    expect(await verifyIdentityHmac('site-a', 'user-42', b64, SECRET)).toBe(true);
  });

  it('binds the digest to the tenant', async () => {
    const hmac = await signIdentityHmac('site-a', 'user-42', SECRET);
    // The same identity, replayed against a different site, must not verify.
    expect(await verifyIdentityHmac('site-b', 'user-42', hmac, SECRET)).toBe(false);
  });

  it('rejects a different identity and a different secret', async () => {
    const hmac = await signIdentityHmac('site-a', 'user-42', SECRET);
    expect(await verifyIdentityHmac('site-a', 'user-43', hmac, SECRET)).toBe(false);
    expect(await verifyIdentityHmac('site-a', 'user-42', hmac, 'other')).toBe(false);
    expect(await verifyIdentityHmac('site-a', 'user-42', 'not-a-digest!', SECRET)).toBe(false);
    expect(await verifyIdentityHmac('site-a', 'user-42', '', SECRET)).toBe(false);
  });

  it('uses a separator so ids cannot be re-partitioned', () => {
    expect(identityHmacMessage('ab', 'c')).not.toBe(identityHmacMessage('a', 'bc'));
  });
});
