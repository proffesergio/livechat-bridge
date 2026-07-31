# LiveChatSupport.md

The full developer guide for **livechat-bridge** — a drop-in live chat widget,
staff dashboard, and AI fallback for any Next.js / React app.

---

## Contents

1. [What you get](#what-you-get)
2. [Install](#install)
3. [Environment variables](#environment-variables)
4. [Server setup (Next.js App Router)](#server-setup-nextjs-app-router)
5. [Wire the routes](#wire-the-routes)
6. [Mount the widget](#mount-the-widget)
7. [Mount the admin dashboard](#mount-the-admin-dashboard)
8. [How the AI fallback works](#how-the-ai-fallback-works)
9. [Realtime transports](#realtime-transports)
10. [Theming](#theming)
10. [Internationalization](#internationalization)
11. [Custom storage adapter](#custom-storage-adapter)
12. [Custom AI provider](#custom-ai-provider)
13. [Auth integration notes](#auth-integration-notes)
14. [Production checklist](#production-checklist)
15. [Troubleshooting](#troubleshooting)

---

## What you get

- **Pluggable realtime** — Pusher Channels SaaS, a self-hosted Pusher-protocol
  server (Sockudo/Soketi), or a built-in **SSE transport** with no WebSocket
  server at all. See [Realtime transports](#realtime-transports).
- **Mongo + In-Memory** storage adapters (Postgres stub for you to fill in).
- **Anthropic Claude** AI provider with prompt caching (OpenAI / Gemini stubs).
- **React widget** for end users and a **React admin dashboard** for staff.
- **30-second AI fallback**: if no staff claims the chat in time, Claude
  answers; when staff replies later, they silently take over.
- **Manual claim queue** — one staff per chat, atomic claim semantics.
- **Logged-in only by default**, with a "sign in to chat" prompt for guests.
- **i18n** — English + Bangla bundled, more locales pluggable.
- **MIT licensed**, written in TypeScript, dual ESM + CJS builds.

## Install

```bash
pnpm add livechat-bridge pusher pusher-js @anthropic-ai/sdk mongoose zod
```

`@anthropic-ai/sdk` and `mongoose` are listed as optional peer deps — you only
need them if you use the bundled Anthropic / Mongo adapters.

## Environment variables

```bash
# Pusher
PUSHER_APP_ID=…
PUSHER_KEY=…
PUSHER_SECRET=…
PUSHER_CLUSTER=eu
NEXT_PUBLIC_PUSHER_KEY=…
NEXT_PUBLIC_PUSHER_CLUSTER=eu

# Storage
MONGO_URL=mongodb://localhost:27017/yourapp

# AI
ANTHROPIC_API_KEY=…
```

## Server setup (Next.js App Router)

Create one shared bridge instance and import it from every route file. Bridges
hold an in-process AI fallback timer table — keep it as a singleton so timers
aren't lost between requests.

```ts
// app/lib/livechat.ts
import Anthropic from '@anthropic-ai/sdk';
import mongoose from 'mongoose';
import Pusher from 'pusher';
import {
  createLiveChatBridge,
  MongoStorage,
  PusherTransport,
  AnthropicProvider,
} from 'livechat-bridge/server';
import { auth } from '@/auth';

await mongoose.connect(process.env.MONGO_URL!);

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.PUSHER_KEY!,
  secret: process.env.PUSHER_SECRET!,
  cluster: process.env.PUSHER_CLUSTER!,
  useTLS: true,
});

export const bridge = createLiveChatBridge({
  storage: new MongoStorage({ mongoose }),
  transport: new PusherTransport(pusher),
  ai: new AnthropicProvider({ client: new Anthropic() }),
  // Optional: a brand-aware system prompt is strongly recommended.
  aiSystemPrompt:
    'You are the customer support assistant for ACME. Be warm, brief, and ' +
    'tell users when a human teammate will follow up.',
  getViewer: async () => {
    const session = await auth();
    if (!session?.user) return null;
    return {
      id: session.user.id,
      name: session.user.name ?? 'Guest',
      email: session.user.email ?? undefined,
      isStaff: session.user.role === 'staff' || session.user.role === 'admin',
    };
  },
});
```

## Wire the routes

`createRouteHandlers(bridge)` returns one function per endpoint. Re-export them
from the matching route file:

```ts
// app/api/livechat/messages/route.ts
import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { bridge } from '@/app/lib/livechat';
const h = createRouteHandlers(bridge);
export const POST = h.sendMessage;
```

| Endpoint                                       | Handler          | Method |
|------------------------------------------------|------------------|--------|
| `/api/livechat/me`                             | `viewer`         | GET    |
| `/api/livechat/messages`                       | `sendMessage`    | POST   |
| `/api/livechat/chats`                          | `listChats`      | GET    |
| `/api/livechat/chats/[id]/messages`            | `listMessages`   | GET    |
| `/api/livechat/chats/[id]/claim`               | `claimChat`      | POST   |
| `/api/livechat/chats/[id]/close`               | `closeChat`      | POST   |
| `/api/livechat/pusher/auth`                    | `pusherAuth`     | POST   |
| `/api/livechat/stream`                         | `stream`         | GET    |

See `examples/nextjs-minimal/README.md` for the full set.

## Mount the widget

```tsx
'use client';
import { useEffect, useState } from 'react';
import Pusher from 'pusher-js';
import { LiveChatWidget } from 'livechat-bridge/react';
import 'livechat-bridge/react/widget.css';

export default function Chat() {
  const [pusher, setPusher] = useState<Pusher | null>(null);
  useEffect(() => {
    const p = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
      channelAuthorization: {
        endpoint: '/api/livechat/pusher/auth',
        transport: 'ajax',
      },
    });
    setPusher(p);
    return () => p.disconnect();
  }, []);

  return (
    <LiveChatWidget
      pusher={pusher}
      signInUrl="/sign-in"
      locale="en"
    />
  );
}
```

Props:

| Prop          | Type                  | Default          | Notes |
|---------------|-----------------------|------------------|-------|
| `pusher`      | `Pusher \| null`      | —                | Pass `null` while the client is still loading. |
| `basePath`    | `string`              | `/api/livechat`  | Where your route handlers are mounted. |
| `locale`      | `'en' \| 'bn' \| ...` | `'en'`           | Pick a bundled locale. |
| `translations`| `Partial<Messages>`   | `undefined`      | Override individual i18n keys. |
| `signInUrl`   | `string`              | `undefined`      | If unset, the sign-in card hides the link. |
| `defaultOpen` | `boolean`             | `false`          | Open the panel on mount. |
| `fetch`       | `typeof fetch`        | `globalThis.fetch` | Override for SSR / custom auth. |

## Mount the admin dashboard

```tsx
'use client';
import { useEffect, useState } from 'react';
import Pusher from 'pusher-js';
import { AdminDashboard } from 'livechat-bridge/react';
import 'livechat-bridge/react/admin.css';

export default function AdminPage() {
  const [pusher, setPusher] = useState<Pusher | null>(null);
  useEffect(() => {
    const p = new Pusher(process.env.NEXT_PUBLIC_PUSHER_KEY!, {
      cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
      channelAuthorization: {
        endpoint: '/api/livechat/pusher/auth',
        transport: 'ajax',
      },
    });
    setPusher(p);
    return () => p.disconnect();
  }, []);
  return <AdminDashboard pusher={pusher} />;
}
```

The dashboard renders an empty state if the viewer's `isStaff` is `false` —
no extra gating needed beyond your auth callback.

## How the AI fallback works

1. The user sends their first message. The chat goes to status `open`.
2. The bridge starts a 30-second timer.
3. If a staff member calls `claimChat` before the timer fires, the timer is
   cancelled. Chat status moves to `claimed`. Done.
4. If the timer fires:
   - Chat status moves to `ai`.
   - The bridge re-reads the chat (defensive — another instance may have
     claimed it) and aborts if it's no longer `open`.
   - The AI provider is invoked with the recent message history.
   - The reply is posted back on the chat channel.
5. If staff later sends a message into the `ai` chat, the chat transitions to
   `claimed` and a `chat:staff-takeover` event fires. The user UI shows
   "{Staff} joined the chat" — no visible disruption.

Turn it off entirely by passing `aiFallbackMs: 0` or omitting `ai` from the
bridge config.

## Realtime transports

The widget and admin dashboard talk to the server through a small
`RealtimeClient` abstraction, so you can pick how realtime is delivered without
touching component code. Three options:

| Transport | Server | Client | Needs |
|-----------|--------|--------|-------|
| Pusher SaaS | `PusherTransport` | `pusher` prop (or `PusherRealtimeClient`) | a Pusher account |
| Self-hosted Pusher protocol | `PusherTransport` | same, different host | a Sockudo/Soketi container |
| **SSE** | `SSETransport` | `SSERealtimeClient` | nothing extra |

### SSE (no WebSocket server)

```ts
// server: app/lib/livechat.ts
import { createLiveChatBridge, SSETransport } from 'livechat-bridge/server';
export const bridge = createLiveChatBridge({
  storage: /* … */,
  transport: new SSETransport(), // in-memory pub/sub by default
  getViewer: /* … */,
});
```

```ts
// app/api/livechat/stream/route.ts
import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { bridge } from '@/app/lib/livechat';
export const GET = createRouteHandlers(bridge).stream;
export const dynamic = 'force-dynamic';
```

```tsx
'use client';
import { useMemo } from 'react';
import { LiveChatWidget, SSERealtimeClient } from 'livechat-bridge/react';
export default function Chat() {
  const realtime = useMemo(() => new SSERealtimeClient(), []);
  return <LiveChatWidget realtime={realtime} signInUrl="/sign-in" />;
}
```

No Pusher env vars, no `pusher/auth` route — the stream endpoint authorizes the
viewer with the same `getViewer` ACL. **Durable SSE needs a persistent Node
runtime;** on serverless platforms with execution-time caps the connection is
cut periodically and `EventSource` reconnects. For multiple instances, pass a
Redis-backed `PubSub` to `SSETransport` so events fan out across them.

### Self-hosted Pusher protocol & migration

`Sockudo`/`Soketi` speak the Pusher protocol, so the existing `PusherTransport`
and `pusher-js` work unchanged — only the host/port config differs. A ready
`docker-compose.yml` (Sockudo + Redis) and full setup live in
[`examples/self-hosted-realtime/`](./examples/self-hosted-realtime/README.md).

### `realtime` vs `pusher` prop

New code should pass a `realtime` client. The `pusher` prop still works (it is
wrapped in a `PusherRealtimeClient` for you) but is **deprecated** and will be
removed after 0.2.x:

```tsx
// before (still works, deprecated)
<LiveChatWidget pusher={pusher} />
// after
<LiveChatWidget realtime={new PusherRealtimeClient(pusher)} />
```

## Theming

Both stylesheets use CSS variables. Override them under a wrapper or globally:

```css
.lcb-widget {
  --lcb-accent: #ec4899;
  --lcb-bubble-user: #ec4899;
  --lcb-radius: 18px;
}

.lcb-admin {
  --lcb-accent: #0f766e;
  --lcb-bubble-staff: #0f766e;
}
```

Variables you can override (widget):

`--lcb-bg`, `--lcb-fg`, `--lcb-muted`, `--lcb-border`, `--lcb-accent`,
`--lcb-accent-fg`, `--lcb-bubble-user`, `--lcb-bubble-user-fg`,
`--lcb-bubble-other`, `--lcb-bubble-other-fg`, `--lcb-bubble-ai`,
`--lcb-bubble-ai-fg`, `--lcb-radius`, `--lcb-shadow`, `--lcb-font`.

The admin dashboard has matching variables plus `--lcb-row-hover` and
`--lcb-row-active`.

## Internationalization

Two locales ship in the box: `'en'` and `'bn'`.

```tsx
<LiveChatWidget pusher={pusher} locale="bn" />
```

Override individual keys without forking the bundle:

```tsx
<LiveChatWidget
  pusher={pusher}
  translations={{
    'widget.launcher.label': 'Need a hand?',
    'widget.header.title': 'ACME Support',
  }}
/>
```

To add a brand-new locale, import `getMessages` / `t` from
`livechat-bridge/react`, build your own translations object, and pass it via
`translations`. (A future release will expose a registry for custom locales.)

The raw JSON bundles are also exported for non-React consumers:

```ts
import en from 'livechat-bridge/i18n/en';
```

## Custom storage adapter

Implement the `StorageAdapter` interface:

```ts
import type { StorageAdapter } from 'livechat-bridge/server';

export class MyStorage implements StorageAdapter {
  findActiveChatByUser(userId) { /* … */ }
  createChat({ user, meta })   { /* … */ }
  getChat(chatId)              { /* … */ }
  updateChat(chatId, patch)    { /* … */ }
  listChats(opts)              { /* … */ }
  claimChat(chatId, staffId)   { /* … must be atomic — see below */ }
  appendMessage(message)       { /* … */ }
  listMessages(chatId, opts)   { /* … */ }
  getQueueCounts()             { /* … */ }
}
```

**Critical:** `claimChat` must be a single atomic operation that succeeds only
if the chat is unclaimed or already owned by the same staff member. Anything
else opens the door to two staff thinking they own the same chat. The Mongo
adapter uses a conditional `findOneAndUpdate`; Postgres should use a single
conditional `UPDATE … RETURNING`.

## Custom AI provider

```ts
import type { AIProvider, AiReplyContext, AiReplyResult } from 'livechat-bridge/server';

export class MyProvider implements AIProvider {
  readonly name = 'myco';
  async reply(ctx: AiReplyContext): Promise<AiReplyResult> {
    // ctx.systemPrompt — brand-aware system text
    // ctx.history — recent messages, oldest first
    // ctx.locale — e.g. 'en' | 'bn'
    // ctx.signal — abort signal (set if staff claimed the chat)
    return { body: '…' };
  }
}
```

## Auth integration notes

`getViewer` is the only auth boundary. It receives the raw `Request` so you
can read cookies, sessions, headers — whatever your stack uses. Return
`null` to render the "sign in to chat" guest card; return `{ isStaff: true }`
to grant access to claim/list/dashboard endpoints.

For NextAuth / Auth.js, the snippet in [Server setup](#server-setup-nextjs-app-router)
is the entire integration.

## Production checklist

- **One bridge per process.** Don't create a new bridge inside a route handler
  — the AI fallback timers live in memory.
- **Singleton mongoose / Pusher clients.** Same reason. Connect once at module
  load.
- **Restrict the admin route.** The dashboard doesn't render for non-staff,
  but you should still gate the URL with middleware.
- **Pusher TLS.** Always `useTLS: true` in production.
- **Rate-limit `sendMessage`.** Out of scope for this package — add your own
  middleware at the edge or in `getViewer`.
- **Set `aiSystemPrompt`.** The default is brand-neutral; replace it with
  something specific so the assistant talks like your product.

## Troubleshooting

- **"Sign in to chat" shows for logged-in users.** `getViewer` returned
  `null`. Check that your auth helper is reading cookies on the server.
- **Messages don't appear in real time.** Pusher channel auth is failing.
  Open the network tab and look for non-200 responses to
  `/api/livechat/pusher/auth`.
- **AI never replies.** Check that `ai` is set on the bridge and `aiFallbackMs`
  isn't `0`. The default 30 s window means you'll wait 30 seconds before the
  first AI message.
- **Two staff claimed the same chat.** Your custom storage adapter's
  `claimChat` is not atomic. See the [section above](#custom-storage-adapter).
- **`PusherTransport` error on import.** The Pusher server SDK is a peer dep —
  install it: `pnpm add pusher`.
- **`MongoStorage` complains about already-defined models.** You connected to
  Mongo multiple times. Connect once at module load; the adapter reuses
  existing models if they exist.
