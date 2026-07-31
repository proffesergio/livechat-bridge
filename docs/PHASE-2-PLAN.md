# livechat-bridge — Phase 2 Plan

> ## ⚠️ SUPERSEDED — kept for historical context only
>
> On **2026-07-31** the project pivoted to an **embeddable multi-site** product.
> Two decisions recorded below were explicitly reversed:
>
> | This doc says | Current direction |
> |---|---|
> | Logged-in only, no anonymous guests | **Anonymous visitors supported** |
> | Single-app library, no multi-tenancy | **`siteId` is the tenant key** |
> | Adapter indirection (`StorageAdapter`, `Transport`, `AIProvider`) | Mongoose models exposed directly |
> | Entry points `/core`, `/react`, `/server/nextjs` | `/widget`, `/server`, `/admin` |
> | Realtime via SSE / Pusher / Sockudo | **WebSocket-first + HTTP long-poll** |
>
> The v0.2.0 architecture this doc describes is preserved at the repository's
> baseline commit and remains recoverable. For current context see
> [`CLAUDE.md`](../CLAUDE.md). Everything below is history.

---

> Status: **superseded** · Author: planning session 2026-05-21 · Targeted v0.2.0

## Context & scope decisions (confirmed 2026-05-21)

Phase 1 (v0.1.0) shipped the scaffold: Pusher transport, Mongo + in-memory
storage, Anthropic Claude AI fallback, React widget + admin dashboard, Next.js
App Router adapter, English/Bangla i18n. First build verified green.

Phase 2 is scoped to **reuse across the author's own Next.js apps** (atharnur
first), *not* PHP/WooCommerce/OpenCart platforms. Decisions taken:

| Decision | Choice | Consequence |
|----------|--------|-------------|
| Non-JS platforms (WooCommerce/OpenCart/PHP) | **Out of scope** | Stay a Next.js/React npm library. No PHP SDK/plugins, no standalone SaaS. |
| Guest / anonymous visitors | **Logged-in only** | `getViewer` stays the sole auth boundary. No anonymous sessions. |
| Realtime transport | **Add self-hosted WS + SSE fallback** | Break the hard Pusher SaaS dependency. Headline feature. |
| Commerce integration depth | **Deep, phased** | Feed cart/order/customer context to staff *and* the Claude AI. Headline feature. |

The two headline features are **realtime independence** and a
**commerce-aware AI**. A third workstream hardens storage and DX so the package
drops cleanly into any future Next.js app.

---

## Workstream A — Realtime independence (no mandatory Pusher SaaS)

### Problem
Today every install requires a paid Pusher Channels account. The author's own
apps should be able to run realtime with zero external SaaS.

### Research summary (2026-05)
- **Soketi** and **Sockudo** are open-source, **Pusher-protocol-compatible**
  WebSocket servers. Because they speak the Pusher protocol, the existing
  `PusherTransport` (server) and `pusher-js` (client) work against them
  unchanged — you only change the host/port/TLS config. Sockudo (Rust) is the
  more actively maintained of the two as of 2026.
- **Next.js serverless cannot hold long-lived connections.** Vercel caps
  streaming responses (~10s hobby / 60s pro) and never supports raw WebSockets.
  A self-hosted WS server therefore must be a *separate persistent process*
  (the Soketi/Sockudo container), and SSE is only durable when Next.js is
  self-hosted on a Node server/container. `EventSource` auto-reconnect papers
  over serverless time caps for the SSE path.
- Multi-instance fan-out (for both SSE and a future native WS) requires a
  shared pub/sub layer — Redis is the pragmatic default.

### Design: three interchangeable realtime options, one abstraction

The package already has a server-side `Transport` interface
(`trigger` + `authorizeChannel`). The gap is on the **client**: the widget and
admin are hard-bound to `pusher-js` via the `pusher` prop and
`usePusherChannel`. We introduce a client-side `RealtimeClient` abstraction
mirroring the server `Transport`.

**Resulting options for consumers:**
1. **Pusher SaaS** — existing path, unchanged.
2. **Self-hosted Pusher protocol (Soketi/Sockudo)** — *same code*, different
   host config. Cheapest self-host; ship a docker-compose + docs recipe.
