/**
 * Shared contracts for every livechat-bridge entry point.
 *
 * This module is the single source of truth binding `livechat-bridge/widget`,
 * `livechat-bridge/server`, and `livechat-bridge/admin` together. It is
 * dependency-free and runtime-free on purpose: it must import cleanly into a
 * browser bundle, a Node server, and an edge runtime alike.
 *
 * Every persisted entity carries a `siteId`. That field is the multi-tenant
 * boundary — see `TenantScoped`.
 */

/* -------------------------------------------------------------------------- */
/* Tenancy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Identifies one installation of the widget — typically one customer website.
 *
 * `siteId` is the tenant key. Every Mongoose query in `livechat-bridge/server`
 * MUST filter on it, and every model indexes it as the leading field of a
 * compound index. A query that omits it is a cross-tenant data leak.
 */
export type SiteId = string;

/** Mixin for anything persisted per-tenant. */
export interface TenantScoped {
  siteId: SiteId;
}

/** ISO-8601 timestamp string, e.g. `2026-07-31T10:45:00.000Z`. */
export type IsoDate = string;

/* -------------------------------------------------------------------------- */
/* Actors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A person chatting from the visitor widget.
 *
 * Visitors may be anonymous: the widget mints a session on first message and
 * the server issues a signed token carrying `visitorId`. When the host site
 * knows who the user is, it passes identity into the session request and
 * `anonymous` becomes false.
 */
export interface Visitor extends TenantScoped {
  id: string;
  /** False once the host site has vouched for this visitor's identity. */
  anonymous: boolean;
  name?: string;
  email?: string;
  avatarUrl?: string;
  /** Arbitrary host-supplied attributes (plan, locale, current URL, …). */
  metadata?: Record<string, unknown>;
}

/** Support staff. Agents are scoped to a site; one human may hold several. */
export interface Agent extends TenantScoped {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  role: AgentRole;
  presence: AgentPresence;
  lastSeenAt?: IsoDate;
}

export type AgentRole = 'agent' | 'admin';
export type AgentPresence = 'online' | 'away' | 'offline';

/* -------------------------------------------------------------------------- */
/* Conversations & messages                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `open`     — awaiting a human, nobody has claimed it
 * `assigned` — an agent has claimed it (exactly one, atomically)
 * `ai`       — the AI assistant answered because no agent claimed in time
 * `closed`   — resolved; the widget shows a transcript and a "start new" button
 */
export type ConversationStatus = 'open' | 'assigned' | 'ai' | 'closed';

