import { LiveChatBridgeError } from '../../core/index.js';

export function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...init?.headers,
    },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof LiveChatBridgeError) {
    return json({ error: { code: err.code, message: err.message } }, { status: err.status });
  }
  // eslint-disable-next-line no-console
  console.error('[livechat-bridge] unhandled error:', err);
  return json(
    { error: { code: 'INTERNAL', message: 'Internal server error' } },
    { status: 500 }
  );
}

export async function readJson<T = unknown>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
