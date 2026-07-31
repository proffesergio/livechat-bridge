/**
 * `POST /session` — mint or resume a visitor session.
 *
 * This is the only unauthenticated endpoint, so it is also the only place
 * `resolveSiteId` (i.e. an attacker-controlled header) is consulted. The worst
 * it buys a caller is an anonymous session on a tenant whose id they already
 * knew; every subsequent request is scoped by the signed claims instead.
 */

import type { CreateSessionRequest, SessionResponse, SiteId, Visitor } from '../../types.js';
import { resolveVisitor } from '../auth.js';
import { defaultResolveSiteId, type ResolvedConfig } from '../config.js';
import { connectDb } from '../db.js';
import { apiError, json, readJson } from '../http.js';
import { ConversationModel, toConversation } from '../models/index.js';
import { signSession, verifyIdentityHmac } from '../session.js';
import { findActiveConversation } from '../store.js';

/** Prefixes keep a host-vouched id from ever colliding with a minted anonymous one. */
const VOUCHED_PREFIX = 'u:';
const ANONYMOUS_PREFIX = 'a:';

export function createSessionsHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return apiError('bad_request', 'Use POST to create a session', req, config);
    }

    const body = (await readJson(req)) as (CreateSessionRequest & Record<string, unknown>) | null;
    if (!body) return apiError('bad_request', 'Expected a JSON body', req, config);

    const resolver = config.resolveSiteId ?? defaultResolveSiteId;
    const siteId: SiteId | null =
      (await resolver(req)) ?? (typeof body.siteId === 'string' ? body.siteId : null);
    if (!siteId) {
      return apiError('bad_request', 'Missing siteId', req, config);
    }

    await connectDb(config.mongoUri);

    const identity = normaliseIdentity(body.identity);

    // Identity is all-or-nothing. Accepting an unsigned `identity` — or one whose
    // signature fails — and quietly falling back to anonymous would tell the host
    // "we know who this is" when we do not; refusing is the honest failure.
    if (identity) {
      if (typeof body.identityHmac !== 'string' || !body.identityHmac) {
        return apiError('forbidden', 'identity requires identityHmac', req, config);
      }
      const ok = await verifyIdentityHmac(
        siteId,
        identity.id,
        body.identityHmac,
        config.sessionSecret,
      );
      if (!ok) return apiError('forbidden', 'Invalid identityHmac', req, config);
    }

    // Resume: a widget that still holds a valid token for this tenant keeps its
    // visitor id (and therefore its transcript) instead of starting over.
    const existing = await resolveVisitor(req, config);
    const resumable = existing && existing.siteId === siteId ? existing : null;

    const visitorId = identity
      ? `${VOUCHED_PREFIX}${identity.id}`
      : (resumable?.visitorId ?? `${ANONYMOUS_PREFIX}${crypto.randomUUID()}`);

    const anonymous = identity === null;

    const visitor: Visitor = { id: visitorId, siteId, anonymous };
    if (identity?.name) visitor.name = identity.name;
    if (identity?.email) visitor.email = identity.email;
    if (isPlainObject(body.metadata)) visitor.metadata = body.metadata;

    const active = await findActiveConversation(siteId, visitorId);

    // Denormalise the vouched profile onto the live conversation so the agent
    // inbox can render a name without a second lookup.
    if (active && identity && (identity.name || identity.email)) {
      const patch: Record<string, string> = {};
      if (identity.name) patch['visitorName'] = identity.name;
      if (identity.email) patch['visitorEmail'] = identity.email;
      await ConversationModel.updateOne({ _id: active._id, siteId }, { $set: patch });
      if (identity.name) active.visitorName = identity.name;
      if (identity.email) active.visitorEmail = identity.email;
    }

    const now = Date.now();
    const token = await signSession(
      {
        siteId,
        visitorId,
        anonymous,
        issuedAt: now,
        expiresAt: now + config.sessionTtlMs,
      },
      config.sessionSecret,
    );

    const response: SessionResponse = { token, visitor };
    if (active) response.conversation = toConversation(active);
    if (config.socketUrl) response.socketUrl = config.socketUrl;

    return json(response, 200, req, config);
  };
}

function normaliseIdentity(
  value: unknown,
): { id: string; name?: string; email?: string } | null {
  if (!isPlainObject(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || id.length === 0) return null;
  const out: { id: string; name?: string; email?: string } = { id };
  if (typeof value['name'] === 'string') out.name = value['name'];
  if (typeof value['email'] === 'string') out.email = value['email'];
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
