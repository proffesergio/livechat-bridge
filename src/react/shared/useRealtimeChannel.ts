'use client';

import { useEffect, useRef } from 'react';
import type { RealtimeClient } from './realtime.js';

export interface UseRealtimeChannelOptions {
  /** Already-constructed realtime client. The hook never creates one itself. */
  client: RealtimeClient | null | undefined;
  channelName: string | null;
  events: Record<string, (payload: unknown) => void>;
}

/**
 * Subscribe to a realtime channel and bind a set of event handlers, cleaning up
 * on unmount or when the client/channel changes. Handlers are stored in a ref
 * so callers don't have to memoize them; the set of event names is read once
 * per (re)subscription.
 */
export function useRealtimeChannel({
  client,
  channelName,
  events,
}: UseRealtimeChannelOptions): void {
  const handlersRef = useRef(events);
  handlersRef.current = events;

  useEffect(() => {
    if (!client || !channelName) return;
    const wrapped: Record<string, (payload: unknown) => void> = {};
    for (const event of Object.keys(handlersRef.current)) {
      wrapped[event] = (payload: unknown) => handlersRef.current[event]?.(payload);
    }
    const sub = client.subscribe(channelName, wrapped);
    return () => sub.unsubscribe();
  }, [client, channelName]);
}
