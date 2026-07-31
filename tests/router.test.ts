/**
 * Router + read-receipt coverage.
 *
 * These exercise the seam between the three entry points rather than any one
 * of them. The widget addresses `POST /conversations/close` with the id in the
 * body; the agent inbox addresses `POST /conversations/<id>/close` with the id
 * in the path. Both are real callers, so both have to reach the same handler —
 * a regression here would break one client while every unit test still passed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Conversation, Agent } from '../src/types.js';
import { resetEventBus } from '../src/server/events.js';
import { createFetchRouter, type FetchRouter } from '../src/server/router.js';
import { clearDb, startMongo, stopMongo } from './mongo.js';

const SECRET = 'router-test-secret';
const SITE = 'site-a';
const ORIGIN = 'https://shop.example';
const BASE = 'https://api.example/api/livechat';

const AGENT: Agent = {
  id: 'agent-1',
  siteId: SITE,
  name: 'Ada',
  email: 'ada@example.com',
  role: 'agent',
  presence: 'online',
};

let router: FetchRouter;

beforeAll(async () => {
  const uri = await startMongo();
  router = createFetchRouter({
    sessionSecret: SECRET,
    mongoUri: uri,
    allowedOrigins: [ORIGIN],
    authenticateAgent: async (req) => (req.headers.get('x-agent-id') === AGENT.id ? AGENT : null),
  });
}, 120_000);

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearDb();
  resetEventBus();
});

const agentAuth = { 'x-agent-id': AGENT.id };

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Opens a session and sends one visitor message, returning the conversation. */
async function seedConversation(): Promise<{ conversation: Conversation; token: string }> {
  const sessionRes = await router(post('/session', { siteId: SITE }, { 'x-site-id': SITE }));
  const { token } = (await sessionRes.json()) as { token: string };

  const sendRes = await router(
    post('/messages', { body: 'my order is late' }, { authorization: `Bearer ${token}` }),
  );
  expect(sendRes.status).toBe(201);

  const listRes = await router(
    new Request(`${BASE}/conversations`, { method: 'GET', headers: agentAuth }),
  );
  const page = (await listRes.json()) as { items: Conversation[] };
  const conversation = page.items[0];
  if (!conversation) throw new Error('seed failed: no conversation');
  return { conversation, token };
}

describe('path routing', () => {
  it('dispatches every canonical route', async () => {
    const { conversation, token } = await seedConversation();
    const id = conversation.id;

    // One representative call per route, asserting only that the router found
    // a handler — the handlers' own behaviour is covered elsewhere.
    const cases: Array<[string, Request]> = [
      ['session', post('/session', { siteId: SITE }, { 'x-site-id': SITE })],
      [
        'messages GET',
        new Request(`${BASE}/messages?conversationId=${id}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ],
      ['conversations GET', new Request(`${BASE}/conversations`, { headers: agentAuth })],
      ['claim', post(`/conversations/${id}/claim`, undefined, agentAuth)],
      ['read', post(`/conversations/${id}/read`, undefined, agentAuth)],
      ['close', post(`/conversations/${id}/close`, undefined, agentAuth)],
    ];

    for (const [name, req] of cases) {
      const res = await router(req);
      expect(res.status, `${name} should route to a handler`).not.toBe(404);
    }
  });

  it('accepts the conversation id from the path or the body', async () => {
    const viaPath = await seedConversation();
    const pathRes = await router(
      post(`/conversations/${viaPath.conversation.id}/claim`, undefined, agentAuth),
    );
    expect(pathRes.status).toBe(200);

    await clearDb();
    resetEventBus();

    const viaBody = await seedConversation();
    const bodyRes = await router(
      post('/conversations/claim', { conversationId: viaBody.conversation.id }, agentAuth),
    );
    expect(bodyRes.status).toBe(200);
  });

  it('resolves routes under any mount prefix', async () => {
    for (const prefix of ['', '/api/livechat', '/chat', '/a/b/c/support']) {
      const res = await router(
        new Request(`https://api.example${prefix}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-site-id': SITE },
          body: JSON.stringify({ siteId: SITE }),
        }),
      );
      expect(res.status, `prefix "${prefix}"`).toBe(200);
    }
  });

  it('404s an unknown path instead of falling through', async () => {
    const res = await router(new Request(`${BASE}/nope`, { method: 'GET' }));
    expect(res.status).toBe(404);
  });

  it('rejects a known path with the wrong method', async () => {
    const res = await router(new Request(`${BASE}/session`, { method: 'GET' }));
    expect(res.status).toBe(404);
  });

  it('answers preflight on any path, so CORS failures are not mistaken for 404s', async () => {
    const res = await router(
      new Request(`${BASE}/messages`, {
        method: 'OPTIONS',
        headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
      }),
    );
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('still exposes the named handlers for hosts that mount by hand', () => {
    expect(typeof router.handlers.session).toBe('function');
    expect(typeof router.handlers.readConversation).toBe('function');
  });
});

describe('read receipts', () => {
  it('clears the unread badge so it does not resurrect on refresh', async () => {
    const { conversation } = await seedConversation();
    expect(conversation.unreadForAgent).toBeGreaterThan(0);

    const readRes = await router(
      post(`/conversations/${conversation.id}/read`, undefined, agentAuth),
    );
    expect(readRes.status).toBe(200);
    const { conversation: after } = (await readRes.json()) as { conversation: Conversation };
    expect(after.unreadForAgent).toBe(0);

    // Re-read from the inbox: the zero has to be persisted, not just returned.
    const listRes = await router(
      new Request(`${BASE}/conversations`, { method: 'GET', headers: agentAuth }),
    );
    const page = (await listRes.json()) as { items: Conversation[] };
    expect(page.items[0]?.unreadForAgent).toBe(0);
  });

  it('requires an agent', async () => {
    const { conversation } = await seedConversation();
    const res = await router(post(`/conversations/${conversation.id}/read`));
    expect(res.status).toBe(401);
  });

  it('will not clear a badge on another tenant', async () => {
    const { conversation } = await seedConversation();
    const otherAgent = { 'x-agent-id': 'agent-from-site-b' };
    const res = await router(post(`/conversations/${conversation.id}/read`, undefined, otherAgent));
    expect(res.status).toBe(401);
  });
});
