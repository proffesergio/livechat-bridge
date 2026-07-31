# livechat-bridge

> Drop-in **live chat widget + staff dashboard + Claude AI fallback** for any
> Next.js / React app. One `pnpm add`, three route files, and you have a
> production-grade support channel — no third-party SaaS required.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Built with TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](./tsconfig.json)
[![Realtime: SSE • Pusher](https://img.shields.io/badge/realtime-SSE%20%E2%80%A2%20Pusher%20%E2%80%A2%20Sockudo-7c3aed.svg)](./LiveChatSupport.md#realtime-transports)

---

## What it does

When a signed-in customer opens the chat bubble on your site, their message
hits your own Next.js API routes. Staff see it in the bundled admin dashboard
and can **claim** the conversation (one staff per chat, atomic claim
semantics). If nobody picks up within 30 seconds, **Claude** quietly steps in
and answers — and silently hands back the moment a real teammate replies.

```
 customer widget ──▶  /api/livechat/*  ──▶  bridge ──┬─▶  storage   (Mongo • Postgres¹ • In-memory)
                                  ▲                  ├─▶  transport (SSE • Pusher • Sockudo/Soketi)
                                  │                  └─▶  AI        (Anthropic Claude • bring-your-own)
       admin dashboard ───────────┘
```

<sub>¹ Postgres adapter is a stub interface today — implement it or use Mongo / in-memory.</sub>

## Highlights

- **Pluggable realtime** — Server-Sent Events (no WS server), Pusher SaaS, or a
  self-hosted Pusher-protocol server (Sockudo / Soketi). Same widget code.
- **30-second AI fallback** — Anthropic Claude with prompt caching baked in.
  Configurable window, off-switch, or bring your own `AIProvider`.
- **Staff dashboard** — open / claimed / AI queues, manual claim, realtime
  message thread.
- **Adapter pattern everywhere** — `StorageAdapter`, `Transport`, `AIProvider`,
  `RealtimeClient`. Swap any one without touching the rest.
- **Logged-in only by default** — single `getViewer(req)` hook drives every
  ACL decision. Friendly "Sign in to chat" prompt for guests.
- **i18n bundled** — English + Bangla in the box; override individual keys per
  brand.
- **Themeable** — CSS variables on both stylesheets, no design lock-in.
- **TypeScript, ESM + CJS, MIT.**

## Install

```bash
pnpm add livechat-bridge zod
# pick the bits you need:
pnpm add @anthropic-ai/sdk          # AI fallback
pnpm add mongoose                   # Mongo storage adapter
pnpm add pusher pusher-js           # Pusher / Sockudo realtime
```

`@anthropic-ai/sdk`, `mongoose`, and the Pusher SDKs are optional peer deps —
install only the ones matching the adapters you actually use.

## 60-second quick start (SSE + Memory + Claude)

The simplest path: no Pusher account, no Mongo, just one Next.js app.

```ts
// app/lib/livechat.ts
import Anthropic from '@anthropic-ai/sdk';
import {
  createLiveChatBridge,
  MemoryStorage,            // swap for MongoStorage in prod
  SSETransport,
  AnthropicProvider,
} from 'livechat-bridge/server';
import { auth } from '@/auth';   // your real session helper

export const bridge = createLiveChatBridge({
  storage: new MemoryStorage(),
  transport: new SSETransport(),
  ai: new AnthropicProvider({ client: new Anthropic() }),
  getViewer: async (req) => {
    const session = await auth();
    if (!session?.user) return null;
    return {
      id: session.user.id,
      name: session.user.name ?? 'User',
      email: session.user.email ?? undefined,
      isStaff: session.user.role === 'staff',
    };
  },
});
```

```ts
// app/api/livechat/messages/route.ts (repeat for the other endpoints)
import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { bridge } from '@/app/lib/livechat';
export const POST = createRouteHandlers(bridge).sendMessage;
```

```tsx
// app/page.tsx
'use client';
import { useMemo } from 'react';
import { LiveChatWidget, SSERealtimeClient } from 'livechat-bridge/react';
import 'livechat-bridge/react/widget.css';

export default function Page() {
  const realtime = useMemo(() => new SSERealtimeClient(), []);
  return <LiveChatWidget realtime={realtime} signInUrl="/sign-in" />;
}
```

Full route table, Mongo wiring, Pusher recipe, theming, and the AI fallback
details: **[LiveChatSupport.md](./LiveChatSupport.md)**.

## See it running

```bash
git clone https://github.com/<your-fork>/livechat-bridge
cd livechat-bridge
corepack pnpm install && corepack pnpm build
cd examples/nextjs-minimal && pnpm install && pnpm dev
# → http://localhost:3030
```

The demo runs offline — no API keys, no SaaS — with SSE realtime, in-memory
storage, and a canned AI provider. Set `ANTHROPIC_API_KEY` in `.env.local` to
upgrade to real Claude replies.

Walkthrough: [`examples/nextjs-minimal/README.md`](./examples/nextjs-minimal/README.md).

## Pick a realtime transport

| Transport | Server | Client | Needs |
|---|---|---|---|
| **SSE** (recommended for new apps) | `SSETransport` | `SSERealtimeClient` | nothing |
| Pusher SaaS | `PusherTransport` | `PusherRealtimeClient` | Pusher account |
| Self-hosted Pusher protocol | `PusherTransport` | same as above | Sockudo / Soketi container — recipe in [`examples/self-hosted-realtime/`](./examples/self-hosted-realtime/) |

Durable SSE needs a persistent Node runtime; on serverless platforms with
execution-time caps `EventSource` reconnects, or pick the self-hosted Pusher
recipe. Detail: [Realtime transports](./LiveChatSupport.md#realtime-transports).

## Documentation

| Doc | When you need it |
|---|---|
| **[LiveChatSupport.md](./LiveChatSupport.md)** | Full developer guide — env vars, route table, theming, i18n, auth, custom adapters, production checklist |
| **[TestRun.md](./TestRun.md)** | Local testing recipes, version-control workflow, release process, production deploy on Node & Next.js hosts |
| [`examples/nextjs-minimal/`](./examples/nextjs-minimal/) | Runnable demo (SSE + memory + fake AI) |
| [`examples/self-hosted-realtime/`](./examples/self-hosted-realtime/) | Sockudo + Redis docker-compose recipe |
| [`CHANGELOG.md`](./CHANGELOG.md) | Release notes |

## Project status

- **0.2.0** — realtime is now pluggable (SSE + native abstraction), demo app,
  full-flow integration tests.
- **0.1.0** — initial release: Pusher transport, Mongo storage, Claude
  fallback, widget + admin, English/Bangla.

Roadmap: commerce-aware AI (`getCommerceContext` + Claude tool use),
`PostgresStorage` implementation, locale registry, rate-limit hook — see
[`docs/PHASE-2-PLAN.md`](./docs/PHASE-2-PLAN.md).

## Contributing

Issues and PRs welcome. Workflow + release process: **[TestRun.md](./TestRun.md)**.
Open a draft PR early and reference an issue if you can.

## License

MIT © [Hossain Billal](https://next-portfolio-ruby-nine.vercel.app/).
