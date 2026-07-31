# Changelog

## Unreleased — next

_No user-visible changes yet._

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
