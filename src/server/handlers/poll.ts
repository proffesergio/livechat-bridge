/**
 * `GET /poll?conversationId=…&after=<seq>` — HTTP long-poll fallback.
 *
 * Used when WebSockets are unavailable. The contract is the same envelope the
 * socket carries, so the widget's reducer does not care which transport it came
 * from: return anything the client has not seen (`seq > after`) immediately,
 * otherwise park until something is published or `pollTimeoutMs` elapses, then
 * answer with an empty array. An empty array is a *successful* poll — the
 * client simply re-polls with the same cursor.
 */

import type { RealtimeEnvelope } from '../../types.js';
import { conversationScope, resolveActor } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import { connectDb } from '../db.js';
import { replaySince, subscribe } from '../events.js';
import { apiError, json, parseIntParam, queryParam } from '../http.js';
import { findConversationInScope } from '../store.js';

export function createPollHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'GET') return apiError('bad_request', 'Use GET', req, config);

    const actor = await resolveActor(req, config);
    if (!actor) return apiError('unauthorized', 'Missing or invalid credentials', req, config);

    const conversationId = queryParam(req, 'conversationId');
    if (!conversationId) {
      return apiError('bad_request', 'conversationId is required', req, config);
    }

    await connectDb(config.mongoUri);

    // Authorise once, up front: a parked poll holds a subscription open for up
    // to 25 seconds, and we will not do that for a conversation the caller has
    // no claim to.
    const scope = conversationScope(actor);
    const conversation = await findConversationInScope(
      scope.siteId,
      conversationId,
      scope.visitorId,
    );
    if (!conversation) return apiError('not_found', 'Conversation not found', req, config);

    const channelId = String(conversation._id);
    const after = parseIntParam(queryParam(req, 'after'), 0);

    // Fast path: the ring buffer already holds what they missed, so no waiting
    // and no DB round-trip.
    const buffered = replaySince(scope.siteId, channelId, after);
    if (buffered.length > 0) return json(buffered, 200, req, config);

    const envelopes = await waitForEnvelopes(
      scope.siteId,
      channelId,
      after,
      config.pollTimeoutMs,
      req.signal,
    );
    return json(envelopes, 200, req, config);
  };
}

/**
 * Parks until one of three things happens: an envelope newer than `after`
 * arrives, the hold time expires, or the client goes away.
 *
 * Every exit path runs the same `finish`, which unsubscribes and clears the
 * timer — a leaked subscription would keep the request's closure (and its
 * response) alive for the lifetime of the process.
 */
function waitForEnvelopes(
  siteId: string,
  conversationId: string,
  after: number,
  timeoutMs: number,
  signal: AbortSignal | null | undefined,
): Promise<RealtimeEnvelope[]> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: RealtimeEnvelope[]): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    function onAbort(): void {
      finish([]);
    }

    if (signal?.aborted) {
      resolve([]);
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    unsubscribe = subscribe(siteId, conversationId, (envelope) => {
      if (envelope.seq > after) finish([envelope]);
    });

    timer = setTimeout(() => finish([]), timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  });
}
