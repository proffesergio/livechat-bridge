/**
 * Web-standard response helpers shared by every handler.
 *
 * CORS matters more here than in a typical API: the widget runs on the
 * customer's site and calls these routes cross-origin with a bearer token, so
 * the allow-list is the boundary that stops an arbitrary page from driving a
 * visitor's chat session.
 */

import type { ApiError, ApiErrorCode } from '../types.js';
import type { ResolvedConfig } from './config.js';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
};

const ALLOWED_REQUEST_HEADERS = 'content-type, authorization, x-site-id';

/**
 * CORS headers for one request.
 *
 * Only an origin that appears verbatim in `allowedOrigins` is echoed back, and
 * credentials are enabled only for such an exact match. A literal `'*'` entry is
 * honoured as "any origin", but then credentials are *not* allowed — the
 * combination of `*` and credentials is both rejected by browsers and a
 * genuinely bad idea.
 */
export function corsHeaders(req: Request, config: ResolvedConfig): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin) return {};

  const allowList = config.allowedOrigins;
  const exact = allowList.includes(origin);
  const wildcard = !exact && allowList.includes('*');
  if (!exact && !wildcard) return {};

  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': ALLOWED_REQUEST_HEADERS,
    'access-control-max-age': '600',
    // The response body varies per origin, so a shared cache must not reuse it.
    vary: 'Origin',
  };
  if (exact) headers['access-control-allow-credentials'] = 'true';
  return headers;
}

export function json(
  data: unknown,
  status: number,
  req: Request,
  config: ResolvedConfig,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Chat payloads are per-visitor and must never be cached by a proxy.
      'cache-control': 'no-store',
      ...corsHeaders(req, config),
    },
  });
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  req: Request,
  config: ResolvedConfig,
  details?: unknown,
): Response {
  const body: ApiError = { error: message, code };
  if (details !== undefined) body.details = details;
  return json(body, STATUS_BY_CODE[code], req, config);
}

/** Preflight. A non-allow-listed origin gets a bare 403 with no CORS headers. */
export function preflight(req: Request, config: ResolvedConfig): Response {
  const headers = corsHeaders(req, config);
  if (Object.keys(headers).length === 0) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, { status: 204, headers });
}

/** Parses a JSON body, returning `null` for anything malformed. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Reads a query parameter, tolerating relative request URLs. */
export function queryParam(req: Request, name: string): string | null {
  try {
    return new URL(req.url).searchParams.get(name);
  } catch {
    return null;
  }
}

export function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
