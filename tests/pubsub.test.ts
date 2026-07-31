import { describe, expect, it, vi } from 'vitest';
import { InMemoryPubSub } from '../src/server/index.js';

describe('InMemoryPubSub', () => {
  it('delivers events to subscribers of the same channel', async () => {
    const ps = new InMemoryPubSub();
    const a = vi.fn();
    const b = vi.fn();
    ps.subscribe('chan', a);
    ps.subscribe('chan', b);

    await ps.publish('chan', 'message:new', { id: 'm1' });

    expect(a).toHaveBeenCalledWith('message:new', { id: 'm1' });
    expect(b).toHaveBeenCalledWith('message:new', { id: 'm1' });
  });

  it('isolates channels', async () => {
    const ps = new InMemoryPubSub();
    const listener = vi.fn();
    ps.subscribe('chan-a', listener);

    await ps.publish('chan-b', 'evt', {});

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe', async () => {
    const ps = new InMemoryPubSub();
    const listener = vi.fn();
    const off = ps.subscribe('chan', listener);

    off();
    await ps.publish('chan', 'evt', {});

    expect(listener).not.toHaveBeenCalled();
  });

  it('tolerates a listener unsubscribing during dispatch', async () => {
    const ps = new InMemoryPubSub();
    const calls: string[] = [];
    const off1 = ps.subscribe('chan', () => {
      calls.push('first');
      off1(); // remove self mid-dispatch
    });
    ps.subscribe('chan', () => calls.push('second'));

    await ps.publish('chan', 'evt', {});

    expect(calls).toEqual(['first', 'second']);
  });
});
