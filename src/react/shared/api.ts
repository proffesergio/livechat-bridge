import type { Chat, Message } from '../../core/index.js';

export interface ApiOptions {
  /** Base path the server handlers are mounted under. Defaults to `/api/livechat`. */
  basePath?: string;
  /** Optional `fetch` override (e.g. for SSR or to attach credentials differently). */
  fetch?: typeof fetch;
}

function url(opts: ApiOptions, path: string): string {
  const base = (opts.basePath ?? '/api/livechat').replace(/\/$/, '');
  return `${base}${path}`;
}

async function call<T>(opts: ApiOptions, path: string, init?: RequestInit): Promise<T> {
  const f = opts.fetch ?? fetch;
  const res = await f(url(opts, path), {
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string; code?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore */
    }
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export interface Viewer {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  isStaff: boolean;
}

export const api = {
  viewer: (opts: ApiOptions) => call<{ viewer: Viewer }>(opts, '/me'),
  sendMessage: (opts: ApiOptions, body: { chatId?: string; body: string }) =>
    call<{ message: Message }>(opts, '/messages', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listMessages: (opts: ApiOptions, chatId: string, cursor?: string) =>
    call<{ messages: Message[]; nextCursor?: string }>(
      opts,
      `/chats/${chatId}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
    ),
  listChats: (opts: ApiOptions, params?: { status?: string; cursor?: string }) => {
    const search = new URLSearchParams();
    if (params?.status) search.set('status', params.status);
    if (params?.cursor) search.set('cursor', params.cursor);
    const q = search.toString();
    return call<{ chats: Chat[]; nextCursor?: string }>(
      opts,
      `/chats${q ? `?${q}` : ''}`
    );
  },
  claimChat: (opts: ApiOptions, chatId: string) =>
    call<{ chat: Chat }>(opts, `/chats/${chatId}/claim`, { method: 'POST' }),
  closeChat: (opts: ApiOptions, chatId: string) =>
    call<{ chat: Chat }>(opts, `/chats/${chatId}/close`, { method: 'POST' }),
};
