# nextjs-minimal — livechat-bridge demo

A runnable Next.js (App Router) app that exercises every moving part of
`livechat-bridge` end-to-end:

- **SSE transport** (no Pusher, no WebSocket server)
- **In-memory storage** (no Mongo, no Postgres)
- **Demo AI provider** that echoes a friendly reply — automatically upgrades
  to **Claude (Anthropic)** when `ANTHROPIC_API_KEY` is set
- **Cookie-based demo auth** (HTTP-only) so you can flip between a
  &ldquo;customer&rdquo; and a &ldquo;staff&rdquo; session in two browser windows

> Production deployments swap each of these out — see
> [`LiveChatSupport.md`](../../LiveChatSupport.md) and
> [`../../TestRun.md`](../../TestRun.md).

## Quick start

From the repo root, build the package once so the demo has something to link
against:

```bash
corepack pnpm install
corepack pnpm build       # produces dist/
```

Then start the demo:

```bash
cd examples/nextjs-minimal
pnpm install              # links livechat-bridge from `../..`
pnpm dev                  # http://localhost:3030
```

(Skip `corepack` here if `pnpm` is already on your PATH.)

## Try it

1. Open <http://localhost:3030> in two browser windows (or one regular + one
   incognito).
2. In window A, sign in as **Alice Customer** (leave the staff checkbox off).
   Click the chat bubble, send a message.
3. In window B, sign in as **Bob Staff** with the **&ldquo;Sign in as staff&rdquo;**
   box checked. You&rsquo;ll land on `/admin` — the new chat appears in real time.
4. Wait 30 s without claiming. The demo AI provider posts a reply on the chat
   channel; status moves to **AI**.
5. Reply from the staff side. The chat silently transitions to **claimed**;
   the customer sees a &ldquo;Bob joined the chat&rdquo; system message.

Optional tweaks via `.env.local`:

```bash
# Real Claude instead of the canned fake reply
ANTHROPIC_API_KEY=sk-ant-...

# Shorter fallback for impatient demos
AI_FALLBACK_MS=8000
```

## How it&rsquo;s wired

| Concern | File |
|---|---|
| Singleton bridge factory | [`app/lib/livechat.ts`](./app/lib/livechat.ts) |
| Demo cookie session | [`app/lib/session.ts`](./app/lib/session.ts) |
| Fake vs real AI provider | [`app/lib/ai.ts`](./app/lib/ai.ts) |
| Widget mount | [`app/chat-widget.tsx`](./app/chat-widget.tsx) |
| Admin mount | [`app/admin/admin-shell.tsx`](./app/admin/admin-shell.tsx) |
| API routes | [`app/api/livechat/*`](./app/api/livechat) |

Each API route is a one-liner that delegates to
`createRouteHandlers(bridge).<name>` — that&rsquo;s the entire integration
surface for any Next.js host app.

## Production caveats

- **In-memory storage loses state on restart.** Swap `MemoryStorage` for
  `MongoStorage` (or roll your own `StorageAdapter`) before shipping.
- **SSE on serverless platforms is time-capped.** Either run Next.js on a
  persistent Node host (Render, Fly, Docker) or switch to the self-hosted
  Pusher-protocol recipe in [`../self-hosted-realtime/`](../self-hosted-realtime/).
- **Cookie auth here is a demo.** Replace `readSession` with your real
  auth — see the NextAuth snippet in `LiveChatSupport.md`.
