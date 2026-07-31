/**
 * Client-side realtime abstraction. Mirrors the server `Transport` interface so
 * the widget and admin dashboard never bind directly to a specific provider.
 *
 * Implementations:
 *   - `PusherRealtimeClient` — wraps `pusher-js` (works against Pusher SaaS and
 *     any Pusher-protocol-compatible self-hosted server, e.g. Sockudo/Soketi).
 *   - `SSERealtimeClient` — Server-Sent Events; no WebSocket server required.
 */

/** A live subscription to one channel. Call `unsubscribe` to tear it down. */
export interface RealtimeSubscription {
  unsubscribe(): void;
}

/** Subscribe to channels and bind event handlers. */
export interface RealtimeClient {
  /**
   * Subscribe to `channel` and bind `events` (keyed by event name). The set of
   * event names is read once at subscribe time; handler identities may change.
   */
  subscribe(
    channel: string,
    events: Record<string, (payload: unknown) => void>
  ): RealtimeSubscription;
}
