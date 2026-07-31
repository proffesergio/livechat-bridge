# livechat-bridge — project context for Claude

> Drop-in live chat widget + staff dashboard + Claude AI fallback, published as a
> reusable npm package for **Next.js / React** apps. Author: Hossain Billal.
> Not a SaaS, not a PHP/WooCommerce/OpenCart plugin — those are explicitly out of
> scope. Chat is **logged-in only** (no anonymous guests).

## Where the plan lives

- **`docs/PHASE-2-PLAN.md`** — the active roadmap (Workstreams A/B/C), progress
  log, and a "Next session — start here" block. Read it first when resuming.
- **`CHANGELOG.md`** — `Unreleased — 0.2.0` tracks Phase 2 work.

## Commands (IMPORTANT environment notes)

`pnpm` is **not on PATH** here — invoke it via `corepack pnpm` (corepack is
installed). esbuild's build script must stay allowed in `pnpm-workspace.yaml`
(`allowBuilds: { esbuild: true }`) or `tsup` breaks.

```bash
corepack pnpm install
corepack pnpm typecheck   # tsc --noEmit
corepack pnpm test        # vitest run
corepack pnpm build       # tsup → dist/ (ESM + CJS + d.ts)
```

Always end a work session with all four green.

## Architecture (mental model)

Three layers, swappable via interfaces. The bridge is the orchestrator; adapters
are injected.

- **`src/core/`** — framework-free types, schemas (zod), events, ids, errors.
  `EVENTS`, `chatChannel(id)`, `STAFF_CHANNEL`, `CHAT_STATUS`, `SENDER_TYPE`.
- **`src/server/bridge.ts`** — `createLiveChatBridge(config)`. Owns the
  claim/AI-fallback state machine and an in-memory timer table (`ai-scheduler`).
  **One bridge per process** (timers live in memory).
- **Adapters** (injected into the bridge):
  - `src/server/transport/` — realtime. `Transport` iface in `types.ts`;
    `PusherTransport`; `SSETransport` (a `SubscribableTransport`).
  - `src/server/pubsub/` — `PubSub` + `InMemoryPubSub` (backs SSE fan-out).
  - `src/server/adapters/storage/` — `StorageAdapter`: `MongoStorage`,
    `MemoryStorage`, `PostgresStorage` (**stub — throws**, not yet implemented).
    `claimChat` MUST be atomic.
  - `src/server/adapters/ai/` — `AIProvider`: `AnthropicProvider` (uses prompt
    caching), OpenAI/Gemini stubs.
- **`src/server/handlers/`** — Web-standard `Request`→`Response` handlers
  (runtime-portable). `src/server/nextjs.ts` is a thin App Router adapter.
- **`src/react/`** — `LiveChatWidget`, `AdminDashboard`, and `shared/`:
  `RealtimeClient` abstraction (`PusherRealtimeClient`, `SSERealtimeClient`),
  `useRealtimeChannel`, `api`, `i18n`.

Auth boundary is the single `getViewer(req)` hook. Channel ACL lives in
`bridge.authorizeSubscription` (shared by Pusher auth and the SSE stream).

## Conventions

- ESM with explicit `.js` import extensions even from `.ts` files.
- Handlers stay framework-agnostic (Web `Request`/`Response`); Next.js specifics
  only in `nextjs.ts`.
- New realtime/storage/ai backends implement the existing interface — don't
  special-case them in the bridge.
- Match the surrounding comment density and naming; tests live in `tests/` with
  fakes in `tests/fakes.ts`.
- This repo has a **code-review-graph MCP** (see `~/CLAUDE.md`) — prefer it over
  raw Grep/Glob for exploration and impact analysis.

## Status (2026-05-21)

- Phase 1 (v0.1.0): complete, builds green.
- Phase 2 Workstream A (realtime independence: `RealtimeClient` abstraction, SSE
  transport, pub/sub, Sockudo recipe): **done**, 26 tests pass.
- Not committed to git yet — push a new repo only after a presentable,
  production-ready MVP (see the MVP checklist in `docs/PHASE-2-PLAN.md`).
