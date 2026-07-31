import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Agent, Conversation, Message, RealtimeEnvelope } from '../src/types.js';
import { resetEventBus } from '../src/server/events.js';
import { createRouteHandlers, type RouteHandlers } from '../src/server/handlers/index.js';
import { signIdentityHmac, verifySession } from '../src/server/session.js';
import { clearDb, startMongo, stopMongo } from './mongo.js';

const SECRET = 'handlers-test-secret';
const SITE = 'site-a';
const ORIGIN = 'https://shop.example';
const BASE = 'https://api.example/api/livechat';

const AGENTS: Record<string, Agent> = {
  'agent-1': {
    id: 'agent-1',
    siteId: SITE,
    name: 'Ada',
    email: 'ada@example.com',
    role: 'agent',
    presence: 'online',
  },
  'agent-2': {
    id: 'agent-2',
    siteId: SITE,
    name: 'Grace',
    email: 'grace@example.com',
    role: 'agent',
    presence: 'online',
  },
};

let handlers: RouteHandlers;

beforeAll(async () => {
  const uri = await startMongo();
  handlers = createRouteHandlers({
    sessionSecret: SECRET,
    mongoUri: uri,
    allowedOrigins: [ORIGIN],
    authenticateAgent: async (req) => {
      const id = req.headers.get('x-agent-id');
      return (id && AGENTS[id]) || null;
    },
  });
}, 120_000);

afterAll(async () => {
  await stopMongo();
});

