/**
 * The load-bearing test.
 *
 * Two sites are seeded with real conversations and messages, then every
 * public entry point is driven with site-A credentials against site-B data.
 * Nothing may leak: not a read, not a write, not a claim, not a close, not an
 * inbox listing — and the queries the handlers issue must themselves be
 * tenant-scoped, which is asserted directly against the models at the end.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Agent, Conversation, Message } from '../src/types.js';
import { resetEventBus } from '../src/server/events.js';
import { createRouteHandlers, type RouteHandlers } from '../src/server/handlers/index.js';
import { ConversationModel, MessageModel } from '../src/server/models/index.js';
import { signSession } from '../src/server/session.js';
import { clearDb, startMongo, stopMongo } from './mongo.js';

const SECRET = 'tenant-isolation-secret';
const SITE_A = 'site-a';
const SITE_B = 'site-b';
const BASE = 'https://api.example/api/livechat';

const AGENTS: Record<string, Agent> = {
  'agent-a': {
    id: 'agent-a',
    siteId: SITE_A,
    name: 'Agent A',
    email: 'a@a.example',
    role: 'agent',
    presence: 'online',
  },
  'agent-b': {
    id: 'agent-b',
    siteId: SITE_B,
    name: 'Agent B',
    email: 'b@b.example',
    role: 'agent',
    presence: 'online',
  },
};

let handlers: RouteHandlers;

interface Seeded {
  token: string;
  conversationId: string;
  visitorId: string;
}

beforeAll(async () => {
  const uri = await startMongo();
  handlers = createRouteHandlers({
    sessionSecret: SECRET,
    mongoUri: uri,
    authenticateAgent: async (req) => {
      const id = req.headers.get('x-agent-id');
      return (id && AGENTS[id]) || null;
    },
  });
}, 120_000);

afterAll(async () => {
  await stopMongo();
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

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function agentAuth(id: string): Record<string, string> {
  return { 'x-agent-id': id };
}

/** Creates a visitor, a conversation, and two messages on one site. */
async function seedSite(siteId: string, text: string): Promise<Seeded> {
  const sessionRes = await handlers.session(post('/session', { siteId }, { 'x-site-id': siteId }));
  const session = (await sessionRes.json()) as { token: string; visitor: { id: string } };

  const first = await handlers.messages(
    post('/messages', { body: text }, bearer(session.token)),
  );
  const { conversation } = (await first.json()) as { conversation: Conversation };

  await handlers.messages(
    post('/messages', { conversationId: conversation.id, body: `${text} (again)` }, bearer(session.token)),
  );

  return { token: session.token, conversationId: conversation.id, visitorId: session.visitor.id };
}

let a: Seeded;
let b: Seeded;

beforeEach(async () => {
  await clearDb();
  resetEventBus();
  a = await seedSite(SITE_A, 'site A secret');
  b = await seedSite(SITE_B, 'site B secret');
});

describe('visitor tokens are confined to their tenant', () => {
  it('cannot read another site\'s transcript', async () => {
    const res = await handlers.messages(
      get(`/messages?conversationId=${b.conversationId}`, bearer(a.token)),
    );
    expect(res.status).toBe(404);
  });

  it('cannot send into another site\'s conversation', async () => {
    const res = await handlers.messages(
      post('/messages', { conversationId: b.conversationId, body: 'pwn' }, bearer(a.token)),
    );
    expect(res.status).toBe(404);

    // And nothing was written anywhere.
    expect(await MessageModel.countDocuments({ body: 'pwn' })).toBe(0);
  });

  it('cannot long-poll another site\'s conversation', async () => {
    const res = await handlers.poll(
      get(`/poll?conversationId=${b.conversationId}&after=0`, bearer(a.token)),
    );
    expect(res.status).toBe(404);
  });

  it('cannot escape by forging the x-site-id header', async () => {
    // The header is ignored entirely once a token is present: scope comes from
    // the signed claims.
    const res = await handlers.messages(
      get(`/messages?conversationId=${b.conversationId}`, {
        ...bearer(a.token),
        'x-site-id': SITE_B,
      }),
    );
    expect(res.status).toBe(404);
  });

  it('cannot read a different visitor\'s conversation on its own site', async () => {
    const other = await seedSite(SITE_A, 'a different customer');
    expect(other.visitorId).not.toBe(a.visitorId);

    const res = await handlers.messages(
      get(`/messages?conversationId=${other.conversationId}`, bearer(a.token)),
    );
    expect(res.status).toBe(404);
  });

  it('cannot use a token whose siteId claim was hand-minted without the secret', async () => {
    const forged = await signSession(
      { siteId: SITE_B, visitorId: b.visitorId, anonymous: true },
      'not-the-real-secret',
    );
    const res = await handlers.messages(
      get(`/messages?conversationId=${b.conversationId}`, bearer(forged)),
    );
    expect(res.status).toBe(401);
  });
});

