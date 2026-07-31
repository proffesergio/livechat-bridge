/**
 * Agent-side conversation endpoints: inbox, claim, close.
 *
 * Every one of these requires `authenticateAgent` to return an agent, and every
 * query is filtered by *that agent's* `siteId` — never by anything in the
 * request. An agent for site A cannot name a conversation on site B, because
 * the filter simply will not match it.
 */

import type { Conversation, ConversationStatus, Page } from '../../types.js';
import { cancelAiFallback } from '../ai/fallback.js';
import { resolveAgent } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import { connectDb } from '../db.js';
import { apiError, json, parseIntParam, queryParam, readJson } from '../http.js';
import { publish } from '../events.js';
import { ConversationModel, toConversation } from '../models/index.js';
import { asObjectId } from '../store.js';

const STATUSES: ConversationStatus[] = ['open', 'assigned', 'ai', 'closed'];
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** `/conversations/<id>/claim` and `/conversations/<id>/close`. */
const PATH_ID = /\/conversations\/([^/]+)\/(?:claim|close|read)\/?$/;

/**
 * Resolves the target conversation from wherever the caller put it.
 *
 * The three entry points address these routes differently — the widget posts
 * `{ conversationId }` in the body, the agent inbox puts the id in the path —
 * and hosts mount the handlers under paths we do not control. Accepting all
 * three forms means neither client depends on how the other one was written,
 * and a host can mount a catch-all or seven explicit routes without either
 * choice changing the wire contract.
 *
 * Note this only *names* a conversation; it grants nothing. Authorization is
 * still the `siteId` filter on the query below.
 */
function resolveConversationId(req: Request, body: Record<string, unknown> | null): string | null {
  const fromBody = body?.['conversationId'];
  if (typeof fromBody === 'string' && fromBody) return fromBody;

  const url = new URL(req.url);
  const fromPath = PATH_ID.exec(url.pathname)?.[1];
  if (fromPath) return decodeURIComponent(fromPath);

  return queryParam(req, 'conversationId');
}

/** `GET /conversations` — the agent inbox for one site. */
export function createConversationsHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const agent = await resolveAgent(req, config);
    if (!agent) return apiError('unauthorized', 'Agent authentication required', req, config);
    if (req.method !== 'GET') return apiError('bad_request', 'Use GET', req, config);

    await connectDb(config.mongoUri);

    const filter: Record<string, unknown> = { siteId: agent.siteId };
    const status = queryParam(req, 'status');
    if (status) {
      if (!STATUSES.includes(status as ConversationStatus)) {
        return apiError('bad_request', `Unknown status "${status}"`, req, config);
      }
      filter['status'] = status;
    }

    const limit = Math.min(
      Math.max(parseIntParam(queryParam(req, 'limit'), DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );

    const docs = await ConversationModel.find(filter)
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(limit + 1);

    const hasMore = docs.length > limit;
    const items: Conversation[] = docs.slice(0, limit).map(toConversation);
    const page: Page<Conversation> = { items, hasMore };
    return json(page, 200, req, config);
  };
}

/**
 * `POST /conversations/claim` — take ownership of a chat.
 *
 * The claim is a single `findOneAndUpdate` whose filter requires the
 * conversation to be unassigned (or already this agent's). Two agents racing
 * for the same chat therefore serialise inside Mongo: one match wins, the other
 * finds nothing and gets a 409. Re-claiming your own chat is idempotent.
 */
