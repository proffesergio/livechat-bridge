import { STAFF_CHANNEL, chatChannel } from '../../core/index.js';
import type { PubSub } from '../pubsub/index.js';
import { InMemoryPubSub } from '../pubsub/index.js';
import type { AuthResponse, AuthorizedUser, SubscribableTransport } from './types.js';

export interface SSETransportOptions {
  /**
   * Pub/sub backend. Defaults to a single-process `InMemoryPubSub`. Pass a
   * Redis-backed implementation to fan out across multiple instances.
   */
  pubsub?: PubSub;
}

/**
 * Server-Sent Events transport. `trigger` publishes onto the pub/sub backend;
 * the stream handler subscribes and forwards events to connected browsers. No
 * external realtime service is required.
 *
 * Channel authorization happens on the stream HTTP request (the bridge runs the
 * same ACL it uses for Pusher auth), so `authorizeChannel` here is a no-op.
 */
export class SSETransport implements SubscribableTransport {
  private readonly pubsub: PubSub;

  constructor(opts: SSETransportOptions = {}) {
    this.pubsub = opts.pubsub ?? new InMemoryPubSub();
  }

  async trigger(channel: string, event: string, payload: unknown): Promise<void> {
    await this.pubsub.publish(channel, event, payload);
  }

  authorizeChannel(_socketId: string, _channel: string, _user?: AuthorizedUser): AuthResponse {
    // SSE authorizes on the stream request, not via a socket handshake.
    return {};
  }

  subscribe(channel: string, listener: (event: string, payload: unknown) => void): () => void {
    return this.pubsub.subscribe(channel, listener);
  }
}

export { STAFF_CHANNEL, chatChannel };
