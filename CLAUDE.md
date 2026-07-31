# livechat-bridge — project context

Embeddable multi-site live chat published as an npm package: a React widget for
visitors, an agent inbox for staff, Mongoose-backed route handlers for the
server. Author: Hossain Billal. MIT.

## Non-negotiables

- **`siteId` is the tenant key.** Every Mongoose query filters on it; every
  schema indexes it as the leading field of a compound index. A query without
  `siteId` is a cross-tenant leak — treat it as a bug, not a style issue.
- **Visitors may be anonymous.** Identity is optional; a signed session token
  carrying `visitorId` is the auth boundary for the visitor side.
- **`src/types.ts` is the contract** binding all three entry points. Change it
  deliberately — widget, server, and admin all depend on it.

## Commands

`pnpm` is **not on PATH** — use `corepack pnpm`.

```bash
corepack pnpm install
corepack pnpm typecheck   # tsc --noEmit
corepack pnpm test        # vitest run
corepack pnpm build       # tsup → dist/ (ESM + CJS + d.ts)
```

End every session with all four green.

## Layout

Three independent entry points over one shared contract:

- `src/types.ts` — shared types. No runtime, no deps; imports cleanly into
  browser, Node, and edge.
- `src/widget/` → `livechat-bridge/widget`. `transport.ts` holds the
  WebSocket-first / long-poll-fallback state machine and is **framework-free
  and injectable** so it tests in plain Node; `useChatSocket.ts` is a thin React
  wrapper over it.
- `src/server/` → `livechat-bridge/server`. `models/` (Mongoose),
  `handlers/` (Web-standard `Request` → `Response`, no framework imports),
  `session.ts` (HMAC via Web Crypto — no `jsonwebtoken`, must run on edge),
  `events.ts` (in-process fan-out + replay buffer), `ai/`.
- `src/admin/` → `livechat-bridge/admin`. Agent inbox UI; talks to the server
  over HTTP only.

Widget and admin never import from each other or from `src/server/`.

## Conventions

- ESM with explicit `.js` import extensions, even from `.ts`/`.tsx`.
- TypeScript strict + `noUncheckedIndexedAccess`.
- Tests in `tests/*.test.ts`, `environment: 'node'`. Prefer injectable fakes over
  jsdom — the transport and handlers are both designed to allow this.
- No new runtime dependencies without a strong reason; `react`, `mongoose`, and
  `@anthropic-ai/sdk` are all **optional** peers.
- CSS is prefixed (`.lcb-`, `.lcb-admin-`) because the widget renders on
  third-party pages, and themed with CSS custom properties.
- Match surrounding comment density: explain *why*, not *what*.

## History

`docs/PHASE-2-PLAN.md` describes the **superseded** v0.2.0 adapter architecture
(StorageAdapter / Transport / AIProvider, logged-in-only, single-tenant). It is
kept for context only. That tree is recoverable at the baseline commit.
