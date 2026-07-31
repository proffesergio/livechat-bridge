/**
 * `ChatTransport` state-machine tests.
 *
 * These run in plain Node — no jsdom, no testing-library. The transport takes
 * `WebSocket` and `fetch` as constructor options precisely so the whole
 * WS ⇄ long-poll handover can be driven by hand here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTransport } from '../src/widget/transport.js';
import type { RealtimeEnvelope } from '../src/types.js';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

class FakeSocket {
  static instances: FakeSocket[] = [];
  /** Set by a test to make the constructor itself blow up. */
  static throwOnConstruct = false;

  readyState = 0;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    if (FakeSocket.throwOnConstruct) throw new Error('WebSocket blocked');
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(envelope: unknown): void {
    this.onmessage?.({ data: JSON.stringify(envelope) });
  }

  /** Simulate the peer dropping the connection. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  static reset(): void {
    FakeSocket.instances = [];
    FakeSocket.throwOnConstruct = false;
  }

  static get last(): FakeSocket {
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!socket) throw new Error('no socket was constructed');
    return socket;
  }
}

interface PollCall {
  url: string;
  signal: AbortSignal | undefined;
  resolve: (envelopes: RealtimeEnvelope[]) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

/** A `fetch` whose `/poll` responses each test resolves manually. */
function makeFetch(): { fetch: (url: string, init?: any) => Promise<any>; polls: PollCall[] } {
  const polls: PollCall[] = [];
  const fetchImpl = (url: string, init?: any): Promise<any> =>
    new Promise((resolveOuter, rejectOuter) => {
      const call: PollCall = {
        url,
        signal: init?.signal,
        settled: false,
        resolve: (envelopes) => {
          if (call.settled) return;
          call.settled = true;
          resolveOuter({ ok: true, status: 200, json: async () => ({ events: envelopes }) });
        },
        reject: (error) => {
          if (call.settled) return;
          call.settled = true;
          rejectOuter(error);
        },
      };
      polls.push(call);
      init?.signal?.addEventListener?.('abort', () => {
        if (call.settled) return;
        call.settled = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        rejectOuter(err);
      });
    });
  return { fetch: fetchImpl, polls };
}

function envelope(seq: number, body: string): RealtimeEnvelope<'message:new'> {
  return {
    event: 'message:new',
    siteId: 'site_1',
    conversationId: 'conv_1',
    seq,
    at: new Date(seq * 1000).toISOString(),
    data: {
      message: {
        id: `m_${seq}`,
        siteId: 'site_1',
        conversationId: 'conv_1',
        senderType: 'agent',
        body,
        createdAt: new Date(seq * 1000).toISOString(),
      },
    },
  };
}

/** Deterministic backoff: equal jitter with `random() === 0.5` ⇒ 0.75 × delay. */
function build(overrides: Partial<ConstructorParameters<typeof ChatTransport>[0]> = {}) {
  const { fetch, polls } = makeFetch();
  const transport = new ChatTransport({
    baseUrl: 'https://example.test/api/livechat',
    socketUrl: 'wss://example.test/ws',
    token: 'tok_123',
    conversationId: 'conv_1',
    baseBackoffMs: 500,
    maxBackoffMs: 30_000,
    pollIdleDelayMs: 1_000,
    pollTimeoutMs: 25_000,
    healthyAfterMs: 10_000,
    WebSocketImpl: FakeSocket as never,
    fetchImpl: fetch as never,
    random: () => 0.5,
    ...overrides,
  });
  const received: RealtimeEnvelope[] = [];
  const states: string[] = [];
  transport.onAny((env) => received.push(env));
  transport.onStateChange((state) => states.push(state));
  return { transport, polls, received, states };
}

/* -------------------------------------------------------------------------- */

