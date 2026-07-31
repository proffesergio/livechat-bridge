'use client';

import { useMemo } from 'react';
import { LiveChatWidget, SSERealtimeClient } from 'livechat-bridge/react';

/**
 * Client wrapper around the widget so the SSE client is constructed in the
 * browser (it opens an `EventSource`).
 */
export function ChatWidget() {
  const realtime = useMemo(() => new SSERealtimeClient(), []);
  return <LiveChatWidget realtime={realtime} signInUrl="/sign-in" />;
}
