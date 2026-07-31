# Changelog

## 0.3.0 — 2026-07-31

**Breaking: the package was rewritten as an embeddable multi-site product.**
0.2.0 was a single-app, logged-in-only library built on adapter indirection.
0.3.0 is a multi-tenant widget any website can embed, with anonymous visitors.
There is no migration path — treat it as a new package surface.

### Added
- **`siteId` multi-tenancy.** Every document carries a `siteId`; every query
  filters on it; every schema indexes it as the leading field of a compound
  index. `tests/tenant-isolation.test.ts` seeds two sites and asserts every
  handler refuses to cross the boundary.
- **Anonymous visitors.** `POST /session` mints a signed session token bound to
  one `siteId` + `visitorId`. Hosts that know their user can pass an
  `identity` plus an `identityHmac` to upgrade the session to a named one.
- **Three entry points** — `livechat-bridge/widget`, `livechat-bridge/server`,
  `livechat-bridge/admin`, over a shared `src/types.ts` contract.
- **WebSocket-first transport with HTTP long-poll fallback.** Exponential
  backoff with jitter, a monotonic `seq` cursor so no event is lost when
  switching transports, and deduplication of replayed events. `polling` is a
  healthy state, not an error.
- **Agent inbox** (`AgentInbox`, `ConversationList`) — status filters with live
  counts, atomic claim with graceful 409 handling, per-conversation unread
  badges, keyboard navigation, and a visitor-detail pane.
- **File uploads** — pluggable `UploadStore`, with size and MIME limits plus
  filename sanitisation enforced before any I/O.
- **Session tokens via Web Crypto HMAC-SHA256** — no `jsonwebtoken` dependency,
  so the server entry runs on edge runtimes. Timing-safe verification.
- **CI** — `.github/workflows/ci.yml` runs typecheck, test, build across Node
  18/20/22 and verifies the publishable tarball.

### Changed
- `exports` map is now `.`, `./widget`, `./server`, `./admin`, `./widget.css`,
  `./admin.css`. The root entry is types-only so importing shared types never
  drags React into a server bundle or Mongoose into a browser bundle.
- `react`, `react-dom`, `mongoose`, and `@anthropic-ai/sdk` are all **optional**
  peer dependencies.
- CSS selectors are prefixed (`.lcb-`, `.lcb-admin-`) because the widget renders
  on third-party pages, and themed via CSS custom properties with dark-mode and
  reduced-motion support.

### Removed
- The `StorageAdapter` / `Transport` / `AIProvider` adapter layer, the
  `createLiveChatBridge` orchestrator, and the `/core` + `/react` +
  `/server/nextjs` entry points.
- Pusher and Sockudo/Soketi support, along with `examples/self-hosted-realtime/`
  — the Pusher protocol is no longer part of the design.
- The bundled English/Bangla i18n JSON. Locale handling is being reconsidered
  for the new surface.

> The 0.2.0 architecture remains recoverable at the repository's baseline commit.
> `docs/PHASE-2-PLAN.md` documents it and is retained for historical context.

## 0.2.0 — 2026-05-24

### Added
- **Realtime independence.** Realtime is now pluggable via a client-side
  `RealtimeClient` abstraction:
  - `SSETransport` (server) + `SSERealtimeClient` (client) — Server-Sent Events
    with no WebSocket server. New `stream` route handler / `GET
    /api/livechat/stream`, authorized with the same ACL as Pusher auth.
  - `PubSub` interface with `InMemoryPubSub` (single instance); Redis-backed
    fan-out documented for multi-instance.
  - `PusherRealtimeClient` wrapping `pusher-js`; works against self-hosted
    Pusher-protocol servers (Sockudo/Soketi) by config alone.
  - `examples/self-hosted-realtime/` — Sockudo + Redis docker-compose recipe.
- `bridge.authorizeSubscription(req, channel)` — shared channel ACL.
- `@anthropic-ai/sdk` bumped to current stable (prompt caching is now GA on the
  stable `messages.create`); peer range widened to `>=0.32.0`.
- **Runnable demo app** at `examples/nextjs-minimal/` — Next.js 14 App Router,
  SSE transport, in-memory storage, cookie-based demo auth, fake AI provider
  that upgrades to Claude when `ANTHROPIC_API_KEY` is set.
- **Full-flow integration test** (`tests/integration.test.ts`) hitting the
  route handlers with real `Request`/`Response` objects across the
  send → AI fallback → claim → close lifecycle, plus SSE stream framing and
  every authorization boundary. Test count: 26 → 37.
- **TestRun.md** — operations guide: local test workflow, version control,
  release process (`pnpm publish` dry-run + tagging), and production deploy
  recipes for Vercel, self-hosted Node, and Docker + Sockudo hosts.
- **README rewritten** for GitHub-first discovery — overview diagram, 60-second
  quick start, transport comparison table, doc tree.

### Changed
- `LiveChatWidget` / `AdminDashboard` take a `realtime` prop. The `pusher` prop
  still works (wrapped automatically) but is **deprecated** and will be removed
  after 0.2.x. `usePusherChannel` is deprecated in favor of `useRealtimeChannel`.
- `package.json#files` now ships `TestRun.md` and `CHANGELOG.md` alongside
  `dist/`, `LICENSE`, `README.md`, and `LiveChatSupport.md`.

## 0.1.0 — 2026-05-20

Initial release.

- Pusher Channels realtime transport
- Mongo + In-Memory storage adapters (Postgres stub)
- Anthropic Claude AI provider (OpenAI / Gemini stubs)
- React widget for end users
- React admin dashboard for staff
- 30-second AI fallback with graceful staff hand-off
- Manual-claim chat queue
- English + Bangla i18n
- Next.js App Router server adapter
