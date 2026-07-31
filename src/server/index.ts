/**
 * Public surface of `livechat-bridge/server`.
 *
 * Mount `createRouteHandlers(config)` on whatever router the host uses; reach
 * for the models and the db helper only when building something the handlers do
 * not cover (an admin report, a data migration, a seeding script).
 */

export { createRouteHandlers, type RouteHandler, type RouteHandlers } from './handlers/index.js';

// The catch-all mount. `createRouteHandlers` hands back handlers by name for
// hosts that want to wire each route themselves; this maps the canonical URL
// paths — the ones the widget and agent inbox actually call — onto them.
export { createFetchRouter, type FetchRouter } from './router.js';

export {
  resolveConfig,
  defaultResolveSiteId,
  DEFAULT_AI_FALLBACK_MS,
  DEFAULT_ALLOWED_MIME_TYPES,
  DEFAULT_MAX_UPLOAD_BYTES,
  DEFAULT_POLL_TIMEOUT_MS,
  DEFAULT_SESSION_TTL_MS,
  type LiveChatServerConfig,
  type ResolvedConfig,
} from './config.js';

export { connectDb, disconnectDb } from './db.js';

export {
  AgentModel,
  ConversationModel,
  MessageModel,
  toAgent,
  toConversation,
  toMessage,
  type AgentDoc,
  type AgentDocument,
  type ConversationDoc,
  type ConversationDocument,
  type MessageDoc,
  type MessageDocument,
} from './models/index.js';

export {
  signSession,
  verifySession,
  signIdentityHmac,
  verifyIdentityHmac,
  identityHmacMessage,
  type SessionInput,
} from './session.js';

export {
  publish,
  subscribe,
  replaySince,
  resetEventBus,
  RING_CAPACITY,
  type EnvelopeListener,
} from './events.js';

export {
  appendMessage,
  asObjectId,
  findActiveConversation,
  findConversationInScope,
  type AppendMessageInput,
  type AppendMessageResult,
} from './store.js';

export { bearerToken, conversationScope, resolveActor, type Actor } from './auth.js';

export { sanitiseFilename } from './handlers/upload.js';

export {
  AnthropicProvider,
  cancelAiFallback,
  cancelAllAiFallbacks,
  scheduleAiFallback,
  type AnthropicProviderOptions,
} from './ai/index.js';

// Re-exported so consumers of `livechat-bridge/server` get the shared contract
// without a second import path.
export type * from '../types.js';
