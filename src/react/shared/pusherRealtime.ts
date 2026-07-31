import type Pusher from 'pusher-js';
import type { RealtimeClient, RealtimeSubscription } from './realtime.js';

/**
 * `RealtimeClient` backed by a `pusher-js` instance. Works against Pusher
 * Channels (SaaS) and any Pusher-protocol-compatible self-hosted server
 * (Sockudo, Soketi) — only the client's `wsHost`/`wsPort`/`forceTLS` config
 * differs, which is the consumer's concern, not this wrapper's.
 */
export class PusherRealtimeClient implements RealtimeClient {
  constructor(private readonly pusher: Pusher) {}

  subscribe(
    channel: string,
    events: Record<string, (payload: unknown) => void>
  ): RealtimeSubscription {
    const ch = this.pusher.subscribe(channel);
    const bound: Array<[string, (payload: unknown) => void]> = [];
    for (const event of Object.keys(events)) {
      const handler = (payload: unknown) => events[event]?.(payload);
      ch.bind(event, handler);
      bound.push([event, handler]);
    }
    return {
      unsubscribe: () => {
        for (const [event, handler] of bound) ch.unbind(event, handler);
        this.pusher.unsubscribe(channel);
      },
    };
  }
}
