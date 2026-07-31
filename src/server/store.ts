/**
 * Conversation/message write paths shared by the HTTP handlers and the AI
 * fallback timer.
 *
 * Everything here takes an explicit `siteId` and folds it into the query — the
 * functions have no way to address a document without one.
 */

import { Types } from 'mongoose';

import type { Attachment, Conversation, Message, SenderType, SiteId } from '../types.js';
import { publish } from './events.js';
import {
  ConversationModel,
  MessageModel,
  toConversation,
  toMessage,
  type ConversationDocument,
} from './models/index.js';

/** Characters of the message body kept as the inbox preview. */
const PREVIEW_LENGTH = 140;

/**
 * Narrows a client-supplied id to an ObjectId.
 *
 * Returning `null` instead of letting mongoose throw a CastError turns "garbage
 * id" into a clean 404 rather than a 500 — and keeps a probe from learning
 * anything from the difference.
 */
export function asObjectId(id: string | undefined | null): Types.ObjectId | null {
  if (!id || !Types.ObjectId.isValid(id)) return null;
  // `isValid` accepts any 12-character string; round-tripping rejects those.
  const candidate = new Types.ObjectId(id);
  return candidate.toHexString() === id.toLowerCase() ? candidate : null;
}

export interface AppendMessageInput {
  siteId: SiteId;
  conversationId: string;
  senderType: SenderType;
  senderId?: string;
  senderName?: string;
  body: string;
  attachments?: Attachment[];
  clientId?: string;
}

export interface AppendMessageResult {
  message: Message;
  conversation: Conversation;
}

/**
 * Appends a message to a conversation and fans it out.
 *
 * The `seq` is allocated by `$inc`-ing the conversation's counter inside the
 * same atomic update that refreshes the inbox preview, so two concurrent sends
 * are serialised by Mongo rather than by hope. Returns `null` when no
 * conversation matches `(siteId, conversationId)` — the caller turns that into
 * a 404 without ever learning whether the id exists on another tenant.
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<AppendMessageResult | null> {
  const _id = asObjectId(input.conversationId);
  if (!_id) return null;

  const preview = input.body.slice(0, PREVIEW_LENGTH);
  // Only visitor traffic is "unread for the agent"; an agent's own reply and the
  // AI's stand-in reply are not.
  const unreadDelta = input.senderType === 'visitor' ? 1 : 0;

  const conversation = await ConversationModel.findOneAndUpdate(
    { _id, siteId: input.siteId },
    {
      $inc: { seqCounter: 1, unreadForAgent: unreadDelta },
      $set: { lastMessagePreview: preview, lastMessageAt: new Date() },
    },
    { new: true },
  );
  if (!conversation) return null;

  const created = await MessageModel.create({
    siteId: input.siteId,
    conversationId: String(conversation._id),
    seq: conversation.seqCounter,
    senderType: input.senderType,
    senderId: input.senderId,
    senderName: input.senderName,
    body: input.body,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
    clientId: input.clientId,
  });

  const message = toMessage(created);
  publish(input.siteId, message.conversationId, {
    event: 'message:new',
    siteId: input.siteId,
    conversationId: message.conversationId,
    data: { message },
    seq: conversation.seqCounter,
    at: message.createdAt,
  });

  return { message, conversation: toConversation(conversation) };
}

/**
 * Finds a conversation within a tenant, optionally pinned to one visitor.
 *
 * `visitorId` is supplied for visitor-authenticated requests and omitted for
 * agents, who may touch any conversation on their own site.
 */
export async function findConversationInScope(
  siteId: SiteId,
  conversationId: string,
  visitorId?: string,
): Promise<ConversationDocument | null> {
  const _id = asObjectId(conversationId);
  if (!_id) return null;
  const filter: Record<string, unknown> = { _id, siteId };
  if (visitorId) filter['visitorId'] = visitorId;
  return ConversationModel.findOne(filter);
}

/** The current, non-closed conversation for a visitor — the one to resume. */
export async function findActiveConversation(
  siteId: SiteId,
  visitorId: string,
): Promise<ConversationDocument | null> {
  return ConversationModel.findOne({
    siteId,
    visitorId,
    status: { $ne: 'closed' },
  }).sort({ lastMessageAt: -1, createdAt: -1 });
}

/** The next `seq` this conversation will hand out, for cursor bookkeeping. */
export function currentSeq(conversation: ConversationDocument): number {
  return conversation.seqCounter;
}