3. **Native SSE transport** — no WS server at all; uses the consumer's own
   Next.js routes + optional Redis. Works behind any CDN/proxy.

### Client-side changes (`src/react`)
- New `RealtimeClient` interface in `src/react/shared/realtime.ts`:
  ```ts
  export interface RealtimeSubscription { unsubscribe(): void; }
  export interface RealtimeClient {
    subscribe(channel: string, events: Record<string, (p: unknown) => void>): RealtimeSubscription;
  }
  ```
- `PusherRealtimeClient(pusher)` — wraps `pusher-js` (covers options 1 & 2).
- `SSERealtimeClient({ basePath, fetch })` — opens an `EventSource` against
  `${basePath}/stream?channel=…`; demultiplexes events client-side.
- Generalize `usePusherChannel` → `useRealtimeChannel(client, channel, events)`.
  Keep a thin `usePusherChannel` shim re-exporting it for back-compat.
- Widget/admin gain a `realtime: RealtimeClient` prop. **Back-compat:** keep the
  `pusher` prop working by wrapping it in `PusherRealtimeClient` internally and
  marking it `@deprecated`.

### Server-side changes (`src/server`)
- New pub/sub abstraction `src/server/pubsub/`:
  ```ts
  export interface PubSub {
    publish(channel: string, event: string, payload: unknown): Promise<void>;
    subscribe(channel: string, cb: (event: string, payload: unknown) => void): () => void;
  }
  ```
  - `InMemoryPubSub` — single-process default (dev, single-node self-host).
  - `RedisPubSub` — multi-instance fan-out (`ioredis` as an optional peer dep).
- New `SSETransport` implements `Transport`:
  - `trigger(channel, event, payload)` → `pubsub.publish(...)`.
  - `authorizeChannel` → no-op `{}` (SSE auth happens on the stream request, not
    a socket handshake).
