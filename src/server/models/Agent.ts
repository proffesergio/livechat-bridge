/**
 * Agent model.
 *
 * The bridge does not authenticate agents itself — `authenticateAgent` in the
 * server config does. This collection exists so a host that has no staff
 * directory of its own can keep one here, and so agent metadata (name, avatar)
 * can be denormalised into `conversation:assigned` events.
 */

import mongoose, { Schema, type HydratedDocument, type Model } from 'mongoose';

import type { Agent, AgentPresence, AgentRole } from '../../types.js';

const AGENT_ROLES: AgentRole[] = ['agent', 'admin'];
const AGENT_PRESENCES: AgentPresence[] = ['online', 'away', 'offline'];

export interface AgentDoc {
  siteId: string;
  name: string;
  email: string;
  avatarUrl?: string;
  role: AgentRole;
  presence: AgentPresence;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AgentSchema = new Schema<AgentDoc>(
  {
    siteId: { type: String, required: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    avatarUrl: { type: String },
    role: { type: String, enum: AGENT_ROLES, required: true, default: 'agent' },
    presence: { type: String, enum: AGENT_PRESENCES, required: true, default: 'offline' },
    lastSeenAt: { type: Date },
  },
  { timestamps: true, collection: 'livechat_agents' },
);

// Unique *within* a site, not globally: one human may hold an agent seat on
// several tenants under the same address.
AgentSchema.index({ siteId: 1, email: 1 }, { unique: true });

export const AgentModel: Model<AgentDoc> =
  (mongoose.models['LivechatAgent'] as Model<AgentDoc> | undefined) ??
  mongoose.model<AgentDoc>('LivechatAgent', AgentSchema);

export type AgentDocument = HydratedDocument<AgentDoc>;

export function toAgent(doc: AgentDocument): Agent {
  const out: Agent = {
    id: String(doc._id),
    siteId: doc.siteId,
    name: doc.name,
    email: doc.email,
    role: doc.role,
    presence: doc.presence,
  };
  if (doc.avatarUrl) out.avatarUrl = doc.avatarUrl;
  if (doc.lastSeenAt) out.lastSeenAt = doc.lastSeenAt.toISOString();
  return out;
}
