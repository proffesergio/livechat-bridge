import type { PubSub } from './types.js';

type Listener = (event: string, payload: unknown) => void;

/**
 * In-process pub/sub. Correct for a single Node instance (most deployments to
 * start). For horizontally-scaled deployments use a Redis-backed `PubSub` so
 * events fan out across instances.
 */
export class InMemoryPubSub implements PubSub {
  private readonly channels = new Map<string, Set<Listener>>();

  async publish(channel: string, event: string, payload: unknown): Promise<void> {
    const listeners = this.channels.get(channel);
    if (!listeners) return;
    // Copy first — a listener may unsubscribe during dispatch.
    for (const listener of [...listeners]) listener(event, payload);
  }

  subscribe(channel: string, listener: Listener): () => void {
    let listeners = this.channels.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.channels.set(channel, listeners);
    }
    listeners.add(listener);
    return () => {
      const set = this.channels.get(channel);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) this.channels.delete(channel);
    };
  }
}