- New stream handler `handleStream(bridge, req)`:
  - Resolves the viewer (`getViewer`) and runs the **same channel ACL** as
    `bridge.authorize` (reuse, don't duplicate).
  - Subscribes to the pub/sub backend for the requested channel and returns a
    `ReadableStream` formatted as `text/event-stream`, with periodic
    keep-alive comments.
  - Cleans up the subscription on `req.signal` abort.
- Next.js adapter (`nextjs.ts`): add `stream: (req) => handleStream(bridge, req)`
  → mount at `app/api/livechat/stream/route.ts` as `GET`.

### Self-hosted Pusher-protocol recipe (option 2)
- `examples/self-hosted-realtime/` with a `docker-compose.yml` running
  Sockudo (primary) + Redis, plus the env vars and the `pusher` /`pusher-js`
  host config needed to point at it. **No package code change** beyond docs —
  this is the headline "no SaaS" answer with the least new surface area.
- Optional ergonomic helper `selfHostedPusherConfig(env)` that returns the
  server + client config objects so consumers don't hand-assemble host/port/TLS.

### Acceptance criteria (A)
- Widget + admin run end-to-end on **all three** transports.
- `pnpm typecheck && pnpm test && pnpm build` stay green; new unit tests cover
  `InMemoryPubSub`, `SSETransport.trigger`, and SSE stream framing.
- `pusher` prop still works (deprecation warning only).
- Docs: new "Realtime transports" section in `LiveChatSupport.md` + the
  docker-compose example.

---

## Workstream B — Commerce-aware AI (deep, phased)

### Problem
The AI fallback is generic. For ecommerce apps (atharnur), staff and the AI
should see the customer's orders/cart so the assistant can answer "where's my
order #123?" instead of deflecting to a human.

### Phase B1 — Read-only context injection
- New optional hook on `BridgeConfig`:
  ```ts
  getCommerceContext?: (args: { viewer: Viewer; chat: Chat; req: Request })
    => Promise<CommerceContext> | CommerceContext;
  ```
- `CommerceContext` (new type in `src/core`):
  ```ts
  interface CommerceContext {
    summary?: string;               // free-text the consumer pre-renders
    orders?: OrderRef[];            // id, status, total, placedAt, items[]
    cart?: CartRef;                 // items, subtotal
    customer?: { lifetimeValue?: number; tier?: string; since?: string };
    currentPage?: { url: string; productId?: string };
    custom?: Record<string, unknown>;
  }
  ```
- **AI path:** before `ai.reply`, fetch context, render a compact text block,
  and pass it as a *separate, non-cached* system block (the static brand prompt
  stays cached; dynamic per-customer context must not poison the cache). Extend
  `AiReplyContext` with an optional `commerceContext` field.
- **Staff path:** include `CommerceContext` in `getChat`/`listChats` responses
  and emit a `chat:context` event so the admin dashboard renders an order panel
  beside the conversation.

### Phase B2 — AI tool-use (on-demand lookups)
- Instead of dumping all context, let Claude *fetch* it. Extend `AIProvider`:
  ```ts
  interface AIProvider {
    name: string;
    reply(ctx: AiReplyContext): Promise<AiReplyResult>;
  }
  // ctx gains: tools?: ToolSpec[]; runTool?: (name, input) => Promise<unknown>;
  ```
- Define commerce tools the consumer wires up via config
  (`commerceTools: { lookupOrder, listRecentOrders, getOrderStatus }`).
- `AnthropicProvider` implements the **tool-use loop** (SDK ≥0.97, already
  installed): emit `tools`, handle `tool_use` stop reason, call `runTool`, feed
  `tool_result` back, repeat until a text answer. Keeps prompt-caching on the
  static system block.
- Guardrails: tool allow-list per provider, max tool-iterations, and the AI
  may only read data scoped to the chat's own customer (`viewer.id`).

### Acceptance criteria (B)
- B1: a configured `getCommerceContext` measurably changes AI answers (test
  with a fake provider asserting the context block is present) and surfaces in
  the dashboard.
- B2: AnthropicProvider completes a multi-turn tool-use loop against a mocked
  `runTool`; respects max-iteration and customer-scoping guards.
- Follows the `claude-api` skill: prompt caching preserved, tool use idiomatic.

---

## Workstream C — Storage & DX hardening (drop-in reuse)

Smaller, independent items that make the package painless to reuse:

- **Implement `PostgresStorage`** (currently throws). Use `pg`; atomic claim via
  `UPDATE … WHERE (assigned_staff_id IS NULL OR = $1) RETURNING *`. Many Next.js
  apps use Postgres/Drizzle/Prisma rather than Mongo.
- **Custom locale registry** — `registerLocale(code, messages)` (docs already
  promise this as "a future release").
- **Rate-limit hook** on `sendMessage` (`BridgeConfig.beforeSend?`) so consumers
  can throttle without edge middleware.
- **Typing indicators + read receipts** (optional, common chat UX) — new events
  over the existing transport; no storage change.
- **Richer example app** under `examples/` exercising SSE + commerce context.

---

## Suggested build sequence

> Confirmed 2026-05-21: build **native SSE first**; self-hosted WS recipe
> targets **Sockudo**.

1. **A-client abstraction** (`RealtimeClient`, `useRealtimeChannel`, prop
   migration with `pusher` shim) — unblocks everything, low risk.
2. **A-server SSE** (`PubSub` + `InMemoryPubSub` + `SSETransport` + stream
   handler + Next.js route) — the zero-SaaS path. **← start here.**
3. **A-self-hosted recipe** (docker-compose + docs + optional helper) targeting
   **Sockudo** — cheap, high value.
4. **B1 commerce context injection** — depends only on bridge/AI config.
5. **B2 AI tool-use** — depends on B1 types.
6. **A `RedisPubSub`** + **C PostgresStorage** — scale/persistence, parallelizable.
7. **C remaining DX items** + docs + CHANGELOG + version bump to 0.2.0.

## Risks & open sub-decisions
- **Prop migration risk:** changing the widget's primary prop from `pusher` to
  `realtime`. Mitigated by keeping `pusher` as a deprecated shim through 0.2.x.
- **SSE on Vercel:** time-capped; documented as "self-host Next.js on a Node
  runtime for durable SSE, or use the self-hosted Pusher-protocol option."
- **Pub/sub default:** `InMemoryPubSub` (single instance) by default; Redis is
  opt-in. Single-instance is correct for most of the author's apps initially.
- **Self-hosted WS server choice:** **Sockudo** (confirmed 2026-05-21), Soketi
  noted as an alternative in docs.
- **Tool-use scope (B2):** start with read-only order tools; no mutations
  (refunds/cancellations) until a later phase.

---

## Progress log

- **2026-05-21 — Workstream A SHIPPED (realtime independence).**
  - Client: `RealtimeClient` interface + `PusherRealtimeClient` +
    `SSERealtimeClient` + `useRealtimeChannel`
    (`src/react/shared/`). Widget/admin migrated to a `realtime` prop;
    `pusher` prop and `usePusherChannel` kept as **deprecated** shims (remove
    after 0.2.x).
  - Server: `PubSub` + `InMemoryPubSub` (`src/server/pubsub/`); `Transport`
    iface moved to `src/server/transport/types.ts`; `SSETransport` +
    `SubscribableTransport`; `handleStream` (`GET /api/livechat/stream`) +
    `bridge.authorizeSubscription`; `stream` added to the Next.js adapter.
  - Recipe: `examples/self-hosted-realtime/` (Sockudo + Redis docker-compose).
  - Tests: 26 pass (was 14) — `pubsub`, `sse-transport`, `stream`.
    typecheck/build green. CHANGELOG `0.2.0` started.
  - Caveat: Sockudo compose image tag/config keys are best-effort — verify
    against sockudo.io. Durable SSE needs a persistent Node runtime.

---

## MVP definition — what "presentable, production-ready" means (gate to git push)

Tick these before initializing the public git repo:

- [ ] **Runnable demo app** under `examples/nextjs-minimal/` (currently
      README-only). A real Next.js app showing the widget + admin + SSE working
      end-to-end. **Biggest gap for "presentable."**
- [ ] **README front page** rewritten: realtime is now pluggable (not
      "Pusher only"), add a screenshot/GIF, quick-start that matches reality.
- [ ] **Full-flow integration test** hitting the route handlers (send → AI
      fallback → claim → close) over real `Request`/`Response`, not just units.
- [ ] **Storage decision:** implement `PostgresStorage` (Workstream C) OR
      clearly document "Mongo + in-memory only for v0.2.0."
- [ ] **Security review** — run `/security-review` over the diff; pay attention
      to the SSE stream auth, channel ACL, and rate-limiting story.
- [ ] **Publish prep:** bump to `0.2.0`, finalize CHANGELOG, confirm `files`
      allowlist, `exports`, and a `pnpm publish --dry-run`.

The core library is already functional (Pusher **or** SSE, Mongo **or** memory,
Claude AI fallback). The MVP gap is mostly **demo + polish + one integration
test**, not core features.

---

## ▶ NEXT SESSION — start here

Resume order (each step independent enough to stop after):

1. **Decide MVP vs. features first.** Two reasonable paths:
   - **Path P (polish → ship fastest):** build the runnable demo app + README +
     integration test + security review → tag 0.2.0 → push repo. Defers
     commerce AI to a later phase. *Recommended if the goal is a presentable
     repo soon.*
   - **Path F (feature-complete first):** do Workstream B (commerce-aware AI)
     and C (Postgres) before the demo, so the demo shows them off.
2. **If Path F — Workstream B1 (commerce context):** add
   `getCommerceContext` to `BridgeConfig`; new `CommerceContext` type in
   `src/core`; inject a compact context block as a *non-cached* system block in
   `bridge.runAiReply` (keep the brand prompt cached); surface context to the
   dashboard via `getChat`/`listChats` + a `chat:context` event. Extend
   `AiReplyContext` with `commerceContext`. Add a fake-provider test asserting
   the block is passed.
3. **Then B2 (AI tool-use):** extend `AIProvider` ctx with `tools` + `runTool`;
   implement the Anthropic tool-use loop in `AnthropicProvider` (SDK ≥0.97
   installed); wire `commerceTools` from config; guard with an allow-list,
   max-iterations, and customer-scoping. Follow the `claude-api` skill.
4. **Workstream C** (parallelizable): implement `PostgresStorage`
   (`pg`, atomic claim), `registerLocale` registry, `BridgeConfig.beforeSend`
   rate-limit hook.

Always finish with `corepack pnpm typecheck && test && build` green and a
CHANGELOG line. Do **not** `git init` until the MVP checklist above is ticked.
