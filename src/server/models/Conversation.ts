/**
 * Conversation model.
 *
 * Model and collection names are prefixed because this package is embedded in
 * host applications that very often already own a model called `Conversation`;
 * colliding on the mongoose model registry would silently hand the host's
 * schema to our queries.
 */

import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import type { Conversation, ConversationStatus } from '../../types.js';

const CONVERSATION_STATUSES: ConversationStatus[] = ['open', 'assigned', 'ai', 'closed'];

export interface ConversationDoc {
  siteId: string;
  visitorId: string;
  visitorName?: string;
  visitorEmail?: string;
  status: ConversationStatus;
  /** `null` rather than absent so the atomic claim query can match on it. */
  assignedAgentId: string | null;
  subject?: string;
  lastMessagePreview?: string;
  lastMessageAt?: Date;
  unreadForAgent: number;
  metadata?: Record<string, unknown>;
  /**
   * High-water mark for `Message.seq`. Allocated with `$inc` inside
   * `findOneAndUpdate` so two concurrent sends can never be handed the same
   * number — a `countDocuments()` would race.
   */
  seqCounter: number;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<ConversationDoc>(
  {
    siteId: { type: String, required: true },
    visitorId: { type: String, required: true },
    visitorName: { type: String },
    visitorEmail: { type: String },
    status: { type: String, enum: CONVERSATION_STATUSES, required: true, default: 'open' },
    assignedAgentId: { type: String, default: null },
    subject: { type: String },
    lastMessagePreview: { type: String },
    lastMessageAt: { type: Date },
    unreadForAgent: { type: Number, required: true, default: 0 },
    metadata: { type: Schema.Types.Mixed },
    seqCounter: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, collection: 'livechat_conversations' },
);

// `siteId` leads every index: the agent inbox and the visitor lookup are both
// tenant-scoped, and an index that does not start with the tenant key invites a
// query that forgets it.
ConversationSchema.index({ siteId: 1, status: 1, lastMessageAt: -1 });
ConversationSchema.index({ siteId: 1, visitorId: 1 });

export const ConversationModel: Model<ConversationDoc> =
  (mongoose.models['LivechatConversation'] as Model<ConversationDoc> | undefined) ??
  mongoose.model<ConversationDoc>('LivechatConversation', ConversationSchema);

export type ConversationDocument = HydratedDocument<ConversationDoc>;

/** Projects a document onto the wire contract in `src/types.ts`. */
export function toConversation(doc: ConversationDocument): Conversation {
  const out: Conversation = {
    id: String(doc._id),
    siteId: doc.siteId,
    visitorId: doc.visitorId,
    status: doc.status,
    unreadForAgent: doc.unreadForAgent,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
  if (doc.visitorName) out.visitorName = doc.visitorName;
  if (doc.visitorEmail) out.visitorEmail = doc.visitorEmail;
  if (doc.assignedAgentId) out.assignedAgentId = doc.assignedAgentId;
  if (doc.subject) out.subject = doc.subject;
  if (doc.lastMessagePreview) out.lastMessagePreview = doc.lastMessagePreview;
  if (doc.lastMessageAt) out.lastMessageAt = doc.lastMessageAt.toISOString();
  if (doc.metadata) out.metadata = doc.metadata;
  return out;
}
