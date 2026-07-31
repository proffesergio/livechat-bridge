# TestRun.md

> The hands-on companion to [`LiveChatSupport.md`](./LiveChatSupport.md).
> `LiveChatSupport.md` is the *API* reference (what each prop does, what the
> server config takes). This file covers **operations** — how to run the
> package locally, how to version-control it, how to ship a new release, and
> how to deploy a host app to production.

---

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Run the library locally](#2-run-the-library-locally)
3. [Run the bundled demo app](#3-run-the-bundled-demo-app)
4. [Test inside your own host app](#4-test-inside-your-own-host-app)
5. [Version control — initial GitHub push](#5-version-control--initial-github-push)
6. [Version control — day-to-day feature workflow](#6-version-control--day-to-day-feature-workflow)
7. [Cutting a release (publishing a new version)](#7-cutting-a-release-publishing-a-new-version)
8. [Production deployment — Node / Next.js host apps](#8-production-deployment--node--nextjs-host-apps)
9. [Operational checks & troubleshooting](#9-operational-checks--troubleshooting)

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | **≥ 18.17** (LTS 20 / 22 recommended) | Web `Request`/`Response`, Next 14, native `fetch`. |
| pnpm | bundled via Corepack | This repo standardizes on pnpm. |
| Git | any recent | Version control. |
| Docker | optional | Only needed for the self-hosted Pusher recipe. |

**About pnpm.** This repo uses Corepack — `pnpm` may not be on your `PATH`.
Run it via `corepack pnpm <command>` (or run `corepack enable` once and just
`pnpm`). The Corepack form is what scripts and CI assume.

Don't disable the `esbuild` install script — it's allowlisted in
`pnpm-workspace.yaml` (`allowBuilds: { esbuild: true }`) and `tsup` won't build
without it.

---

## 2. Run the library locally

Clone, install, and verify everything is green:

```bash
git clone <your-fork>.git livechat-bridge
cd livechat-bridge
corepack pnpm install
```

Four checks should always pass before you commit:

```bash
corepack pnpm typecheck     # tsc --noEmit, strict mode
corepack pnpm test          # vitest run (unit + integration)
corepack pnpm build         # tsup → dist/ (ESM + CJS + d.ts)
corepack pnpm test:watch    # optional, while iterating
```

What each check is for:

- **typecheck** — strict mode catches API drift the runtime would silently
  ignore (rename a prop, forget to widen an interface).
- **test** — the `tests/` suite (unit + the full-flow `integration.test.ts`).
  37 tests as of 0.2.0.
- **build** — produces `dist/` (the npm artifact). The CSS and i18n JSON are
  copied in by an `onSuccess` hook — confirm the `✓ copied CSS + i18n assets`
  line.

Useful one-offs:

```bash
corepack pnpm vitest run tests/integration.test.ts   # one suite
corepack pnpm vitest tests/bridge.test.ts            # watch one suite
corepack pnpm tsc --noEmit --watch                   # continuous typecheck
```

---

## 3. Run the bundled demo app

A runnable Next.js host app lives at [`examples/nextjs-minimal/`](./examples/nextjs-minimal/).
It uses **SSE transport + in-memory storage + a canned AI provider**, so it
needs **no API keys**.

```bash
# 1. From repo root — build the library so the demo has a dist/ to link to.
corepack pnpm install
corepack pnpm build

# 2. Install + run the demo
cd examples/nextjs-minimal
pnpm install              # resolves `livechat-bridge` via `link:../..`
pnpm dev                  # http://localhost:3030
```

To upgrade the demo to real Claude replies:

```bash
cp .env.example .env.local
# edit .env.local → ANTHROPIC_API_KEY=sk-ant-...
pnpm dev
```

To exercise the full lifecycle:

1. Open <http://localhost:3030> in two browsers (or one normal + one
   incognito).
2. Sign in as **Alice** (customer) in window A. Sign in as **Bob** with the
   *staff* checkbox in window B — Bob lands on `/admin`.
3. From Alice, open the bubble and send a message.
4. From Bob, claim the chat and reply. Watch the customer UI update live.
5. Optional: don't claim. Wait 30 s and the demo AI provider posts a reply
   automatically. Short the wait with `AI_FALLBACK_MS=8000` in `.env.local`.

If you change library source, rebuild it (`pnpm build` at root) — the demo's
`link:../..` follows the symlink, so a refresh picks up the change.

---

## 4. Test inside your own host app

Two ways to validate a library change against a real consumer before you
publish.

### Option A — pnpm link (fastest iteration)

```bash
# in livechat-bridge/
corepack pnpm build
corepack pnpm link --global

# in your host app/
pnpm link --global livechat-bridge
```

Unlink when done: `pnpm unlink --global livechat-bridge` then `pnpm install`
in the host app to restore the registry version.

### Option B — `pnpm pack` (closest to a real publish)

```bash
# in livechat-bridge/
corepack pnpm build
corepack pnpm pack             # → livechat-bridge-0.2.0.tgz

# in your host app/
pnpm add /absolute/path/to/livechat-bridge-0.2.0.tgz
```

This is the dress rehearsal for `pnpm publish`: the tarball is exactly what
ends up on npm.

### Option C — repo `link:` dependency

If your host app lives next to this repo, point its `package.json` at the
checkout directly — same mechanism the bundled demo uses:

```jsonc
{
  "dependencies": {
    "livechat-bridge": "link:../livechat-bridge"
  }
}
```

---

## 5. Version control — initial GitHub push

This repo is **not** under git yet by design — `livechat-bridge` waits to be
pushed until v0.2.0 is presentable. When you're ready, run the steps below
**from the repo root** (`/home/hossain/livechat-bridge`). You only do this
once.

```bash
# 1. Sanity: everything green.
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build

# 2. Initialize and make the first commit.
git init
git branch -M main
git add .
git status                         # confirm .env, node_modules, dist are NOT staged
git commit -m "Initial public release — livechat-bridge 0.2.0"

# 3. Create the GitHub repo (Web UI or gh CLI).
gh repo create <owner>/livechat-bridge --public --source=. --remote=origin --description="Drop-in live chat widget + AI fallback for Next.js / React"

# 4. Push.
git push -u origin main
git tag v0.2.0 -m "0.2.0 — realtime independence + runnable demo"
git push origin v0.2.0
```

If you'd rather avoid the `gh` CLI, create the empty repo on github.com first,
then `git remote add origin git@github.com:<owner>/livechat-bridge.git` before
the `git push`.

**Before the first push, double-check:**

- `dist/`, `node_modules/`, and `.env*` are listed in `.gitignore`. They are
  in the shipped `.gitignore`; verify with `git status --ignored` after
  staging.
- The `repository.url` field in `package.json` points at your real GitHub
  repo (it currently lists `proffesergio/livechat-bridge` — update it before
  pushing if you're forking).
- The bundled demo (`examples/nextjs-minimal/.gitignore`) excludes its own
  `node_modules` and `.next`.
- No secret keys are committed. `git grep -E 'sk-ant-|MONGO_URL=|PUSHER_SECRET='`
  should return nothing.

---

## 6. Version control — day-to-day feature workflow

A small, predictable loop that maps cleanly to the four checks in §2.

```text
main ──●──●──●─────────●──●───▶
        \         /
         feat/<scope>──●──●  (PR)
```

1. **Branch.** `git checkout -b feat/<short-scope>` (or `fix/`, `docs/`,
   `chore/`).
2. **Write a failing test first** when you're fixing a bug or adding a feature
   that has observable behavior. The test suite is fast — keep it the source
   of truth.
3. **Make the change**, keeping diffs focused.
4. **Run the four checks** every time:
   ```bash
   corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
   ```
5. **CHANGELOG.** Add a line under `## Unreleased` describing the user-visible
   change. Use **Added / Changed / Fixed / Removed** sections. No entry =
   not a user-visible change; that's fine.
6. **Commit & push.** One commit per logical change is ideal; squash later if
   needed.
   ```bash
   git add -p
   git commit -m "feat(transport): add Redis-backed PubSub for SSE fan-out"
   git push -u origin feat/<scope>
   ```
7. **Open a PR.** Reference the issue (if any). The PR description should
   answer: *what changed, why, and how to verify.* Reuse the matching
   sections from the CHANGELOG entry.
8. **Merge to `main`.** Squash-merge is recommended so the history reads as
   one feature per commit.

### Coding rules to keep in mind

- Public API lives behind the `exports` map in `package.json`. Adding a new
  module? Add it there and verify it appears in `dist/` after `pnpm build`.
- New realtime / storage / AI backends implement the existing interface —
  don't fork the bridge.
- ESM with explicit `.js` import extensions even from `.ts` files (the build
  setup relies on it).
- Match the surrounding comment density; tests live in `tests/` with fakes in
  `tests/fakes.ts`.
- The code-review-graph MCP is faster than ad-hoc `grep` for exploration —
  prefer it when you're tracing callers / impact (see `~/CLAUDE.md`).

### Hotfix workflow

For an urgent fix that can't wait for the next minor release:

```bash
git checkout -b hotfix/0.2.1 v0.2.0
# … fix …
# bump patch in package.json → 0.2.1
# add CHANGELOG entry under ## 0.2.1
git commit -am "fix: <one-line summary>"
git tag v0.2.1 -m "0.2.1"
git push origin hotfix/0.2.1 v0.2.1
# open a PR back to main once it's tagged
```

---

## 7. Cutting a release (publishing a new version)

A release is **bump → CHANGELOG → tag → publish**. Each step is reversible up
until `pnpm publish`.

### 7.1 Decide the version

Follow [Semantic Versioning](https://semver.org/):

- **Patch** (`0.2.x → 0.2.y`) — bug fixes only, no API changes.
- **Minor** (`0.2.x → 0.3.0`) — backwards-compatible additions (new exports,
  new optional props).
- **Major** (`0.x → 1.0`) — breaking changes (renamed/removed exports, prop
  rename without a shim).

Until 1.0, we deliberately treat minor bumps as the boundary where deprecated
shims may be removed (e.g. the `pusher` prop is scheduled for removal in
0.3.0 — see `LiveChatSupport.md`).

### 7.2 Pre-flight

```bash
# Latest main, clean tree.
git checkout main && git pull && git status

# All four checks green.
corepack pnpm install
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build

# Dry-run the publish — same tarball as the real thing, no upload.
corepack pnpm publish --dry-run
```

`pnpm publish --dry-run` prints exactly which files the registry will receive.
It should include `dist/`, `LICENSE`, `README.md`, `LiveChatSupport.md` — and
nothing else. Anything else? Re-check the `files` array in `package.json`.

### 7.3 Bump and document

```bash
# Bump in package.json. Don't use `pnpm version` — it auto-tags / auto-commits
# without giving you a chance to update the CHANGELOG.
# Edit package.json by hand: "version": "0.3.0"

# Promote the "## Unreleased" section in CHANGELOG.md to "## 0.3.0 — YYYY-MM-DD".
# Leave an empty "## Unreleased — next" header above it for future work.

git add package.json CHANGELOG.md
git commit -m "chore(release): 0.3.0"
```

### 7.4 Tag and publish

```bash
git tag v0.3.0 -m "0.3.0 — <one-line summary>"
git push origin main v0.3.0

# Final build + publish. `prepublishOnly` re-runs build + test for you.
corepack pnpm publish --access public
```

For pre-releases:

```bash
# package.json: "version": "0.3.0-rc.1"
corepack pnpm publish --tag next --access public
# consumers opt in: pnpm add livechat-bridge@next
```

### 7.5 Roll back

- **Wrong tag / not yet `pnpm publish`d:** `git tag -d v0.3.0 && git push --delete origin v0.3.0`.
- **Published but broken:** **don't `npm unpublish`** within 72 hours unless
  you have to — it permanently burns the version number. Instead, publish a
  fixed `0.3.1` immediately and add a `## 0.3.1` CHANGELOG note.

---

## 8. Production deployment — Node / Next.js host apps

This package is consumed by **the host app**; you don't deploy
livechat-bridge itself. What follows are the patterns that work in
production, indexed by the host's runtime.

### 8.1 Runtime decision tree

```
Need durable realtime (long-lived SSE, low reconnect churn)?
├── Yes ─▶ Run Next.js on a persistent Node host  (Render / Fly / Railway / Docker / EC2)
│           Transport options: SSE • Pusher SaaS • self-hosted Sockudo
│
└── No  ─▶ Serverless (Vercel / Netlify Functions) is fine
            Transport options: Pusher SaaS • self-hosted Sockudo (recommended)
            SSE works but `EventSource` reconnects every ~10–60 s (platform-capped)
```

Quick rule of thumb: if your host is **Vercel free/pro** and you want a
*managed* deploy, use the **Pusher SaaS** transport or stand up Sockudo on
a tiny VM. If you self-host Next.js anyway, **SSE is the simplest path**.

### 8.2 Singleton bridge

This is the single most common production bug we expect to see.

The bridge holds an **in-memory AI fallback timer table.** It must be a
process singleton — one bridge per process, created at module load, not
inside a route handler. The demo's [`app/lib/livechat.ts`](./examples/nextjs-minimal/app/lib/livechat.ts)
stashes the bridge on `globalThis` to survive Next.js dev-mode reloads:

```ts
declare global { var __lcbBridge: Promise<LiveChatBridge> | undefined; }
export function getBridge() {
  globalThis.__lcbBridge ??= createBridge();
  return globalThis.__lcbBridge;
}
```

Use the same pattern in your host app.

### 8.3 Vercel / Netlify (serverless) deploy

```text
+-----------------+      Pusher / Sockudo
|  Browser widget |◀─────────────────────┐
+--------┬--------+                      │
         │ /api/livechat/*               │
         ▼                               │
+-----------------+   trigger(...)       │
| Next.js fn lambda │────────────────────┘
+--------┬--------+
         ▼
   Mongo / Postgres (managed)
```

1. Push your host app to GitHub.
2. Import the repo into Vercel.
3. Set env vars in the project settings: `MONGO_URL`, `ANTHROPIC_API_KEY`,
   `PUSHER_*` (or Sockudo hostnames), `NEXT_PUBLIC_PUSHER_*`.
4. **Do not** use `SSETransport` here unless you accept reconnect churn — the
   platforms cap streaming responses (Vercel: ~10 s hobby / ~60 s pro).
5. Deploy. Smoke-test with two windows (customer + staff), exactly like the
   demo flow in §3.

### 8.4 Self-hosted Node (Render / Fly / Railway / Docker / EC2)

Everything you've seen in the demo works unchanged. SSE is durable on Node
runtimes that don't time-cap responses.

```bash
# In your host app
pnpm build
NODE_ENV=production node .next/standalone/server.js
# or: pm2 start, or your Dockerfile's CMD
```

Health considerations:

- **Behind a proxy?** Set `proxy_buffering off` (nginx) so SSE flushes
  immediately. The `x-accel-buffering: no` header is already sent by the
  stream handler, but proxies sometimes need explicit config.
- **Multi-instance.** `InMemoryPubSub` only fans events out within one
  process. Two app instances? Pass a Redis-backed `PubSub` to `SSETransport`,
  or switch to the Pusher / Sockudo transport so realtime is centralized.
- **TLS.** `useTLS: true` for Pusher in production. SSE rides whatever TLS
  your reverse proxy terminates.
- **Process lifecycle.** Graceful shutdown should `bridge._scheduler.reset()`
  to abort in-flight AI calls; the framework also clears them on `SIGTERM`
  if you call `process.exit` after a brief drain.

### 8.5 Docker deploy with self-hosted Sockudo (no Pusher account, no SSE caveats)

```yaml
# docker-compose.yml (host app side)
services:
  app:
    image: your-host-app:latest
    environment:
      PUSHER_HOST: sockudo
      PUSHER_PORT: 6001
      NEXT_PUBLIC_PUSHER_HOST: chat.example.com
      NEXT_PUBLIC_PUSHER_PORT: 443
      MONGO_URL: mongodb://mongo:27017/app
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
    depends_on: [sockudo, mongo]
    ports: ['3000:3000']

  sockudo:
    extends:
      file: ./livechat-bridge/examples/self-hosted-realtime/docker-compose.yml
      service: sockudo

  mongo:
    image: mongo:7
    volumes: ['mongo-data:/data/db']

volumes:
  mongo-data:
```

Front-end env vars (`NEXT_PUBLIC_*`) point at the **publicly reachable**
Sockudo hostname; server-side vars point at the **service name** on the
internal Docker network. See
[`examples/self-hosted-realtime/`](./examples/self-hosted-realtime/) for the
Sockudo config and an `.env.example`.

### 8.6 Production checklist

- [ ] Bridge is a process singleton (`globalThis.__lcbBridge`).
- [ ] `MONGO_URL` (or other persistent storage) is set — **not** `MemoryStorage`.
- [ ] `ANTHROPIC_API_KEY` is set, *or* AI is disabled via `aiFallbackMs: 0` /
      omitting `ai`.
- [ ] `aiSystemPrompt` overrides the default with brand-specific text.
- [ ] Admin route (`/admin` or wherever you mount `AdminDashboard`) is gated
      by middleware, not just the in-component "staff only" check.
- [ ] Rate limiting in front of `POST /api/livechat/messages` (edge
      middleware, `Cache-Control`, or a Redis-backed counter). The bridge
      itself does **not** rate-limit.
- [ ] If using SSE: confirm proxy buffering is off and the host runtime
      doesn't time-cap responses.
- [ ] If using Pusher / Sockudo: `useTLS: true`, channel auth endpoint
      reachable, `NEXT_PUBLIC_*` vars match the publicly reachable host.
- [ ] CSS imported (`livechat-bridge/react/widget.css`,
      `…/admin.css`) — without it the widget falls back to unstyled HTML.
- [ ] `getViewer` returns `null` (not throws) for unauthenticated requests.
- [ ] Observability: the package logs unhandled errors with `[livechat-bridge]`
      prefix — pipe stderr to your log drain.

---

## 9. Operational checks & troubleshooting

### Smoke test in production

After a deploy, two-window the flow:

1. Customer window: open the widget, send "ping".
2. Staff window: see it in the queue within ~1 s. Claim. Reply "pong".
3. Customer window: shows "pong" without manual refresh.
4. Optional AI test: in a third (incognito) window, send a message and **do
   not** claim. After `aiFallbackMs`, an AI reply should appear.

If any of steps 2–4 fails, jump to the matching section in
[`LiveChatSupport.md` § Troubleshooting](./LiveChatSupport.md#troubleshooting)
first — most common issues have an entry there.

### Build-time sanity checks

```bash
# Did the build pull in any missing peer dep?
corepack pnpm build 2>&1 | grep -i 'external\|cannot'

# Are the right files in the published tarball?
corepack pnpm pack --dry-run

# Is the type surface what consumers actually see?
node -e "import('livechat-bridge/server').then(m => console.log(Object.keys(m)))"
```

### Common gotchas

- **"Sign in to chat" for a logged-in user.** `getViewer` returned `null`.
  Check session/cookie reads inside the route handler.
- **AI never replies.** `aiFallbackMs: 0`, missing `ai` in config, or the
  Anthropic SDK isn't installed. The fallback timer prints nothing on its
  own — instrument with a log inside `getViewer` to confirm requests arrive.
- **SSE drops every 10 s on Vercel.** Expected — pick Pusher/Sockudo or move
  to a persistent Node host. The `EventSource` will reconnect transparently,
  but staff will see chat-queue gaps under load.
- **`MongoStorage` "model already defined".** You called
  `mongoose.connect(...)` more than once. Make it a singleton like the
  bridge itself.
- **`pnpm` not found.** Use `corepack pnpm <cmd>` — Corepack ships with
  recent Node and provides `pnpm` without a global install.
- **`tsup` build fails citing esbuild.** `pnpm-workspace.yaml` must contain
  `allowBuilds: { esbuild: true }`. Don't remove it.

---

### Where to next

- API details: [`LiveChatSupport.md`](./LiveChatSupport.md)
- Roadmap & in-flight work: [`docs/PHASE-2-PLAN.md`](./docs/PHASE-2-PLAN.md)
- Self-hosted realtime: [`examples/self-hosted-realtime/`](./examples/self-hosted-realtime/)
- Runnable demo: [`examples/nextjs-minimal/`](./examples/nextjs-minimal/)
