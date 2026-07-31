import type { RealtimeClient, RealtimeSubscription } from './realtime.js';

export interface SSEClientOptions {
  /** Base path the server handlers are mounted under. Defaults to `/api/livechat`. */
  basePath?: string;
  /**
   * Send cookies with the `EventSource` request. Defaults to `true` so the
   * stream endpoint can authenticate the viewer the same way the REST routes
   * do. Set `false` only for fully public, same-origin streams.
   */
  withCredentials?: boolean;
}

/**
 * `RealtimeClient` backed by Server-Sent Events. Opens one `EventSource` per
 * channel against `${basePath}/stream?channel=…`. No WebSocket server is
 * required — the consumer's own Next.js route streams events, and `EventSource`
 * reconnects automatically (which also papers over serverless time limits).
 *
 * SSE is one-way (server → client); the widget already sends messages over the
 * REST API, so a receive-only realtime channel is sufficient.
 */
export class SSERealtimeClient implements RealtimeClient {
  constructor(private readonly opts: SSEClientOptions = {}) {}

  subscribe(
    channel: string,
    events: Record<string, (payload: unknown) => void>
  ): RealtimeSubscription {
    const base = (this.opts.basePath ?? '/api/livechat').replace(/\/$/, '');
    const url = `${base}/stream?channel=${encodeURIComponent(channel)}`;
    const source = new EventSource(url, {
      withCredentials: this.opts.withCredentials ?? true,
    });

    const listeners: Array<[string, EventListener]> = [];
    for (const event of Object.keys(events)) {
      const listener: EventListener = (e) => {
        const data = (e as MessageEvent).data as string | undefined;
        let payload: unknown;
        try {
          payload = data ? JSON.parse(data) : undefined;
        } catch {
          payload = data;
        }
        events[event]?.(payload);
      };
      source.addEventListener(event, listener);
      listeners.push([event, listener]);
    }

    return {
      unsubscribe: () => {
        for (const [event, listener] of listeners) {
          source.removeEventListener(event, listener);
        }
        source.close();
      },
    };
  }
}
