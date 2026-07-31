/**
 * Full-flow integration test. Hits the Web `Request`/`Response` route handlers
 * the same way Next.js does — no shortcuts through the bridge — so we catch
 * the handler/bridge/storage/transport wiring as a whole.
 *
 * Covers: viewer lookup, sending the first message, AI fallback firing,
 * staff claim cancelling the fallback, staff reply, chat close, and SSE
 * stream framing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_STATUS,
  EVENTS,
  STAFF_CHANNEL,
  chatChannel,
  createLiveChatBridge,
  MemoryStorage,
  SSETransport,
  type LiveChatBridge,
} from '../src/server/index.js';
import { createRouteHandlers } from '../src/server/nextjs.js';
import { FakeAi } from './fakes.js';

interface TestViewer {
  id: string;
  name: string;
  email?: string;
  isStaff: boolean;
}

const ALICE: TestViewer = { id: 'u1', name: 'Alice', email: 'a@x', isStaff: false };
const MALLORY: TestViewer = { id: 'u2', name: 'Mallory', isStaff: false };
const STAFF: TestViewer = { id: 's1', name: 'Bob', isStaff: true };

/**
 * Build a Request whose viewer is encoded into a custom header. The bridge's
 * `getViewer` reads this header back out — exactly the integration shape the
 * Next.js routes use, just with a deterministic auth stand-in.
 */
function authedRequest(url: string, viewer: TestViewer | null, init?: RequestInit): Request {
  const headers = new Headers(init?.headers);
  if (viewer) headers.set('x-test-viewer', JSON.stringify(viewer));
  return new Request(url, { ...init, headers });
}