export function createClaimHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const agent = await resolveAgent(req, config);
    if (!agent) return apiError('unauthorized', 'Agent authentication required', req, config);
    if (req.method !== 'POST') return apiError('bad_request', 'Use POST', req, config);

    await connectDb(config.mongoUri);

    const body = await readJson(req);
    const conversationId = resolveConversationId(req, body);
    const _id = asObjectId(conversationId);
    if (!_id) return apiError('bad_request', 'conversationId is required', req, config);

    const claimed = await ConversationModel.findOneAndUpdate(
      {
        _id,
        siteId: agent.siteId,
        status: { $ne: 'closed' },
        $or: [{ assignedAgentId: null }, { assignedAgentId: agent.id }],
      },
      {
        // Bump the cursor so this envelope is ordered against the message
        // stream; a long-poll client resuming from `seq` must not miss it.
        $inc: { seqCounter: 1 },
        $set: { assignedAgentId: agent.id, status: 'assigned', unreadForAgent: 0 },
      },
      { new: true },
    );

    if (!claimed) {
      // Distinguish "already taken" from "not yours / does not exist" — but only
      // within the agent's own site, so the 409 never leaks another tenant.
      const exists = await ConversationModel.exists({ _id, siteId: agent.siteId });
      return exists
        ? apiError('conflict', 'Conversation already claimed', req, config)
        : apiError('not_found', 'Conversation not found', req, config);
    }

    cancelAiFallback(agent.siteId, String(claimed._id));

    publish(agent.siteId, String(claimed._id), {
      event: 'conversation:assigned',
      siteId: agent.siteId,
      conversationId: String(claimed._id),
      data: {
        conversationId: String(claimed._id),
        agent: {
          id: agent.id,
          name: agent.name,
          ...(agent.avatarUrl ? { avatarUrl: agent.avatarUrl } : {}),
        },
      },
      seq: claimed.seqCounter,
      at: new Date().toISOString(),
    });

    return json({ conversation: toConversation(claimed) }, 200, req, config);
  };
}

/** `POST /conversations/close` — resolve a chat. */
export function createCloseHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const agent = await resolveAgent(req, config);
    if (!agent) return apiError('unauthorized', 'Agent authentication required', req, config);
    if (req.method !== 'POST') return apiError('bad_request', 'Use POST', req, config);

    await connectDb(config.mongoUri);

    const body = await readJson(req);
    const conversationId = resolveConversationId(req, body);
    const _id = asObjectId(conversationId);
    if (!_id) return apiError('bad_request', 'conversationId is required', req, config);

    const closed = await ConversationModel.findOneAndUpdate(
      { _id, siteId: agent.siteId },
      { $inc: { seqCounter: 1 }, $set: { status: 'closed', unreadForAgent: 0 } },
      { new: true },
    );
    if (!closed) return apiError('not_found', 'Conversation not found', req, config);

    cancelAiFallback(agent.siteId, String(closed._id));

    const at = new Date().toISOString();
    publish(agent.siteId, String(closed._id), {
      event: 'conversation:closed',
      siteId: agent.siteId,
      conversationId: String(closed._id),
      data: { conversationId: String(closed._id), at },
      seq: closed.seqCounter,
      at,
    });

    return json({ conversation: toConversation(closed) }, 200, req, config);
  };
}

/**
 * `POST /conversations/read` — clear the agent-side unread badge.
 *
 * Without this the inbox can only zero `unreadForAgent` in local state, so the
 * badge returns on refresh and never agrees between two tabs. Publishing the
 * updated conversation is what keeps those tabs in sync.
 *
 * Unlike claim, this deliberately does *not* require the agent to own the
 * conversation: reading an unclaimed chat while triaging the queue is the
 * normal way an agent decides whether to claim it.
 */
export function createReadHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const agent = await resolveAgent(req, config);
    if (!agent) return apiError('unauthorized', 'Agent authentication required', req, config);
    if (req.method !== 'POST') return apiError('bad_request', 'Use POST', req, config);

    await connectDb(config.mongoUri);

    const body = await readJson(req);
    const conversationId = resolveConversationId(req, body);
    const _id = asObjectId(conversationId);
    if (!_id) return apiError('bad_request', 'conversationId is required', req, config);

    const read = await ConversationModel.findOneAndUpdate(
      { _id, siteId: agent.siteId },
      { $inc: { seqCounter: 1 }, $set: { unreadForAgent: 0 } },
      { new: true },
    );
    if (!read) return apiError('not_found', 'Conversation not found', req, config);

    const conversation = toConversation(read);
    publish(agent.siteId, String(read._id), {
      event: 'conversation:updated',
      siteId: agent.siteId,
      conversationId: String(read._id),
      data: { conversation },
      seq: read.seqCounter,
      at: new Date().toISOString(),
    });

    return json({ conversation }, 200, req, config);
  };
}