describe('ChatTransport', () => {
  beforeEach(() => {
    FakeSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects over WebSocket and emits parsed envelopes', async () => {
    const { transport, polls, received, states } = build();
    transport.connect();

    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.last.url).toContain('token=tok_123');
    expect(states).toEqual(['connecting']);

    FakeSocket.last.open();
    expect(transport.getState()).toBe('open');
    // While the socket is healthy the HTTP fallback stays untouched.
    expect(polls).toHaveLength(0);

    FakeSocket.last.deliver(envelope(1, 'hello'));
    FakeSocket.last.deliver(envelope(2, 'again'));

    expect(received.map((e) => e.seq)).toEqual([1, 2]);
    expect((received[0] as RealtimeEnvelope<'message:new'>).data.message.body).toBe('hello');
    expect(transport.getCursor()).toBe(2);

    transport.close();
  });

  it('falls back to long-poll when the WebSocket constructor throws', async () => {
    FakeSocket.throwOnConstruct = true;
    const { transport, polls, received } = build();
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.getState()).toBe('polling');
    expect(polls).toHaveLength(1);
    expect(polls[0]!.url).toContain('/poll?conversationId=conv_1&after=0');

    polls[0]!.resolve([envelope(1, 'via poll')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(received.map((e) => e.seq)).toEqual([1]);
    expect(polls[1]!.url).toContain('after=1');

    transport.close();
  });

  it('falls back to long-poll when the socket closes before it opens', async () => {
    const { transport, polls, states } = build();
    transport.connect();

    FakeSocket.last.drop(1006);
    await vi.advanceTimersByTimeAsync(0);

    expect(states).toEqual(['connecting', 'polling']);
    expect(polls).toHaveLength(1);

    transport.close();
  });

  it('reconnects with increasing backoff after an unexpected close, and stops after close()', async () => {
    const { transport } = build();
    transport.connect();
    expect(FakeSocket.instances).toHaveLength(1);

    // Attempt 1 → 500 × 0.75 = 375ms.
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(374);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);

    // Attempt 2 → 1000 × 0.75 = 750ms.
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(749);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // Attempt 3 → 2000 × 0.75 = 1500ms.
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(1499);
    expect(FakeSocket.instances).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(4);

    // A socket that stays up past `healthyAfterMs` forgives the backoff, so the
    // next flap starts from the floor again rather than at 4s.
    FakeSocket.last.open();
    await vi.advanceTimersByTimeAsync(11_000);
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(374);
    expect(FakeSocket.instances).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(5);

    transport.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(5);
    expect(transport.getState()).toBe('closed');
  });

  it('resumes from the last seq and never re-emits a seen envelope', async () => {
    const { transport, polls, received } = build();
    transport.connect();
    FakeSocket.last.open();
    FakeSocket.last.deliver(envelope(1, 'one'));
    FakeSocket.last.deliver(envelope(2, 'two'));
    expect(received.map((e) => e.seq)).toEqual([1, 2]);

    // Socket dies: the poll fallback must pick up at the cursor, not at zero.
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(polls).toHaveLength(1);
    expect(polls[0]!.url).toContain('after=2');

    // The server replays the tail it is not sure we got, plus one new event.
    polls[0]!.resolve([envelope(1, 'one'), envelope(2, 'two'), envelope(3, 'three')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);

    // Socket comes back and announces the same cursor in its resume frame.
    await vi.advanceTimersByTimeAsync(400);
    expect(FakeSocket.instances).toHaveLength(2);
    const revived = FakeSocket.last;
    expect(revived.url).toContain('after=3');
    revived.open();
    expect(JSON.parse(revived.sent[0]!)).toMatchObject({
      type: 'resume',
      conversationId: 'conv_1',
      after: 3,
    });

    // Replayed envelopes on the new socket are dropped; only seq 4 is new.
    revived.deliver(envelope(2, 'two'));
    revived.deliver(envelope(3, 'three'));
    revived.deliver(envelope(4, 'four'));
    expect(received.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    transport.close();
  });

  it('stops polling once the socket comes back up', async () => {
    const { transport, polls } = build();
    transport.connect();
    FakeSocket.last.drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.getState()).toBe('polling');

    await vi.advanceTimersByTimeAsync(400);
    FakeSocket.last.open();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.getState()).toBe('open');
    expect(polls[0]!.signal?.aborted).toBe(true);

    transport.close();
  });

  it('close() aborts the in-flight poll and leaves no pending timers', async () => {
    const { transport, polls, received } = build({ socketUrl: undefined });
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.getState()).toBe('polling');
    expect(polls).toHaveLength(1);

    transport.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(polls[0]!.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    // A late server response after close() must not resurrect the loop.
    polls[0]!.resolve([envelope(9, 'too late')]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(received).toHaveLength(0);
    expect(polls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('paces the poll loop when the server answers empty immediately', async () => {
    const { transport, polls } = build({ socketUrl: undefined });
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);

    polls[0]!.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    // No hot loop: the next request waits for the idle floor.
    expect(polls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(polls).toHaveLength(2);

    transport.close();
  });
});