function jsonRequest(url: string, viewer: TestViewer | null, body: unknown): Request {
  return authedRequest(url, viewer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildBridge(opts: { aiFallbackMs?: number } = {}): {
  bridge: LiveChatBridge;
  handlers: ReturnType<typeof createRouteHandlers>;
  ai: FakeAi;
  transport: SSETransport;
} {
  const transport = new SSETransport();
  const ai = new FakeAi('Hi! I’m the demo assistant.');
  const bridge = createLiveChatBridge({
    storage: new MemoryStorage(),
    transport,
    ai,
    aiFallbackMs: opts.aiFallbackMs ?? 30_000,
    getViewer: (req) => {
      const header = req.headers.get('x-test-viewer');
      if (!header) return null;
      return JSON.parse(header) as TestViewer;
    },
  });
  return { bridge, handlers: createRouteHandlers(bridge), ai, transport };
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('integration — Next.js route handlers', () => {
  describe('viewer endpoint', () => {
    it('returns the viewer when signed in', async () => {
      const { handlers } = buildBridge();
      const res = await handlers.viewer(authedRequest('http://t/me', ALICE));
      expect(res.status).toBe(200);
      const body = await readJson<{ viewer: TestViewer }>(res);
      expect(body.viewer.id).toBe('u1');
    });

    it('401s for unauthenticated callers', async () => {
      const { handlers } = buildBridge();
      const res = await handlers.viewer(authedRequest('http://t/me', null));
      expect(res.status).toBe(401);
    });
  });

  describe('happy-path lifecycle: send → claim → reply → close', () => {
    it('moves a chat from open → claimed → closed', async () => {
      const { handlers } = buildBridge();

      const send = await handlers.sendMessage(
        jsonRequest('http://t/messages', ALICE, { body: 'I need help' })
      );
      expect(send.status).toBe(200);
      const { message } = await readJson<{ message: { chatId: string; senderType: string } }>(send);
      expect(message.senderType).toBe('user');

      const open = await handlers.listChats(
        authedRequest('http://t/chats?status=open', STAFF)
      );
      expect(open.status).toBe(200);
      const list = await readJson<{ chats: Array<{ id: string }> }>(open);
      expect(list.chats.map((c) => c.id)).toContain(message.chatId);

      const claim = await handlers.claimChat(
        jsonRequest(`http://t/chats/${message.chatId}/claim`, STAFF, {}),
        { params: { id: message.chatId } }
      );
      expect(claim.status).toBe(200);
      const claimed = await readJson<{ chat: { status: string; assignedStaffId: string } }>(claim);
      expect(claimed.chat.status).toBe(CHAT_STATUS.CLAIMED);
      expect(claimed.chat.assignedStaffId).toBe('s1');

      const staffReply = await handlers.sendMessage(
        jsonRequest('http://t/messages', STAFF, { chatId: message.chatId, body: 'On it.' })
      );
      expect(staffReply.status).toBe(200);

      const messages = await handlers.listMessages(
        authedRequest(`http://t/chats/${message.chatId}/messages`, STAFF),
        { params: { id: message.chatId } }
      );
      const { messages: msgs } = await readJson<{ messages: Array<{ senderType: string }> }>(messages);
      expect(msgs.map((m) => m.senderType)).toEqual(['user', 'staff']);

      const close = await handlers.closeChat(
        jsonRequest(`http://t/chats/${message.chatId}/close`, STAFF, {}),
        { params: { id: message.chatId } }
      );
      const closed = await readJson<{ chat: { status: string } }>(close);
      expect(closed.chat.status).toBe(CHAT_STATUS.CLOSED);
    });
  });

  describe('AI fallback flow', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('fires after the grace window when no one claims', async () => {
      const { handlers, ai, bridge } = buildBridge({ aiFallbackMs: 1_000 });

      const send = await handlers.sendMessage(
        jsonRequest('http://t/messages', ALICE, { body: 'hello?' })
      );
      const { message } = await readJson<{ message: { chatId: string } }>(send);

      expect(ai.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.runOnlyPendingTimersAsync();

      expect(ai.calls).toHaveLength(1);
      const list = await handlers.listChats(
        authedRequest('http://t/chats?status=ai', STAFF)
      );
      const { chats } = await readJson<{ chats: Array<{ id: string }> }>(list);
      expect(chats.map((c) => c.id)).toContain(message.chatId);
      bridge._scheduler.reset();
    });

    it('does not fire when staff claims first', async () => {
      const { handlers, ai, bridge } = buildBridge({ aiFallbackMs: 1_000 });

      const { message } = await readJson<{ message: { chatId: string } }>(
        await handlers.sendMessage(jsonRequest('http://t/messages', ALICE, { body: 'hi' }))
      );
      await handlers.claimChat(
        jsonRequest(`http://t/chats/${message.chatId}/claim`, STAFF, {}),
        { params: { id: message.chatId } }
      );

      await vi.advanceTimersByTimeAsync(5_000);
      await vi.runOnlyPendingTimersAsync();
      expect(ai.calls).toHaveLength(0);
      bridge._scheduler.reset();
    });
  });

  describe('authorization', () => {
    it('rejects send with no session (401)', async () => {
      const { handlers } = buildBridge();
      const res = await handlers.sendMessage(
        jsonRequest('http://t/messages', null, { body: 'hi' })
      );
      expect(res.status).toBe(401);
    });

    it("rejects another customer reading someone else's chat (401)", async () => {
      const { handlers } = buildBridge();
      const { message } = await readJson<{ message: { chatId: string } }>(
        await handlers.sendMessage(jsonRequest('http://t/messages', ALICE, { body: 'hi' }))
      );
      const res = await handlers.listMessages(
        authedRequest(`http://t/chats/${message.chatId}/messages`, MALLORY),
        { params: { id: message.chatId } }
      );
      expect(res.status).toBe(401);
    });

    it('rejects non-staff trying to list chats (401)', async () => {
      const { handlers } = buildBridge();
      const res = await handlers.listChats(
        authedRequest('http://t/chats?status=open', ALICE)
      );
      expect(res.status).toBe(401);
    });

    it('rejects non-staff trying to claim (401)', async () => {
      const { handlers } = buildBridge();
      const { message } = await readJson<{ message: { chatId: string } }>(
        await handlers.sendMessage(jsonRequest('http://t/messages', ALICE, { body: 'hi' }))
      );
      const res = await handlers.claimChat(
        jsonRequest(`http://t/chats/${message.chatId}/claim`, MALLORY, {}),
        { params: { id: message.chatId } }
      );
      expect(res.status).toBe(401);
    });

    it('rejects unauthorized stream subscription (401)', async () => {
      const { handlers } = buildBridge();
      const res = await handlers.stream(
        authedRequest(`http://t/stream?channel=${encodeURIComponent(STAFF_CHANNEL)}`, ALICE)
      );
      expect(res.status).toBe(401);
    });
  });

  describe('SSE stream end-to-end', () => {
    it('delivers a triggered event over the stream', async () => {
      const { handlers, bridge, transport } = buildBridge();

      const { message } = await readJson<{ message: { chatId: string } }>(
        await handlers.sendMessage(jsonRequest('http://t/messages', ALICE, { body: 'hi' }))
      );
      const channel = chatChannel(message.chatId);

      const ac = new AbortController();
      const res = await handlers.stream(
        authedRequest(`http://t/stream?channel=${encodeURIComponent(channel)}`, ALICE, {
          signal: ac.signal,
        })
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const readUntil = async (needle: string): Promise<string> => {
        let acc = '';
        for (let i = 0; i < 5; i++) {
          const { value, done } = await reader.read();
          if (value) acc += decoder.decode(value);
          if (acc.includes(needle)) return acc;
          if (done) break;
        }
        return acc;
      };

      const opening = await readUntil('connected');
      expect(opening).toContain('retry:');

      await transport.trigger(channel, EVENTS.MESSAGE_NEW, { message: { id: 'm2' } });
      const frame = await readUntil('message:new');
      expect(frame).toContain('"id":"m2"');

      ac.abort();
      await reader.cancel();
      bridge._scheduler.reset();
    });
  });
});
