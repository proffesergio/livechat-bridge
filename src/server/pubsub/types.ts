/**
 * Pub/sub backend for the SSE transport. The in-process default works for a
 * single Node instance; multi-instance deployments need a shared backend (e.g.
 * Redis) so an event triggered on one instance reaches stream connections held
 * by another.
 */
export interface PubSub {
  /** Publish `event` + `payload` to every listener subscribed to `channel`. */
  publish(channel: string, event: string, payload: unknown): Promise<void>;
  /**
   * Register `listener` for `channel`. Returns an unsubscribe function that
   * removes exactly this listener.
   */
  subscribe(
    channel: string,
    listener: (event: string, payload: unknown) => void
  ): () => void;
}
