import { describe, expect, it, vi } from 'vitest';
import { InMemoryPubSub, SSETransport, isSubscribable } from '../src/server/index.js';
import { FakeTransport } from './fakes.js';

describe('SSETransport', () => {
  it('publishes triggers onto its pub/sub backend', async () => {
    const pubsub = new InMemoryPubSub();
    const transport = new SSETransport({ pubsub });
    const listener = vi.fn();
    pubsub.subscribe('private-chat-1', listener);

    await transport.trigger('private-chat-1', 'message:new', { id: 'm1' });

    expect(listener).toHaveBeenCalledWith('message:new', { id: 'm1' });
  });

  it('subscribe() forwards to the backend and is removable', async () => {
    const transport = new SSETransport();
    const listener = vi.fn();
    const off = transport.subscribe('c', listener);

    await transport.trigger('c', 'evt', 1);
    off();
    await transport.trigger('c', 'evt', 2);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('evt', 1);
  });

  it('authorizeChannel is a no-op (auth happens on the stream request)', () => {
    const transport = new SSETransport();
    expect(transport.authorizeChannel('socket', 'private-chat-1')).toEqual({});
  });

  it('is recognized as subscribable; Pusher-style transports are not', () => {
    expect(isSubscribable(new SSETransport())).toBe(true);
    expect(isSubscribable(new FakeTransport())).toBe(false);
  });
});