export interface Conversation extends TenantScoped {
  id: string;
  visitorId: string;
  /** Denormalised for inbox rendering without a second query. */
  visitorName?: string;
  visitorEmail?: string;
  status: ConversationStatus;
  /** Set iff `status === 'assigned'`. */
  assignedAgentId?: string;
  subject?: string;
  /** Preview text for the inbox list — the last message body, truncated. */
  lastMessagePreview?: string;
  lastMessageAt?: IsoDate;
  /** Messages the assigned agent has not yet seen. */
  unreadForAgent: number;
  /** Page the conversation started on, and anything else the host attached. */
  metadata?: Record<string, unknown>;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export type SenderType = 'visitor' | 'agent' | 'ai' | 'system';

export interface Attachment {
  id: string;
  name: string;
  url: string;
  /** Bytes. */
  size: number;
  contentType: string;
}

export interface Message extends TenantScoped {
  id: string;
  conversationId: string;
  senderType: SenderType;
  /** `visitorId` or `agentId`; absent for `ai` and `system` messages. */
  senderId?: string;
  senderName?: string;
  body: string;
  attachments?: Attachment[];
  /**
   * Client-generated id echoed back on delivery so the widget can reconcile
   * its optimistic bubble instead of rendering the message twice.
   */
  clientId?: string;
  createdAt: IsoDate;
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** Decoded payload of a visitor session token. Never trust an unsigned copy. */
export interface SessionClaims extends TenantScoped {
  visitorId: string;
  anonymous: boolean;
  issuedAt: number;
  expiresAt: number;
}

/** Response of `POST /session` — what the widget needs to start chatting. */
export interface SessionResponse {
  token: string;
  visitor: Visitor;
  /** Existing open conversation, if the visitor already had one. */
  conversation?: Conversation;
  /** Where the widget should point its WebSocket, if the host runs one. */
  socketUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Realtime transport                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Events pushed from server to client. The same envelope travels over the
 * WebSocket and the HTTP long-poll fallback, so the widget's reducer is
 * transport-agnostic.
 */
export interface ServerEventMap {
  'message:new': { message: Message };
  'message:updated': { message: Message };
  'conversation:updated': { conversation: Conversation };
  'conversation:assigned': { conversationId: string; agent: Pick<Agent, 'id' | 'name' | 'avatarUrl'> };
  'conversation:closed': { conversationId: string; at: IsoDate };
  'typing': { conversationId: string; senderType: SenderType; senderId?: string; senderName?: string };
  'presence': { agents: Array<Pick<Agent, 'id' | 'name' | 'presence'>> };
}

export type ServerEventName = keyof ServerEventMap;

/**
 * One framed event on the wire, for a single known event name.
 *
 * You usually want {@link RealtimeEnvelope} instead — this is the per-event
 * shape it is built from.
 */
export interface RealtimeEnvelopeFor<E extends ServerEventName> {
  event: E;
  siteId: SiteId;
  conversationId?: string;
  data: ServerEventMap[E];
  /**
   * Monotonic per-conversation cursor. The long-poll fallback resumes from the
   * last `seq` it saw, so no event is lost while switching transports.
   */
  seq: number;
  at: IsoDate;
}

/**
 * Any framed event on the wire.
 *
 * Distributed over `ServerEventName` rather than left as a single interface
 * with a union-typed `data`, so that `switch (envelope.event)` actually narrows
 * `envelope.data` to that event's payload. Without the distribution every
 * consumer has to cast, which defeats the point of having a shared contract.
 */
export type RealtimeEnvelope = {
  [E in ServerEventName]: RealtimeEnvelopeFor<E>;
}[ServerEventName];

/**
 * `polling` is a healthy state, not an error — it means WebSockets were
 * unavailable and the HTTP fallback took over.
 */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'polling' | 'closed';

export interface TransportOptions {
  /** Base URL of the mounted server routes, e.g. `/api/livechat`. */
  baseUrl: string;
  /** WebSocket URL. When absent or unreachable, long-poll is used instead. */
  socketUrl?: string;
  token: string;
  /** Reconnect backoff ceiling in ms. Default 30_000. */
  maxBackoffMs?: number;
  /** Long-poll hold time in ms. Default 25_000. */
  pollTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* HTTP contracts                                                              */
/* -------------------------------------------------------------------------- */

export interface CreateSessionRequest {
  siteId: SiteId;
  /** Host-vouched identity. Requires a valid `identityHmac` to be trusted. */
  identity?: { id: string; name?: string; email?: string };
  /** HMAC of `identity.id` using the site secret; proves the host signed it. */
  identityHmac?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageRequest {
  conversationId?: string;
  body: string;
  clientId?: string;
  attachments?: Attachment[];
}

export interface ListMessagesQuery {
  conversationId: string;
  /** Return messages with `seq` greater than this. */
  after?: number;
  limit?: number;
}

/** Agent-side inbox query. The site is taken from the agent, never from here. */
export interface ListConversationsQuery {
  /** Omit to return every status. */
  status?: ConversationStatus;
  /** Opaque cursor echoed back as `Page.nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface ApiError {
  error: string;
  code: ApiErrorCode;
  details?: unknown;
}

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'rate_limited'
  | 'internal';

/* -------------------------------------------------------------------------- */
/* Uploads                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadResult {
  attachment: Attachment;
}

/**
 * Where uploaded files land. Implement this to put attachments on S3, R2, or
 * disk; the handler enforces size and MIME limits before calling `put`.
 */
export interface UploadStore {
  put(file: {
    siteId: SiteId;
    conversationId: string;
    name: string;
    contentType: string;
    size: number;
    stream: ReadableStream<Uint8Array> | ArrayBuffer;
  }): Promise<{ url: string; id: string }>;
}

/* -------------------------------------------------------------------------- */
/* AI assistant                                                                */
/* -------------------------------------------------------------------------- */

export interface AiReplyContext {
  siteId: SiteId;
  conversation: Conversation;
  /** Oldest-first transcript, already truncated to the provider's window. */
  messages: Message[];
  /** Static per-site brand prompt. Cached by providers that support it. */
  systemPrompt?: string;
}

export interface AiReplyResult {
  body: string;
  /** True when the assistant declined and a human should be paged instead. */
  handoff?: boolean;
}

export interface AiProvider {
  name: string;
  reply(ctx: AiReplyContext): Promise<AiReplyResult>;
}
