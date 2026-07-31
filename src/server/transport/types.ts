/**
 * Transport abstraction. The bridge only ever sees these interfaces, so swapping
 * Pusher for a self-hosted server (Sockudo/Soketi) or for SSE is a config change.
 */

export interface AuthorizedUser {
  id: string;
  name: string;
  isStaff: boolean;
}

export type AuthResponse = Record<string, unknown>;

export interface Transport {
  /** Publish `event` with `payload` to everyone subscribed to `channel`. */
  trigger(channel: string, event: string, payload: unknown): Promise<void>;
  /**
   * Authorize a client's subscription to `channel`. Pusher-style transports
   * return a signed handshake; SSE-style transports authorize on the stream
   * request instead and may return an empty object.
   */
  authorizeChannel(socketId: string, channel: string, user?: AuthorizedUser): AuthResponse;
}

/**
 * A transport that can also push events to a server-held listener (used by the
 * SSE stream handler). Pusher does not implement this — the browser connects to
 * Pusher directly — but the SSE transport does, because the consumer's own
 * server holds the stream.
 */
export interface SubscribableTransport extends Transport {
  subscribe(channel: string, listener: (event: string, payload: unknown) => void): () => void;
}

export function isSubscribable(transport: Transport): transport is SubscribableTransport {
  return typeof (transport as Partial<SubscribableTransport>).subscribe === 'function';
}
