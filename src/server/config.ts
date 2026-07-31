/**
 * Server configuration for `livechat-bridge/server`.
 *
 * Every knob that could differ between two installations lives here, so the
 * handlers themselves stay pure request→response functions with no ambient
 * state. Defaults are chosen so a minimal config (`sessionSecret` + `mongoUri`)
 * is a working, safe deployment.
 */

import type { Agent, AiProvider, SiteId, UploadStore } from '../types.js';

/** 10 MB. Big enough for a phone screenshot, small enough to not wedge a lambda. */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Deliberately narrow. Anything that a browser will happily render inline (SVG,
 * HTML) is excluded — an attachment URL served from the host's origin would
 * otherwise be a stored-XSS vector.
 */
export const DEFAULT_ALLOWED_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
];

/** How long a visitor session token stays valid. 30 days. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an unanswered chat waits for a human before the AI steps in. */
export const DEFAULT_AI_FALLBACK_MS = 30_000;

/** Long-poll hold time. Matches `TransportOptions.pollTimeoutMs` in the contract. */
export const DEFAULT_POLL_TIMEOUT_MS = 25_000;

export interface LiveChatServerConfig {
  /**
   * Secret for HMAC-signing session tokens and verifying host-vouched
   * identities. Rotating it invalidates every outstanding session token.
   */
  sessionSecret: string;

  /** Mongo connection string. Falls back to `process.env.MONGODB_URI`. */
  mongoUri?: string;

  /**
   * Resolves which tenant an *unauthenticated* request belongs to. Used only
   * by `POST /session`; every authenticated endpoint takes `siteId` from the
   * verified token or the authenticated agent instead, because a header is
   * attacker-controlled and a token claim is not.
   *
   * Defaults to the `x-site-id` header, then a `siteId` query parameter.
   */
  resolveSiteId?: (req: Request) => SiteId | null | Promise<SiteId | null>;

  /** Assistant used when no agent claims a chat in time. Omit to disable. */
  ai?: AiProvider;
  /** Grace period before the AI answers. Default 30s. */
  aiFallbackMs?: number;
  /** Per-site brand prompt handed to the AI provider. */
  aiSystemPrompt?: string;

  /** Where attachments land. Uploads are rejected outright when omitted. */
  uploadStore?: UploadStore;
  maxUploadBytes?: number;
  allowedMimeTypes?: readonly string[];

  /**
   * Authenticates a staff request. Returning an `Agent` grants access to that
   * agent's `siteId` and nothing else. Omit to disable every agent endpoint.
   */
  authenticateAgent?: (req: Request) => Promise<Agent | null>;

  /**
   * Origins allowed to call these routes. The widget is embedded on third-party
   * sites, so this is the only thing standing between a tenant's chat and a
   * hostile page. Never widened to `*` — credentials are always involved.
   * An empty/omitted list means "same origin only": no CORS headers are echoed.
   */
  allowedOrigins?: readonly string[];

  sessionTtlMs?: number;
  pollTimeoutMs?: number;

  /** Optional WebSocket URL handed to the widget in `SessionResponse`. */
  socketUrl?: string;
}

/** Config with every default filled in, so handlers never re-derive them. */
export interface ResolvedConfig extends LiveChatServerConfig {
  aiFallbackMs: number;
  maxUploadBytes: number;
  allowedMimeTypes: readonly string[];
  sessionTtlMs: number;
  pollTimeoutMs: number;
  allowedOrigins: readonly string[];
}

/** Default tenant resolution: `x-site-id` header, then `?siteId=`. */
export function defaultResolveSiteId(req: Request): SiteId | null {
  const header = req.headers.get('x-site-id');
  if (header) return header.trim();
  try {
    const fromQuery = new URL(req.url).searchParams.get('siteId');
    if (fromQuery) return fromQuery.trim();
  } catch {
    /* relative URLs have no searchParams — fall through */
  }
  return null;
}

export function resolveConfig(config: LiveChatServerConfig): ResolvedConfig {
  if (!config.sessionSecret) {
    throw new Error('livechat-bridge: `sessionSecret` is required');
  }
  return {
    ...config,
    aiFallbackMs: config.aiFallbackMs ?? DEFAULT_AI_FALLBACK_MS,
    maxUploadBytes: config.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
    allowedMimeTypes: config.allowedMimeTypes ?? DEFAULT_ALLOWED_MIME_TYPES,
    sessionTtlMs: config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
    pollTimeoutMs: config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    allowedOrigins: config.allowedOrigins ?? [],
  };
}
