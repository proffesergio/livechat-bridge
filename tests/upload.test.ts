import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Conversation, UploadResult, UploadStore } from '../src/types.js';
import { resetEventBus } from '../src/server/events.js';
import { createRouteHandlers, type RouteHandlers } from '../src/server/handlers/index.js';
import { sanitiseFilename } from '../src/server/handlers/upload.js';
import { clearDb, startMongo, stopMongo } from './mongo.js';

const SECRET = 'upload-test-secret';
const SITE = 'site-a';
const BASE = 'https://api.example/api/livechat';
const MAX_BYTES = 1024;

interface PutCall {
  siteId: string;
  conversationId: string;
  name: string;
  contentType: string;
  size: number;
}

const puts: PutCall[] = [];

/** Records what actually reached storage — the point of most of these tests. */
const store: UploadStore = {
  async put(file) {
    puts.push({
      siteId: file.siteId,
      conversationId: file.conversationId,
      name: file.name,
      contentType: file.contentType,
      size: file.size,
    });
    return { id: `att-${puts.length}`, url: `https://cdn.example/${puts.length}/${file.name}` };
  },
};

let handlers: RouteHandlers;
let token: string;
let conversationId: string;

beforeAll(async () => {
  const uri = await startMongo();
  handlers = createRouteHandlers({
    sessionSecret: SECRET,
    mongoUri: uri,
    uploadStore: store,
    maxUploadBytes: MAX_BYTES,
    allowedMimeTypes: ['image/png', 'text/plain'],
  });
}, 120_000);

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearDb();
  resetEventBus();
  puts.length = 0;

  const sessionRes = await handlers.session(
    new Request(`${BASE}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-site-id': SITE },
      body: JSON.stringify({ siteId: SITE }),
    }),
  );
  token = ((await sessionRes.json()) as { token: string }).token;

  const send = await handlers.messages(
    new Request(`${BASE}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ body: 'here is a screenshot' }),
    }),
  );
  conversationId = ((await send.json()) as { conversation: Conversation }).conversation.id;
});

function uploadRequest(file: File, opts: { conversationId?: string } = {}): Request {
  const form = new FormData();
  form.append('file', file);
  const id = opts.conversationId ?? conversationId;
  return new Request(`${BASE}/upload?conversationId=${id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
}

function fileOf(bytes: number, name: string, type: string): File {
  return new File([new Uint8Array(bytes).fill(65)], name, { type });
}

describe('upload limits', () => {
  it('accepts a well-formed upload', async () => {
    const res = await handlers.upload(uploadRequest(fileOf(64, 'shot.png', 'image/png')));
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as UploadResult;
    expect(attachment.name).toBe('shot.png');
    expect(attachment.size).toBe(64);
    expect(attachment.contentType).toBe('image/png');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.siteId).toBe(SITE);
  });

  it('rejects an oversized file before touching the store', async () => {
    const res = await handlers.upload(
      uploadRequest(fileOf(MAX_BYTES + 1, 'huge.png', 'image/png')),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'payload_too_large' });
    expect(puts).toHaveLength(0);
  });

  it('rejects a declared content-length over the limit without reading the body', async () => {
    const res = await handlers.upload(
      new Request(`${BASE}/upload?conversationId=${conversationId}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': String(MAX_BYTES * 10),
        },
        body: '--x--',
      }),
    );
    expect(res.status).toBe(413);
    expect(puts).toHaveLength(0);
  });

  it('rejects a disallowed MIME type before touching the store', async () => {
    const res = await handlers.upload(
      uploadRequest(fileOf(32, 'payload.svg', 'image/svg+xml')),
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toMatchObject({ code: 'unsupported_media_type' });
    expect(puts).toHaveLength(0);
  });

  it('rejects a file with no declared type', async () => {
    const res = await handlers.upload(uploadRequest(fileOf(32, 'mystery', '')));
    expect(res.status).toBe(415);
    expect(puts).toHaveLength(0);
  });

  it('rejects a non-multipart request', async () => {
    const res = await handlers.upload(
      new Request(`${BASE}/upload?conversationId=${conversationId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(res.status).toBe(415);
    expect(puts).toHaveLength(0);
  });

  it('rejects an empty file', async () => {
    const res = await handlers.upload(uploadRequest(fileOf(0, 'empty.png', 'image/png')));
    expect(res.status).toBe(400);
    expect(puts).toHaveLength(0);
  });
});

describe('filename sanitisation', () => {
  it('strips path traversal from the stored name', async () => {
    const res = await handlers.upload(
      uploadRequest(fileOf(32, '../../../etc/passwd', 'text/plain')),
    );
    expect(res.status).toBe(201);
    const { attachment } = (await res.json()) as UploadResult;
    expect(attachment.name).toBe('passwd');
    expect(puts[0]?.name).toBe('passwd');
    expect(attachment.url).not.toContain('..');
    expect(attachment.url).not.toContain('/etc/');
  });

  it('strips windows-style traversal too', async () => {
    const res = await handlers.upload(
      uploadRequest(fileOf(32, '..\\..\\windows\\system32\\cmd.txt', 'text/plain')),
    );
    expect(res.status).toBe(201);
    expect(puts[0]?.name).toBe('cmd.txt');
  });

  it('handles the pathological cases directly', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('..\\..\\secret.txt')).toBe('secret.txt');
    expect(sanitiseFilename('..')).toBe('upload');
    expect(sanitiseFilename('...')).toBe('upload');
    expect(sanitiseFilename('/')).toBe('upload');
    expect(sanitiseFilename('')).toBe('upload');
    expect(sanitiseFilename('.hidden')).toBe('hidden');
    expect(sanitiseFilename('a/b/../c.png')).toBe('c.png');
    expect(sanitiseFilename('re port (1).PNG')).toBe('re_port__1_.PNG');
    expect(sanitiseFilename('x'.repeat(500)).length).toBe(200);
    // No separator or dot-dot segment can survive.
    for (const name of ['../../etc/passwd', '..\\..\\x', 'a/../../b', '....//x']) {
      const safe = sanitiseFilename(name);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe).not.toContain('..');
    }
  });
});

describe('upload authorisation', () => {
  it('rejects an unauthenticated upload', async () => {
    const form = new FormData();
    form.append('file', fileOf(32, 'a.png', 'image/png'));
    const res = await handlers.upload(
      new Request(`${BASE}/upload?conversationId=${conversationId}`, {
        method: 'POST',
        body: form,
      }),
    );
    expect(res.status).toBe(401);
    expect(puts).toHaveLength(0);
  });

  it('rejects an upload aimed at a conversation the visitor does not own', async () => {
    const otherSession = await handlers.session(
      new Request(`${BASE}/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-site-id': SITE },
        body: JSON.stringify({ siteId: SITE }),
      }),
    );
    const otherToken = ((await otherSession.json()) as { token: string }).token;

    const form = new FormData();
    form.append('file', fileOf(32, 'a.png', 'image/png'));
    const res = await handlers.upload(
      new Request(`${BASE}/upload?conversationId=${conversationId}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherToken}` },
        body: form,
      }),
    );
    expect(res.status).toBe(404);
    expect(puts).toHaveLength(0);
  });
});
