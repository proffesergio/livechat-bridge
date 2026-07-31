/**
 * Path router over the named handlers in `handlers/index.ts`.
 *
 * `createRouteHandlers` returns handlers *by name* and leaves mounting to the
 * host, which is the right primitive when someone wants seven explicit routes
 * or their own middleware around each one. But the common case is a single
 * catch-all, and both the widget and the agent inbox ship with concrete URLs
 * baked in — so something has to own the mapping between the two. That is this
 * file, and it is the canonical definition of the wire paths.
 *
 * Mount it under any prefix; the prefix is detected from the request and
 * stripped before matching, so `/api/livechat/messages` and `/chat/messages`
 * both work with no configuration.
 */

import type { LiveChatServerConfig } from './config.js';
import { createRouteHandlers, type RouteHandler, type RouteHandlers } from './handlers/index.js';

/** Route table, in match order. `:id` matches one path segment. */
const ROUTES: ReadonlyArray<{
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: keyof RouteHandlers;
}> = [
  { method: 'POST', pattern: /^\/session\/?$/, handler: 'session' },
  { method: 'GET', pattern: /^\/messages\/?$/, handler: 'messages' },
  { method: 'POST', pattern: /^\/messages\/?$/, handler: 'messages' },
  { method: 'GET', pattern: /^\/conversations\/?$/, handler: 'conversations' },
  { method: 'POST', pattern: /^\/conversations\/(?:[^/]+\/)?claim\/?$/, handler: 'claimConversation' },
  { method: 'POST', pattern: /^\/conversations\/(?:[^/]+\/)?close\/?$/, handler: 'closeConversation' },
  { method: 'POST', pattern: /^\/conversations\/(?:[^/]+\/)?read\/?$/, handler: 'readConversation' },
  { method: 'GET', pattern: /^\/poll\/?$/, handler: 'poll' },
  { method: 'POST', pattern: /^\/upload\/?$/, handler: 'upload' },
];

/**
 * The last path segment that can begin one of our routes. Everything before the
 * first occurrence of one of these is the host's mount prefix.
 */
const ROOTS = ['session', 'messages', 'conversations', 'poll', 'upload'];

/**
 * Strips whatever prefix the host mounted us under.
 *
 * We search from the right so a host mounted at, say, `/messages/livechat`
 * still resolves correctly — the *last* occurrence of a known root is the one
 * that starts our route.
 */
function stripMountPrefix(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && ROOTS.includes(segment)) {
      return `/${segments.slice(i).join('/')}`;
    }
  }
  return `/${segments.join('/')}`;
}

export interface FetchRouter {
  (req: Request): Promise<Response>;
  /** The underlying named handlers, for hosts that want to mount some by hand. */
  handlers: RouteHandlers;
}

/**
 * Builds a single `(Request) => Response` covering every route.
 *
 * ```ts
 * // app/api/livechat/[...route]/route.ts
 * const router = createFetchRouter(config);
 * export { router as GET, router as POST, router as OPTIONS };
 * ```
 */
export function createFetchRouter(config: LiveChatServerConfig): FetchRouter {
  const handlers = createRouteHandlers(config);

  const router = (async (req: Request): Promise<Response> => {
    // Preflight is answered for any path — the browser asks before we get to
    // say whether the route exists, and a 404 here reads as a CORS failure.
    if (req.method === 'OPTIONS') return handlers.options(req);

    const path = stripMountPrefix(new URL(req.url).pathname);
    const match = ROUTES.find((r) => r.method === req.method && r.pattern.test(path));

    if (!match) {
      return handlers.notFound(req);
    }
    const handler: RouteHandler = handlers[match.handler];
    return handler(req);
  }) as FetchRouter;

  router.handlers = handlers;
  return router;
}
