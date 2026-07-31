'use client';

import { useMemo } from 'react';
import { AdminDashboard, SSERealtimeClient } from 'livechat-bridge/react';

export function AdminShell() {
  const realtime = useMemo(() => new SSERealtimeClient(), []);
  return <AdminDashboard realtime={realtime} />;
}
