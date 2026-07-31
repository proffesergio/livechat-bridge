# Self-hosted realtime (no Pusher SaaS)

Two ways to run livechat-bridge without a paid Pusher account. Pick one.

## Option 1 — SSE transport (no WebSocket server)

The simplest path: nothing to run beyond your own app. Use `SSETransport` on the
server and `SSERealtimeClient` in the browser. Events stream over a plain HTTP
`text/event-stream` route (`/api/livechat/stream`), and `EventSource` reconnects
automatically.

```ts
// app/lib/livechat.ts
import { createLiveChatBridge, SSETransport } from 'livechat-bridge/server';

export const bridge = createLiveChatBridge({
  storage: /* … */,
  transport: new SSETransport(), // in-memory pub/sub (single instance)
  getViewer: /* … */,
});
```

```ts
// app/api/livechat/stream/route.ts
import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { bridge } from '@/app/lib/livechat';
export const GET = createRouteHandlers(bridge).stream;
export const dynamic = 'force-dynamic'; // never cache the stream
```

```tsx
'use client';
import { LiveChatWidget, SSERealtimeClient } from 'livechat-bridge/react';
import { useMemo } from 'react';

export default function Chat() {
  const realtime = useMemo(() => new SSERealtimeClient(), []);
  return <LiveChatWidget realtime={realtime} signInUrl="/sign-in" />;
}
```

**Caveat:** durable SSE needs a persistent Node runtime. On serverless platforms
with execution-time caps (e.g. Vercel) the connection is cut periodically;
`EventSource` reconnects, but for many concurrent chats run Next.js on a Node
server/container, or use Option 2. For multiple instances, pass a Redis-backed
`PubSub` to `SSETransport` so events fan out across them.

## Option 2 — Self-hosted Pusher protocol (Sockudo)

Keep using `PusherTransport` + `pusher-js`, but point them at the Sockudo
container in this folder instead of Pusher's cloud.

```bash
cp .env.example .env   # edit the secret
docker compose up -d   # starts Sockudo (:6001) + Redis
```

Server — point the Pusher SDK at the local host:

```ts
import Pusher from 'pusher';
import { PusherTransport } from 'livechat-bridge/server';

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.PUSHER_KEY!,
  secret: process.env.PUSHER_SECRET!,
  host: process.env.PUSHER_HOST,            // 127.0.0.1
  port: process.env.PUSHER_PORT,            // 6001
  useTLS: process.env.PUSHER_USE_TLS === 'true',
});
export const transport = new PusherTransport(pusher);
```

Client — same idea with `pusher-js`:

```ts
import Pusher from 'pusher-js';
const p = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
  wsHost: process.env.NEXT_PUBLIC_PUSHER_HOST,   // 127.0.0.1
  wsPort: Number(process.env.NEXT_PUBLIC_PUSHER_PORT), // 6001
  forceTLS: process.env.NEXT_PUBLIC_PUSHER_FORCE_TLS === 'true',
  enabledTransports: ['ws', 'wss'],
  channelAuthorization: { endpoint: '/api/livechat/pusher/auth', transport: 'ajax' },
});
```

Then mount the widget exactly as in the Pusher SaaS guide — wrap the client with
`new PusherRealtimeClient(p)` or keep passing `pusher={p}` (the widget wraps it
for you).

> Sockudo is young; confirm the image tag and `sockudo.config.json` field names
> against <https://sockudo.io>. [Soketi](https://docs.soketi.app) is a
> Node-based, Pusher-compatible alternative if you prefer.
