/**
 * Request → actor resolution.
 *
 * There are exactly two kinds of caller and they are authenticated by different
 * mechanisms: a visitor presents a session token this package signed, and an
 * agent is vouched for by the host's own `authenticateAgent` hook.
 *
 * The important invariant: **an actor's `siteId` always comes from the verified
 * credential**, never from a header or body field. `x-site-id` is only ever used
 * on `POST /session`, where there is no credential yet and the worst an attacker
 * can do is create an empty anonymous session on a tenant they already knew the
 * id of.
 */

import type { Agent, SessionClaims, SiteId } from '../types.js';
import type { ResolvedConfig } from './config.js';
import { verifySession } from './session.js';

export type Actor =
  | { kind: 'visitor'; siteId: SiteId; claims: SessionClaims }
  | { kind: 'agent'; siteId: SiteId; agent: Agent };

/** Extracts a bearer token from the `Authorization` header. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Verified visitor claims, or `null`. */
export async function resolveVisitor(
  req: Request,
  config: ResolvedConfig,
): Promise<SessionClaims | null> {
  const token = bearerToken(req);
  if (!token) return null;
  return verifySession(token, config.sessionSecret);
}

/**
 * Authenticated agent, or `null`.
 *
 * An agent whose record carries no `siteId` is rejected outright: without a
 * tenant there is nothing to scope their queries to, and defaulting to "all
 * sites" would be the worst possible failure mode.
 */
export async function resolveAgent(
  req: Request,
  config: ResolvedConfig,
): Promise<Agent | null> {
  if (!config.authenticateAgent) return null;
  const agent = await config.authenticateAgent(req);
  if (!agent || !agent.siteId || !agent.id) return null;
  return agent;
}

/**
 * Resolves whichever credential the request carries.
 *
 * Visitor tokens are checked first because they are the common case and cost
 * one HMAC; the agent hook may hit a database.
 */
export async function resolveActor(
  req: Request,
  config: ResolvedConfig,
): Promise<Actor | null> {
  const claims = await resolveVisitor(req, config);
  if (claims) return { kind: 'visitor', siteId: claims.siteId, claims };

  const agent = await resolveAgent(req, config);
  if (agent) return { kind: 'agent', siteId: agent.siteId, agent };

  return null;
}

/**
 * The mandatory filter for any conversation query made on behalf of an actor.
 *
 * A visitor is pinned to their own `visitorId`; an agent is pinned to their
 * site. Handlers spread this into every `findOne`/`findOneAndUpdate` so that
 * forgetting a tenant filter is a compile-visible omission rather than a silent
 * cross-tenant read.
 */
export function conversationScope(actor: Actor): { siteId: SiteId; visitorId?: string } {
  if (actor.kind === 'visitor') {
    return { siteId: actor.siteId, visitorId: actor.claims.visitorId };
  }
  return { siteId: actor.siteId };
}
