/**
 * Route handler factory.
 *
 * Everything here speaks the Web platform's `Request`/`Response` — no Next.js,
 * no Express, no Node streams — so the same handlers mount on the App Router, a
 * Worker, Bun, Hono, or a plain `Deno.serve`. Mounting is the host's job; this
 * module only says what each route does.
 */

import { resolveConfig, type LiveChatServerConfig, type ResolvedConfig } from '../config.js';
import { apiError, preflight } from '../http.js';
import {
  createClaimHandler,
  createCloseHandler,
  createConversationsHandler,
  createReadHandler,
} from './conversations.js';
import { createMessagesHandler } from './messages.js';
import { createPollHandler } from './poll.js';
import { createSessionsHandler } from './sessions.js';
import { createUploadHandler } from './upload.js';

export type RouteHandler = (req: Request) => Promise<Response>;

export interface RouteHandlers {
  /** `POST /session` — create or resume a visitor session. */
  session: RouteHandler;
  /** `POST` to send, `GET` to read a transcript. */
  messages: RouteHandler;
  /** `GET` — the agent inbox for one site. */
  conversations: RouteHandler;
  /** `POST` — atomically claim a conversation. */
  claimConversation: RouteHandler;
  /** `POST` — close a conversation. */
  closeConversation: RouteHandler;
  /** `POST` — clear the agent-side unread badge. */
  readConversation: RouteHandler;
  /** `GET` — long-poll for realtime envelopes. */
  poll: RouteHandler;
  /** `POST` — multipart attachment upload. */
  upload: RouteHandler;
  /** `OPTIONS` — CORS preflight, usable for every route above. */
  options: RouteHandler;
  /** Unmatched path — a CORS-aware 404 rather than the host's HTML error page. */
  notFound: RouteHandler;
}

/**
 * Wraps a handler with the two things every route needs and none should repeat:
 * CORS preflight short-circuiting, and a catch-all that turns an unexpected
 * throw into a 500 `ApiError` rather than a runtime stack trace on the wire.
 */
function guard(config: ResolvedConfig, handler: RouteHandler): RouteHandler {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return preflight(req, config);
    try {
      return await handler(req);
    } catch (err) {
      // The message is deliberately generic — internal errors frequently carry
      // connection strings and document contents.
      if (typeof console !== 'undefined') console.error('[livechat-bridge]', err);
      return apiError('internal', 'Internal error', req, config);
    }
  };
}

export function createRouteHandlers(config: LiveChatServerConfig): RouteHandlers {
  const resolved = resolveConfig(config);
  return {
    session: guard(resolved, createSessionsHandler(resolved)),
    messages: guard(resolved, createMessagesHandler(resolved)),
    conversations: guard(resolved, createConversationsHandler(resolved)),
    claimConversation: guard(resolved, createClaimHandler(resolved)),
    closeConversation: guard(resolved, createCloseHandler(resolved)),
    readConversation: guard(resolved, createReadHandler(resolved)),
    poll: guard(resolved, createPollHandler(resolved)),
    upload: guard(resolved, createUploadHandler(resolved)),
    options: async (req: Request) => preflight(req, resolved),
    notFound: guard(resolved, async (req: Request) =>
      apiError('not_found', 'No such livechat-bridge route', req, resolved),
    ),
  };
}