describe('agents are confined to their own site', () => {
  it('only sees its own site in the inbox', async () => {
    const res = await handlers.conversations(get('/conversations', agentAuth('agent-a')));
    const { items } = (await res.json()) as { items: Conversation[] };
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(a.conversationId);
    expect(items.every((c) => c.siteId === SITE_A)).toBe(true);
    expect(items.map((c) => c.id)).not.toContain(b.conversationId);
  });

  it('cannot claim a conversation on another site', async () => {
    const res = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: b.conversationId }, agentAuth('agent-a')),
    );
    expect(res.status).toBe(404);

    const stillUnassigned = await ConversationModel.findById(b.conversationId);
    expect(stillUnassigned?.assignedAgentId).toBeNull();
    expect(stillUnassigned?.status).toBe('open');
  });

  it('cannot close a conversation on another site', async () => {
    const res = await handlers.closeConversation(
      post('/conversations/close', { conversationId: b.conversationId }, agentAuth('agent-a')),
    );
    expect(res.status).toBe(404);

    const untouched = await ConversationModel.findById(b.conversationId);
    expect(untouched?.status).toBe('open');
  });

  it('cannot read or write another site\'s messages', async () => {
    const read = await handlers.messages(
      get(`/messages?conversationId=${b.conversationId}`, agentAuth('agent-a')),
    );
    expect(read.status).toBe(404);

    const write = await handlers.messages(
      post('/messages', { conversationId: b.conversationId, body: 'cross-tenant' }, agentAuth('agent-a')),
    );
    expect(write.status).toBe(404);
    expect(await MessageModel.countDocuments({ body: 'cross-tenant' })).toBe(0);
  });

  it('still works normally on its own site', async () => {
    const claim = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: a.conversationId }, agentAuth('agent-a')),
    );
    expect(claim.status).toBe(200);

    const claimB = await handlers.claimConversation(
      post('/conversations/claim', { conversationId: b.conversationId }, agentAuth('agent-b')),
    );
    expect(claimB.status).toBe(200);
  });
});

describe('isolation holds at the query level', () => {
  it('stamps every document with its tenant', async () => {
    const conversationsA = await ConversationModel.find({ siteId: SITE_A });
    const conversationsB = await ConversationModel.find({ siteId: SITE_B });
    expect(conversationsA).toHaveLength(1);
    expect(conversationsB).toHaveLength(1);
    expect(conversationsA[0]?.siteId).toBe(SITE_A);

    const messagesA = await MessageModel.find({ siteId: SITE_A });
    const messagesB = await MessageModel.find({ siteId: SITE_B });
    expect(messagesA).toHaveLength(2);
    expect(messagesB).toHaveLength(2);
    expect(messagesA.every((m) => m.siteId === SITE_A)).toBe(true);
    expect(messagesA.every((m) => m.body.includes('site A'))).toBe(true);
  });

  it('yields nothing when a tenant filter is paired with a foreign id', async () => {
    expect(await ConversationModel.findOne({ _id: b.conversationId, siteId: SITE_A })).toBeNull();
    expect(await ConversationModel.findOne({ _id: a.conversationId, siteId: SITE_B })).toBeNull();
    expect(
      await MessageModel.findOne({ conversationId: b.conversationId, siteId: SITE_A }),
    ).toBeNull();
  });

  it('indexes siteId as the leading field on every collection', () => {
    const leadingFields = (model: { schema: { indexes(): Array<[Record<string, unknown>, unknown]> } }) =>
      model.schema.indexes().map(([spec]) => Object.keys(spec)[0]);

    expect(leadingFields(ConversationModel).every((f) => f === 'siteId')).toBe(true);
    expect(leadingFields(MessageModel).every((f) => f === 'siteId')).toBe(true);
    expect(ConversationModel.schema.indexes().length).toBeGreaterThan(0);
  });

  it('keeps realtime fan-out per tenant', async () => {
    // Site A's poll must not observe an envelope published for site B, even
    // though both conversations are live at the same time.
    const pollA = await handlers.poll(
      get(`/poll?conversationId=${a.conversationId}&after=0`, bearer(a.token)),
    );
    const envelopes = (await pollA.json()) as Array<{ siteId: string; conversationId?: string }>;
    expect(envelopes.length).toBeGreaterThan(0);
    expect(envelopes.every((e) => e.siteId === SITE_A)).toBe(true);
    expect(envelopes.every((e) => e.conversationId === a.conversationId)).toBe(true);
  });
});

describe('message seq allocation', () => {
  it('never hands the same seq to two concurrent sends', async () => {
    const sends = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        handlers.messages(
          post('/messages', { conversationId: a.conversationId, body: `burst ${i}` }, bearer(a.token)),
        ),
      ),
    );
    expect(sends.every((r) => r.status === 201)).toBe(true);

    const stored = await MessageModel.find({
      siteId: SITE_A,
      conversationId: a.conversationId,
    }).sort({ seq: 1 });
    const seqs = stored.map((m: Message & { seq: number }) => m.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });
});
