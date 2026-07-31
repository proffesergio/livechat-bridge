import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS,
  STAFF_CHANNEL,
  chatChannel,
  createLiveChatBridge,
  handleStream,
  MemoryStorage,
  SSETransport,
  type LiveChatBridge,
} from '../src/server/index.js';
import { FakeTransport, makeViewer } from './fakes.js';

const user = makeViewer({ id: 'u1', name: 'Alice', isStaff: false });

function streamRequest(channel: string | null, signal?: AbortSignal): Request {
  const url = channel
    ? `http://test.local/api/livechat/stream?channel=${encodeURIComponent(channel)}`
    : `http://test.local/api/livechat/stream`;
  return new Request(url, { signal });
}

/** Read chunks until `needle` appears or we run out of reads. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  maxReads = 5
): Promise<string> {
  const decoder = new TextDecoder();
  let acc = '';
  for (let i = 0; i < maxReads; i++) {
    const { value, done } = await reader.read();
    if (value) acc += decoder.decode(value);
    if (acc.includes(needle)) return acc;
    if (done) break;
  }
  return acc;
}

describe('handleStream (SSE)', () => {
  const controllers: AbortController[] = [];
  afterEach(() => {
    for (const c of controllers) c.abort();
    controllers.length = 0;
  });

  function bridgeWithChat(): { bridge: LiveChatBridge; transport: SSETransport } {
    const transport = new SSETransport();
    const bridge = createLiveChatBridge({
      storage: new MemoryStorage(),
      transport,
      getViewer: () => user,
    });
    return { bridge, transport };
  }

  it('rejects a request with no channel (400)', async () => {
    const { bridge } = bridgeWithChat();
    const res = await handleStream(bridge, streamRequest(null));
    expect(res.status).toBe(400);
  });

  it("rejects a channel the viewer can't access (401)", async () => {
    const { bridge } = bridgeWithChat();
    // u1 is not staff → cannot subscribe to the staff channel.
    const res = await handleStream(bridge, streamRequest(STAFF_CHANNEL));
    expect(res.status).toBe(401);
  });

  it('500s when the transport cannot stream', async () => {
    const bridge = createLiveChatBridge({
      storage: new MemoryStorage(),
      transport: new FakeTransport(),
      getViewer: () => user,
    });
    const msg = await bridge.sendMessage(streamRequest(null), { body: 'hi' });
    const res = await handleStream(bridge, streamRequest(chatChannel(msg.chatId)));
    expect(res.status).toBe(500);
  });

  it('opens an event-stream and forwards triggered events', async () => {
    const { bridge, transport } = bridgeWithChat();
    const msg = await bridge.sendMessage(streamRequest(null), { body: 'hi' });
    const channel = chatChannel(msg.chatId);

    const ac = new AbortController();
    controllers.push(ac);
    const res = await handleStream(bridge, streamRequest(channel, ac.signal));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const opening = await readUntil(reader, 'connected');
    expect(opening).toContain('retry: 3000');

    await transport.trigger(channel, EVENTS.MESSAGE_NEW, { message: { id: 'm2' } });
    const frame = await readUntil(reader, 'message:new');
    expect(frame).toContain('event: message:new');
    expect(frame).toContain('"id":"m2"');

    await reader.cancel();
  });
});
