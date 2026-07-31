/**
 * Message model.
 *
 * `seq` is the per-conversation cursor the long-poll transport resumes from
 * (see `RealtimeEnvelope.seq`). It is allocated by `$inc`-ing the parent
 * conversation's `seqCounter`, never derived from a count, so concurrent sends
 * get distinct, gapless numbers.
 */

import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import type { Attachment, Message, SenderType } from '../../types.js';

const SENDER_TYPES: SenderType[] = ['visitor', 'agent', 'ai', 'system'];

export interface MessageDoc {
  siteId: string;
  conversationId: string;
  seq: number;
  senderType: SenderType;
  senderId?: string;
  senderName?: string;
  body: string;
  attachments?: Attachment[];
  clientId?: string;
  createdAt: Date;
}

const AttachmentSchema = new Schema<Attachment>(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: Number, required: true },
    contentType: { type: String, required: true },
  },
  { _id: false },
);

const MessageSchema = new Schema<MessageDoc>(
  {
    siteId: { type: String, required: true },
    conversationId: { type: String, required: true },
    seq: { type: Number, required: true },
    senderType: { type: String, enum: SENDER_TYPES, required: true },
    senderId: { type: String },
    senderName: { type: String },
    body: { type: String, required: true, default: '' },
    attachments: { type: [AttachmentSchema], default: undefined },
    clientId: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'livechat_messages' },
);

// Serves both the transcript read (`seq > cursor`) and the uniqueness guarantee
// that makes `seq` safe to use as a cursor at all.
MessageSchema.index({ siteId: 1, conversationId: 1, seq: 1 }, { unique: true });

export const MessageModel: Model<MessageDoc> =
  (mongoose.models['LivechatMessage'] as Model<MessageDoc> | undefined) ??
  mongoose.model<MessageDoc>('LivechatMessage', MessageSchema);

export type MessageDocument = HydratedDocument<MessageDoc>;

export function toMessage(doc: MessageDocument): Message {
  const out: Message = {
    id: String(doc._id),
    siteId: doc.siteId,
    conversationId: doc.conversationId,
    senderType: doc.senderType,
    body: doc.body,
    createdAt: doc.createdAt.toISOString(),
  };
  if (doc.senderId) out.senderId = doc.senderId;
  if (doc.senderName) out.senderName = doc.senderName;
  if (doc.attachments && doc.attachments.length > 0) {
    out.attachments = doc.attachments.map((a) => ({
      id: a.id,
      name: a.name,
      url: a.url,
      size: a.size,
      contentType: a.contentType,
    }));
  }
  if (doc.clientId) out.clientId = doc.clientId;
  return out;
}
