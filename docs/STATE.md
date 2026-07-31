# Project state — resume here

> Last updated **2026-07-31**, at the end of the 0.3.0 rewrite.
> Read this first when resuming on a new machine or in a new session.

## How to get running from a fresh clone

```bash
git clone https://github.com/proffesergio/livechat-bridge.git
cd livechat-bridge
corepack pnpm install        # `pnpm` is NOT on PATH — always go through corepack
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
```

All three must be green before you start and before you finish. On a cold
machine the first `pnpm test` downloads a `mongod` binary (~100 MB) for
`mongodb-memory-server`; that is expected and cached afterwards.

**Environment gotchas that have already cost time:**

- `pnpm` is not on PATH. Use `corepack pnpm`.
- Do **not** re-add `pnpm-workspace.yaml`. This is a single package; a workspace
  file without a `packages:` field makes pnpm 9.12 fail *every* script with
  "packages field missing or empty". The esbuild build allowance now lives in
  `package.json` under `pnpm.onlyBuiltDependencies`.

## Where things stand

**0.3.0 is a complete, tested rewrite.** 77 tests, typecheck clean, build green,
pushed to `main`.

| Area | State |
|---|---|
| Shared contract (`src/types.ts`) | Done. `RealtimeEnvelope` is a discriminated union — `switch (env.event)` narrows `env.data`. |
| Server (`src/server/`) | Done. Models, handlers, router, sessions, events, uploads, AI fallback. |
| Widget (`src/widget/`) | Done. WebSocket-first transport with long-poll fallback, 8 reconnect tests. |
| Admin (`src/admin/`) | Done. Three-pane inbox, atomic claim, read receipts, keyboard nav. |
| CI | Done. Node 18/20/22, typecheck + test + build + `pnpm pack --dry-run`. |
| Security review | Done for sessions, tenant isolation, CORS, NoSQL injection, uploads, routing. No HIGH/MEDIUM findings. |
| **Runnable demo app** | **MISSING — top follow-up.** See below. |
| Published to npm | Not yet. Never published; `0.2.0` was never released either. |

## Architecture in one paragraph

Three independent entry points over one shared contract. `src/types.ts` has no
runtime and no dependencies, so it imports cleanly into a browser bundle, Node,
and edge. `livechat-bridge/widget` and `livechat-bridge/admin` never import from
each other or from `src/server/` — they speak HTTP only. `siteId` is the tenant
key on every document and every query. Visitors are anonymous by default and
carry an HMAC-signed session token binding one `siteId` + one `visitorId`.

Read `CLAUDE.md` for the conventions; it is deliberately short.

## Next tasks, in priority order

1. **Rebuild the demo app** (`examples/nextjs-minimal/`). The 0.2.0 demo was
   deleted in the rewrite because it imported the old API — it is recoverable at
   the baseline commit `85993b9` if you want its structure as a starting point.
   This is the biggest gap for anyone evaluating the package, and it is also what
   a screenshot/GIF in the README needs.
2. **Ship a WebSocket server helper.** The transport is WebSocket-first but the
   package only implements the long-poll side; `socketUrl` currently has to point
   at something the host wrote. A small `ws`-based attach helper for Node hosts
   would make the headline feature real out of the box.
3. **Signed attachment ids.** See "Known limitation" in the README — a visitor
   can currently supply an arbitrary attachment `url` on send.
4. **Redis-backed events.** `src/server/events.ts` and `src/server/ai/fallback.ts`
   are both in-memory, so today it is **one bridge process per deployment**. Both
   files document the seam. This is the blocker for horizontal scaling.
5. **Agent directory endpoint.** `conversation:assigned` carries only
   `{id, name, avatarUrl}`, so the inbox cannot render "assigned to X" for agents
   it has not otherwise loaded.
6. **i18n.** The 0.2.0 English/Bangla bundles were dropped in the rewrite and
   have not been reintroduced.
7. **Publish.** `corepack pnpm pack --pack-destination /tmp` first, confirm the
   tarball, then `npm publish --access public`. (Note: pnpm has no `--dry-run`
   for `pack`.)

## Decisions already made — do not relitigate without a reason

- **`siteId` is the tenant key**, anonymous visitors are supported, and the three
  entry points are `widget` / `server` / `admin`. These were explicitly approved
  on 2026-07-31 and they reverse the older `docs/PHASE-2-PLAN.md`, which is kept
  only as history.
- Mongoose models are exposed directly; the old `StorageAdapter` / `Transport` /
  `AIProvider` adapter indirection was removed on purpose.
- Pusher / Sockudo / SSE are gone. Transport is WebSocket + long-poll.
- Cross-tenant reads return **404, not 403**, so ids on other tenants are not
  confirmed. Keep it that way.
- `x-site-id` is honoured **only** on `POST /session`. Every authenticated
  request derives `siteId` from verified token claims or the resolved agent.
- Commits in this repo carry **no AI attribution** in the message.
