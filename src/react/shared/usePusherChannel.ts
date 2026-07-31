'use client';

import { useMemo } from 'react';
import type Pusher from 'pusher-js';
import { PusherRealtimeClient } from './pusherRealtime.js';
import { useRealtimeChannel } from './useRealtimeChannel.js';

export interface UsePusherChannelOptions {
  /** Already-constructed Pusher client. The widget never creates one itself. */
  client: Pusher | null | undefined;
  channelName: string | null;
  events: Record<string, (payload: unknown) => void>;
}

/**
 * @deprecated Use {@link useRealtimeChannel} with a `RealtimeClient`
 * (e.g. `PusherRealtimeClient` or `SSERealtimeClient`). This shim wraps a
 * `pusher-js` instance and remains for backwards compatibility.
 */
export function usePusherChannel({ client, channelName, events }: UsePusherChannelOptions): void {
  const realtime = useMemo(() => (client ? new PusherRealtimeClient(client) : null), [client]);
  useRealtimeChannel({ client: realtime, channelName, events });
}
