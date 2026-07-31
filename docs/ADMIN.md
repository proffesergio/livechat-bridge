# Admin guide — test locally, then deploy live

Everything an operator needs to run `livechat-bridge` in a real app. For the API
surface see the [README](../README.md); for project status see [STATE.md](./STATE.md).

---

## Part 1 — Test locally

### 1.1 Verify the package itself

```bash
corepack pnpm install
corepack pnpm typecheck   # tsc --noEmit
corepack pnpm test        # vitest run — 77 tests
corepack pnpm build       # tsup → dist/
```

`pnpm` is not on PATH; always go through `corepack`. The first test run downloads
a `mongod` binary for the in-memory database — expected once, cached after.

What the suites prove:

| Suite | Proves |
|---|---|
| `tenant-isolation` | A site-A token cannot read, send, list, claim, or close anything on site B — including with a forged `x-site-id` header. |
| `session` | Signature, expiry, tampering, and wrong-secret rejection. |
| `handlers` | Full lifecycle, plus two agents racing to claim (exactly one wins). |
| `upload` | Oversize, disallowed MIME, and path-traversal filenames all rejected. |
| `router` | Path dispatch, mount-prefix detection, read receipts persisting. |
| `transport` | Reconnect backoff, WS→poll fallback, no lost or duplicated events. |

### 1.2 Wire it into a local app

You need MongoDB. Fastest option:

```bash
docker run -d -p 27017:27017 --name livechat-mongo mongo:7
```

Link the package into your app while iterating:

```bash
corepack pnpm build
node scripts/dev-link-atharnur.mjs ../your-app   # or: pnpm link ../your-app
```

Set the app's environment:

```bash
# .env.local
MONGODB_URI=mongodb://localhost:27017/livechat
LIVECHAT_SECRET=<64 hex chars — see below>
```

Generate a real secret; never ship a guessable one:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Mount the routes (Next.js App Router shown):

```ts
// app/api/livechat/[...route]/route.ts
import { createFetchRouter } from 'livechat-bridge/server';

const router = createFetchRouter({
  mongoUri: process.env.MONGODB_URI!,
  sessionSecret: process.env.LIVECHAT_SECRET!,
  allowedOrigins: ['http://localhost:3000'],
  authenticateAgent: async (req) => getAgentFromSession(req),
});

export { router as GET, router as POST, router as OPTIONS };
```

### 1.3 Smoke-test by hand

```bash
BASE=http://localhost:3000/api/livechat

# 1. Open an anonymous visitor session
TOKEN=$(curl -s -X POST $BASE/session \
  -H 'content-type: application/json' -H 'x-site-id: acme' \
  -d '{"siteId":"acme"}' | jq -r .token)

# 2. Send a message as that visitor
curl -s -X POST $BASE/messages \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"hello there"}' | jq

# 3. See it in the agent queue (needs your agent auth)
curl -s "$BASE/conversations?status=open" -H 'cookie: <your staff session>' | jq
```

### 1.4 Checklist before you call it working

- [ ] Visitor sends a message; it appears in the agent inbox without a refresh.
- [ ] Agent claims it; the visitor sees the agent's replies.
- [ ] Two agents clicking **Claim** at once → one wins, the other sees
      "Another agent claimed this" rather than an error.
- [ ] Kill the WebSocket (or omit `socketUrl`) → status shows **polling** and
      messages still flow.
- [ ] Reload the agent inbox → unread badges stay cleared.
- [ ] A second `siteId` sees none of the first site's conversations.

---

## Part 2 — Deploy live

### 2.1 Prerequisites

| Need | Notes |
|---|---|
| MongoDB | Atlas free tier is fine to start. Use a dedicated database. |
| A strong `LIVECHAT_SECRET` | 32 random bytes. Rotating it invalidates every visitor session. |
| HTTPS | Session tokens are bearer credentials. Never serve this over plain HTTP. |
| Origins list | Every domain that embeds the widget. |

### 2.2 Environment

```bash
MONGODB_URI=mongodb+srv://user:pass@cluster/livechat
LIVECHAT_SECRET=<32 random bytes, hex>
ANTHROPIC_API_KEY=<optional — enables the AI fallback>
```

Never commit these. Set them in your host's dashboard.

### 2.3 Indexes

The schemas declare their indexes, and Mongoose builds them automatically on
first connect. In production, prefer building them once deliberately rather than
on a cold start under load:

```js
await ConversationModel.createIndexes();
await MessageModel.createIndexes();
await AgentModel.createIndexes();
```

Every index leads with `siteId`. Confirm with `db.livechat_conversations.getIndexes()`.

### 2.4 Pick a host

| Host | Works? | Caveat |
|---|---|---|
| **Vercel / serverless** | Yes, via long-poll | Function time caps cut a long poll short; the client reconnects, so it degrades rather than breaks. No WebSockets. |
| **Node container** (Fly, Railway, Render, VPS) | Best | Long polls run their full duration; you can also run a WebSocket server. |
| **Edge runtime** | Server entry only | Sessions use Web Crypto so they work; Mongoose does not run on edge. |

> **Run one instance to start.** `src/server/events.ts` (event fan-out) and
> `src/server/ai/fallback.ts` (AI timers) are both in-memory, so two instances
> will not see each other's events. Horizontal scaling needs the Redis seam both
> files document — see [STATE.md](./STATE.md) task 4.

### 2.5 Deploy

```bash
corepack pnpm typecheck && corepack pnpm test && corepack pnpm build
git push origin main          # CI runs the same three on Node 18/20/22
```

Publishing to npm:

```bash
# Inspect the tarball before it leaves your machine
corepack pnpm pack --pack-destination /tmp
tar -tzf /tmp/livechat-bridge-*.tgz

npm publish --access public
```

The tarball should contain `dist/`, `LICENSE`, `README.md`, `CHANGELOG.md`, and
`package.json` — nothing else. CI asserts every `exports` target is present.

`prepublishOnly` re-runs the build and tests, so a broken publish is hard.

### 2.6 Production hardening

- [ ] `allowedOrigins` lists your real domains — never `'*'` alongside cookies.
- [ ] `authenticateAgent` is wired to your real staff session, and returns an
      agent whose `siteId` is correct. An agent without a `siteId` is rejected.
- [ ] `uploadStore` points at S3/R2, not local disk, if you run more than one node.
- [ ] Keep the default MIME allow-list unless you have a reason; it deliberately
      excludes SVG and HTML to prevent stored XSS via an attachment URL.
- [ ] Put a rate limiter in front of `POST /session` and `POST /messages` — the
      package does not ship one.
- [ ] Back up MongoDB. Conversations are your support history.

### 2.7 Operating it

**Add an agent** — insert into the `livechat_agents` collection with the right
`siteId`, or point `authenticateAgent` at whatever staff table you already have.
The package never decides who is staff.

**Add a second site** — pick a new `siteId` and pass it to `ChatWidget`. No
migration, no new deployment; isolation is enforced by the queries.

**Common problems**

| Symptom | Cause |
|---|---|
| Widget stuck "connecting" | `baseUrl` wrong, or the origin is missing from `allowedOrigins`. |
| Agent inbox empty | `authenticateAgent` returned `null`, or its agent's `siteId` does not match the widget's. |
| 404 on claim/close | Conversation belongs to another tenant — this is the isolation working. |
| Events stop after ~60s on Vercel | Function time cap ended the poll. The client reconnects; harmless. |
| Two agents both claimed | Should be impossible; the claim is one atomic `findOneAndUpdate`. File a bug with the logs. |