beforeEach(async () => {
  await clearDb();
  resetEventBus();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${BASE}${path}`, { method: 'GET', headers });
}

function visitorAuth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function agentAuth(id: string): Record<string, string> {
  return { 'x-agent-id': id };
}

async function createSession(siteId = SITE): Promise<string> {
  const res = await handlers.session(post('/session', { siteId }, { 'x-site-id': siteId }));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { token: string };
  return json.token;
}

describe('end-to-end chat flow', () => {
  it('runs session → send → list → claim → reply → close', async () => {
    /* 1. Visitor session ---------------------------------------------------- */
    const sessionRes = await handlers.session(
      post('/session', { siteId: SITE }, { 'x-site-id': SITE }),
    );
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      token: string;
      visitor: { id: string; anonymous: boolean; siteId: string };
      conversation?: Conversation;
    };
    expect(session.visitor.anonymous).toBe(true);
    expect(session.visitor.siteId).toBe(SITE);
    expect(session.conversation).toBeUndefined();

    /* 2. First message creates the conversation ----------------------------- */
    const sendRes = await handlers.messages(
      post('/messages', { body: 'my order never arrived', clientId: 'c1' }, visitorAuth(session.token)),
    );
    expect(sendRes.status).toBe(201);
    const sent = (await sendRes.json()) as { message: Message; conversation: Conversation };
    expect(sent.message.senderType).toBe('visitor');
    expect(sent.message.clientId).toBe('c1');
    expect(sent.conversation.status).toBe('open');
    expect(sent.conversation.unreadForAgent).toBe(1);
    expect(sent.conversation.lastMessagePreview).toBe('my order never arrived');
    const conversationId = sent.conversation.id;

    /* 3. Visitor reads the transcript --------------------------------------- */
    const listRes = await handlers.messages(
      get(`/messages?conversationId=${conversationId}`, visitorAuth(session.token)),
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { items: Message[]; hasMore: boolean };
    expect(list.items).toHaveLength(1);
    expect(list.hasMore).toBe(false);
    expect(list.items[0]?.body).toBe('my order never arrived');

    /* 4. Agent sees it in the inbox ----------------------------------------- */
    const inboxRes = await handlers.conversations(
      get('/conversations?status=open', agentAuth('agent-1')),
    );
    expect(inboxRes.status).toBe(200);
    const inbox = (await inboxRes.json()) as { items: Conversation[] };
    expect(inbox.items.map((c) => c.id)).toContain(conversationId);

    /* 5. Agent claims ------------------------------------------------------- */
    const claimRes = await handlers.claimConversation(
      post('/conversations/claim', { conversationId }, agentAuth('agent-1')),
    );
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { conversation: Conversation };
    expect(claimed.conversation.status).toBe('assigned');
    expect(claimed.conversation.assignedAgentId).toBe('agent-1');
    expect(claimed.conversation.unreadForAgent).toBe(0);

    /* 6. Agent replies ------------------------------------------------------ */
    const replyRes = await handlers.messages(
      post('/messages', { conversationId, body: 'Sorry! Refunding now.' }, agentAuth('agent-1')),
    );
    expect(replyRes.status).toBe(201);
    const reply = (await replyRes.json()) as { message: Message };
    expect(reply.message.senderType).toBe('agent');
    expect(reply.message.senderId).toBe('agent-1');
    expect(reply.message.senderName).toBe('Ada');

    /* Cursor paging: only the agent reply is newer than seq 1 --------------- */
    const afterRes = await handlers.messages(
      get(`/messages?conversationId=${conversationId}&after=1`, visitorAuth(session.token)),
    );
    const after = (await afterRes.json()) as { items: Message[] };
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.senderType).toBe('agent');

    /* 7. Agent closes ------------------------------------------------------- */
    const closeRes = await handlers.closeConversation(
      post('/conversations/close', { conversationId }, agentAuth('agent-1')),
    );
    expect(closeRes.status).toBe(200);
    const closed = (await closeRes.json()) as { conversation: Conversation };
    expect(closed.conversation.status).toBe('closed');

    /* A closed chat rejects further sends ----------------------------------- */
    const afterClose = await handlers.messages(
      post('/messages', { conversationId, body: 'hello?' }, visitorAuth(session.token)),
    );
    expect(afterClose.status).toBe(409);
  });

  it('resumes an existing session and returns the open conversation', async () => {
    const token = await createSession();
    const send = await handlers.messages(
      post('/messages', { body: 'hi' }, visitorAuth(token)),
    );
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const resumed = await handlers.session(
      post('/session', { siteId: SITE }, { 'x-site-id': SITE, ...visitorAuth(token) }),
    );
    const body = (await resumed.json()) as { visitor: { id: string }; conversation?: Conversation };
    expect(body.conversation?.id).toBe(conversation.id);
  });
});

describe('concurrent claim', () => {
  it('lets exactly one of two agents win', async () => {
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'help' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const [a, b] = await Promise.all([
      handlers.claimConversation(
        post('/conversations/claim', { conversationId: conversation.id }, agentAuth('agent-1')),
      ),
      handlers.claimConversation(
        post('/conversations/claim', { conversationId: conversation.id }, agentAuth('agent-2')),
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const { conversation: won } = (await winner.json()) as { conversation: Conversation };
    expect(['agent-1', 'agent-2']).toContain(won.assignedAgentId);

    // And the loser cannot steal it afterwards.
    const loserId = won.assignedAgentId === 'agent-1' ? 'agent-2' : 'agent-1';
    const retry = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: conversation.id }, agentAuth(loserId)),
    );
    expect(retry.status).toBe(409);
  });

  it('is idempotent for the agent that already owns the chat', async () => {
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'help' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const first = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: conversation.id }, agentAuth('agent-1')),
    );
    const second = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: conversation.id }, agentAuth('agent-1')),
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });
});

describe('long-poll', () => {
  it('replays buffered envelopes newer than the cursor', async () => {
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'first' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const res = await handlers.poll(
      get(`/poll?conversationId=${conversation.id}&after=0`, visitorAuth(token)),
    );
    expect(res.status).toBe(200);
    const envelopes = (await res.json()) as RealtimeEnvelope[];
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.event).toBe('message:new');
    expect(envelopes[0]?.siteId).toBe(SITE);
    expect(envelopes[0]?.seq).toBe(1);
  });

  it('wakes a parked poll when a message is published', async () => {
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'first' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const pending = handlers.poll(
      get(`/poll?conversationId=${conversation.id}&after=1`, visitorAuth(token)),
    );

    // Give the poll a tick to park, then publish by sending an agent reply.
    await new Promise((r) => setTimeout(r, 20));
    await handlers.messages(
      post('/messages', { conversationId: conversation.id, body: 'on it' }, agentAuth('agent-1')),
    );

    const envelopes = (await (await pending).json()) as RealtimeEnvelope[];
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.seq).toBe(2);
  });

  it('returns an empty array when the hold time expires', async () => {
    // The db connection is already cached on globalThis, so this second handler
    // set needs no URI — it exists only to shorten the hold time.
    const quick = createRouteHandlers({
      sessionSecret: SECRET,
      pollTimeoutMs: 40,
      authenticateAgent: async () => null,
    });
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'first' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const res = await quick.poll(
      get(`/poll?conversationId=${conversation.id}&after=99`, visitorAuth(token)),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('cleans up when the client aborts', async () => {
    const token = await createSession();
    const send = await handlers.messages(post('/messages', { body: 'first' }, visitorAuth(token)));
    const { conversation } = (await send.json()) as { conversation: Conversation };

    const controller = new AbortController();
    const req = new Request(
      `${BASE}/poll?conversationId=${conversation.id}&after=99`,
      { method: 'GET', headers: visitorAuth(token), signal: controller.signal },
    );
    const pending = handlers.poll(req);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    expect(await (await pending).json()).toEqual([]);
  });
});

describe('CORS', () => {
  it('reflects an allow-listed origin with credentials', async () => {
    const res = await handlers.session(
      post('/session', { siteId: SITE }, { 'x-site-id': SITE, origin: ORIGIN }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('never echoes an unknown origin', async () => {
    const res = await handlers.session(
      post('/session', { siteId: SITE }, { 'x-site-id': SITE, origin: 'https://evil.example' }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects preflight from an unknown origin', async () => {
    const res = await handlers.options(
      new Request(`${BASE}/messages`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.status).toBe(403);

    const ok = await handlers.options(
      new Request(`${BASE}/messages`, { method: 'OPTIONS', headers: { origin: ORIGIN } }),
    );
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('input validation', () => {
  it('rejects unauthenticated message traffic', async () => {
    const res = await handlers.messages(post('/messages', { body: 'hi' }));
    expect(res.status).toBe(401);
  });

  it('rejects agent endpoints without an agent', async () => {
    const res = await handlers.conversations(get('/conversations'));
    expect(res.status).toBe(401);
  });

  it('rejects an empty message body', async () => {
    const token = await createSession();
    const res = await handlers.messages(post('/messages', { body: '   ' }, visitorAuth(token)));
    expect(res.status).toBe(400);
  });

  it('turns a malformed conversation id into a 404, not a 500', async () => {
    const token = await createSession();
    const res = await handlers.messages(
      post('/messages', { conversationId: 'not-an-object-id', body: 'hi' }, visitorAuth(token)),
    );
    expect(res.status).toBe(404);
  });

  it('refuses an identity that is not signed by the host', async () => {
    const res = await handlers.session(
      post(
        '/session',
        { siteId: SITE, identity: { id: 'user-1', name: 'Mallory' }, identityHmac: 'deadbeef' },
        { 'x-site-id': SITE },
      ),
    );
    expect(res.status).toBe(403);
  });

  it('refuses an identity with no signature at all', async () => {
    const res = await handlers.session(
      post('/session', { siteId: SITE, identity: { id: 'user-1' } }, { 'x-site-id': SITE }),
    );
    expect(res.status).toBe(403);
  });

  it('accepts a correctly signed identity and marks the visitor non-anonymous', async () => {
    const identityHmac = await signIdentityHmac(SITE, 'user-1', SECRET);
    const res = await handlers.session(
      post(
        '/session',
        {
          siteId: SITE,
          identity: { id: 'user-1', name: 'Ada L.', email: 'ada@customer.example' },
          identityHmac,
        },
        { 'x-site-id': SITE },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      visitor: { id: string; anonymous: boolean; name?: string };
    };
    expect(body.visitor.anonymous).toBe(false);
    expect(body.visitor.name).toBe('Ada L.');

    const claims = await verifySession(body.token, SECRET);
    expect(claims?.anonymous).toBe(false);
    expect(claims?.visitorId).toBe('u:user-1');
  });
});
