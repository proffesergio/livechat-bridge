/**
 * `POST /messages` — send, `GET /messages` — read the transcript.
 *
 * Both visitors and agents use this endpoint; the actor decides the scope. A
 * visitor may only ever touch conversations matching **both** their `siteId`
 * and their `visitorId`; an agent is limited to their own `siteId`.
 */

import type {
  Attachment,
  Message,
  Page,
  SendMessageRequest,
} from '../../types.js';
import { cancelAiFallback, scheduleAiFallback } from '../ai/fallback.js';
import { conversationScope, resolveActor, type Actor } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import { connectDb } from '../db.js';
import { apiError, json, parseIntParam, queryParam, readJson } from '../http.js';
import { ConversationModel, MessageModel, toConversation, toMessage } from '../models/index.js';
import { appendMessage, findConversationInScope } from '../store.js';

/** Longest single message accepted. Long enough for a pasted stack trace. */
const MAX_BODY_LENGTH = 8000;
const MAX_ATTACHMENTS = 10;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function createMessagesHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const actor = await resolveActor(req, config);
    if (!actor) return apiError('unauthorized', 'Missing or invalid credentials', req, config);

    await connectDb(config.mongoUri);

    if (req.method === 'GET') return listMessages(req, config, actor);
    if (req.method === 'POST') return sendMessage(req, config, actor);
    return apiError('bad_request', 'Use GET or POST', req, config);
  };
}

/* -------------------------------------------------------------------------- */
/* Send                                                                        */
/* -------------------------------------------------------------------------- */

async function sendMessage(
  req: Request,
  config: ResolvedConfig,
  actor: Actor,
): Promise<Response> {
  const body = (await readJson(req)) as (SendMessageRequest & Record<string, unknown>) | null;
  if (!body) return apiError('bad_request', 'Expected a JSON body', req, config);

  const text = typeof body.body === 'string' ? body.body : '';
  const attachments = sanitiseAttachments(body.attachments);
  if (text.trim().length === 0 && attachments.length === 0) {
    return apiError('bad_request', 'Message body is empty', req, config);
  }
  if (text.length > MAX_BODY_LENGTH) {
    return apiError('bad_request', `Message body exceeds ${MAX_BODY_LENGTH} characters`, req, config);
  }

  const scope = conversationScope(actor);
  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null;

  if (conversationId) {
    const conversation = await findConversationInScope(
      scope.siteId,
      conversationId,
      scope.visitorId,
    );
    // A conversation on another tenant is reported as absent, not as forbidden:
    // a 403 would confirm the id exists somewhere.
    if (!conversation) return apiError('not_found', 'Conversation not found', req, config);
    if (conversation.status === 'closed') {
      return apiError('conflict', 'Conversation is closed', req, config);
    }
  } else {
    if (actor.kind === 'agent') {
      return apiError('bad_request', 'conversationId is required', req, config);
    }
    const created = await ConversationModel.create({
      siteId: actor.siteId,
      visitorId: actor.claims.visitorId,
      status: 'open',
      assignedAgentId: null,
      unreadForAgent: 0,
      seqCounter: 0,
    });
    conversationId = String(created._id);
  }

  const appended = await appendMessage({
    siteId: scope.siteId,
    conversationId,
    senderType: actor.kind === 'visitor' ? 'visitor' : 'agent',
    senderId: actor.kind === 'visitor' ? actor.claims.visitorId : actor.agent.id,
    ...(actor.kind === 'agent' ? { senderName: actor.agent.name } : {}),
    body: text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(typeof body.clientId === 'string' ? { clientId: body.clientId } : {}),
  });
  if (!appended) return apiError('not_found', 'Conversation not found', req, config);

  if (actor.kind === 'agent') {
    // A human is here — stand the assistant down.
    cancelAiFallback(scope.siteId, conversationId);
  } else if (appended.conversation.status === 'open') {
    scheduleAiFallback(config, scope.siteId, conversationId);
  }

  return json({ message: appended.message, conversation: appended.conversation }, 201, req, config);
}

/* -------------------------------------------------------------------------- */
/* List                                                                        */
/* -------------------------------------------------------------------------- */

async function listMessages(
  req: Request,
  config: ResolvedConfig,
  actor: Actor,
): Promise<Response> {
  const conversationId = queryParam(req, 'conversationId');
  if (!conversationId) {
    return apiError('bad_request', 'conversationId is required', req, config);
  }

  const scope = conversationScope(actor);
  const conversation = await findConversationInScope(
    scope.siteId,
    conversationId,
    scope.visitorId,
  );
  if (!conversation) return apiError('not_found', 'Conversation not found', req, config);

  const after = parseIntParam(queryParam(req, 'after'), 0);
  const limit = Math.min(
    Math.max(parseIntParam(queryParam(req, 'limit'), DEFAULT_PAGE_SIZE), 1),
    MAX_PAGE_SIZE,
  );

  // Over-fetch by one to learn whether another page exists without a count().
  const docs = await MessageModel.find({
    siteId: scope.siteId,
    conversationId: String(conversation._id),
    seq: { $gt: after },
  })
    .sort({ seq: 1 })
    .limit(limit + 1);

  const hasMore = docs.length > limit;
  const items: Message[] = docs.slice(0, limit).map(toMessage);

  const page: Page<Message> = { items, hasMore };
  const lastDoc = docs[Math.min(docs.length, limit) - 1];
  if (hasMore && lastDoc) page.nextCursor = String(lastDoc.seq);

  return json({ ...page, conversation: toConversation(conversation) }, 200, req, config);
}

/* -------------------------------------------------------------------------- */
/* Input hardening                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Attachments arrive from the client, which means the shape is untrusted even
 * though the file itself was uploaded through `/upload`. Everything outside the
 * five contract fields is dropped and each is length-capped, so a crafted body
 * cannot smuggle extra keys into the stored document.
 */
function sanitiseAttachments(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  const out: Attachment[] = [];
  for (const raw of value.slice(0, MAX_ATTACHMENTS)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as Record<string, unknown>;
    if (
      typeof a['id'] !== 'string' ||
      typeof a['name'] !== 'string' ||
      typeof a['url'] !== 'string' ||
      typeof a['contentType'] !== 'string' ||
      typeof a['size'] !== 'number'
    ) {
      continue;
    }
    out.push({
      id: a['id'].slice(0, 128),
      name: a['name'].slice(0, 255),
      url: a['url'].slice(0, 2048),
      size: Math.max(0, Math.floor(a['size'])),
      contentType: a['contentType'].slice(0, 128),
    });
  }
  return out;
}
