/**
 * `POST /upload` — multipart attachment intake.
 *
 * Order matters here. Size, MIME, and filename are all validated **before** the
 * `UploadStore` is touched, so a hostile or oversized upload never reaches
 * durable storage, never consumes an S3 PUT, and never gets a URL minted for it.
 */

import type { Attachment, UploadResult } from '../../types.js';
import { conversationScope, resolveActor, type Actor } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import { connectDb } from '../db.js';
import { apiError, json, queryParam } from '../http.js';
import { findConversationInScope } from '../store.js';

/**
 * Reduces a client filename to a leaf name safe to put in a URL or on a disk.
 *
 * Strips every path separator (so `../../etc/passwd` becomes `passwd`),
 * collapses dot runs so no `..` survives, and whitelists the remaining charset
 * (control characters included). An empty result falls back to `upload`
 * rather than producing a dotfile or a zero-length name.
 */
export function sanitiseFilename(raw: string): string {
  const leaf = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf
    // Control characters, spaces, and every other exotic byte collapse to `_`;
    // dot runs collapse so no `..` segment survives.
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[.]+/, '')
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'upload';
}

function normaliseMime(value: string): string {
  const [first] = value.split(';');
  return (first ?? '').trim().toLowerCase();
}

export function createUploadHandler(
  config: ResolvedConfig,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return apiError('bad_request', 'Use POST', req, config);

    const store = config.uploadStore;
    if (!store) {
      return apiError('internal', 'Uploads are not configured', req, config);
    }

    const actor = await resolveActor(req, config);
    if (!actor) return apiError('unauthorized', 'Missing or invalid credentials', req, config);

    const contentType = normaliseMime(req.headers.get('content-type') ?? '');
    if (contentType !== 'multipart/form-data') {
      return apiError('unsupported_media_type', 'Expected multipart/form-data', req, config);
    }

    // Cheapest possible rejection: refuse on the declared length before reading
    // a single byte of the body.
    const declaredLength = Number.parseInt(req.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > config.maxUploadBytes) {
      return apiError(
        'payload_too_large',
        `Upload exceeds ${config.maxUploadBytes} bytes`,
        req,
        config,
      );
    }

    await connectDb(config.mongoUri);

    // Prefer the query parameter so ownership can be checked before the body is
    // parsed; the form field is the fallback for simpler clients.
    const idFromQuery = queryParam(req, 'conversationId');
    let conversation = idFromQuery
      ? await authorise(actor, idFromQuery)
      : null;
    if (idFromQuery && !conversation) {
      return apiError('not_found', 'Conversation not found', req, config);
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError('bad_request', 'Malformed multipart body', req, config);
    }

    const file = form.get('file');
    if (!isFileLike(file)) {
      return apiError('bad_request', 'Missing "file" part', req, config);
    }

    // Re-check the real size: `content-length` covers the whole multipart
    // envelope and a client can simply lie about it.
    if (file.size > config.maxUploadBytes) {
      return apiError(
        'payload_too_large',
        `Upload exceeds ${config.maxUploadBytes} bytes`,
        req,
        config,
      );
    }
    if (file.size === 0) {
      return apiError('bad_request', 'Uploaded file is empty', req, config);
    }

    const mime = normaliseMime(file.type);
    if (!mime || !config.allowedMimeTypes.includes(mime)) {
      return apiError(
        'unsupported_media_type',
        `Content type "${mime || 'unknown'}" is not allowed`,
        req,
        config,
      );
    }

    const name = sanitiseFilename(typeof file.name === 'string' ? file.name : 'upload');

    if (!conversation) {
      const fromForm = form.get('conversationId');
      if (typeof fromForm !== 'string' || !fromForm) {
        return apiError('bad_request', 'conversationId is required', req, config);
      }
      conversation = await authorise(actor, fromForm);
      if (!conversation) return apiError('not_found', 'Conversation not found', req, config);
    }

    // Everything is validated; only now does the file touch storage.
    const stored = await store.put({
      siteId: actor.siteId,
      conversationId: conversation,
      name,
      contentType: mime,
      size: file.size,
      stream: await file.arrayBuffer(),
    });

    const attachment: Attachment = {
      id: stored.id,
      name,
      url: stored.url,
      size: file.size,
      contentType: mime,
    };
    const result: UploadResult = { attachment };
    return json(result, 201, req, config);
  };
}

/** Returns the conversation id when the actor may write to it, else `null`. */
async function authorise(actor: Actor, conversationId: string): Promise<string | null> {
  const scope = conversationScope(actor);
  const doc = await findConversationInScope(scope.siteId, conversationId, scope.visitorId);
  if (!doc || doc.status === 'closed') return null;
  return String(doc._id);
}

function isFileLike(value: unknown): value is Blob & { name?: string } {
  return typeof value === 'object' && value !== null && 'arrayBuffer' in value && 'size' in value;
}
