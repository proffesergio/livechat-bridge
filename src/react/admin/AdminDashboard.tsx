'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Pusher from 'pusher-js';
import {
  CHAT_STATUS,
  EVENTS,
  STAFF_CHANNEL,
  chatChannel,
  type Chat,
  type Message,
} from '../../core/index.js';
import { api, type Viewer } from '../shared/api.js';
import { useRealtimeChannel } from '../shared/useRealtimeChannel.js';
import { PusherRealtimeClient } from '../shared/pusherRealtime.js';
import type { RealtimeClient } from '../shared/realtime.js';
import { useI18n, type Locale, type Messages } from '../shared/i18n.js';

export interface AdminDashboardProps {
  /**
   * Realtime client (e.g. `new SSERealtimeClient()` or
   * `new PusherRealtimeClient(pusher)`). Pass `null` while it's still loading.
   */
  realtime?: RealtimeClient | null;
  /**
   * @deprecated Pass `realtime` instead. A raw `pusher-js` instance is wrapped
   * in a `PusherRealtimeClient` automatically; supported through 0.2.x.
   */
  pusher?: Pusher | null;
  basePath?: string;
  locale?: Locale;
  translations?: Partial<Messages>;
  fetch?: typeof fetch;
}

type Tab = 'open' | 'claimed' | 'ai';

interface ThreadState {
  chat: Chat;
  messages: Message[];
  error?: string;
}

export function AdminDashboard({
  realtime,
  pusher,
  basePath,
  locale = 'en',
  translations,
  fetch: fetchOverride,
}: AdminDashboardProps) {
  const apiOpts = useMemo(() => ({ basePath, fetch: fetchOverride }), [basePath, fetchOverride]);
  const { t } = useI18n(locale, translations);

  const realtimeClient = useMemo<RealtimeClient | null>(
    () => realtime ?? (pusher ? new PusherRealtimeClient(pusher) : null),
    [realtime, pusher]
  );

  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [tab, setTab] = useState<Tab>('open');
  const [chatsByStatus, setChatsByStatus] = useState<Record<Tab, Chat[]>>({
    open: [],
    claimed: [],
    ai: [],
  });
  const [counts, setCounts] = useState({ open: 0, claimed: 0, ai: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [thread, setThread] = useState<ThreadState | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .viewer(apiOpts)
      .then((r) => !cancelled && setViewer(r.viewer))
      .catch(() => !cancelled && setViewer(null));
    return () => {
      cancelled = true;
    };
  }, [apiOpts]);

  const refreshList = useCallback(
    async (status: Tab) => {
      const r = await api.listChats(apiOpts, { status });
      setChatsByStatus((prev) => ({ ...prev, [status]: r.chats }));
    },
    [apiOpts]
  );

  useEffect(() => {
    void refreshList(tab);
  }, [tab, refreshList]);

  // Initial counts.
  useEffect(() => {
    void (async () => {
      const [open, claimed, ai] = await Promise.all([
        api.listChats(apiOpts, { status: 'open' }),
        api.listChats(apiOpts, { status: 'claimed' }),
        api.listChats(apiOpts, { status: 'ai' }),
      ]);
      setCounts({ open: open.chats.length, claimed: claimed.chats.length, ai: ai.chats.length });
      setChatsByStatus({ open: open.chats, claimed: claimed.chats, ai: ai.chats });
    })();
  }, [apiOpts]);

  useRealtimeChannel({
    client: realtimeClient,
    channelName: STAFF_CHANNEL,
    events: {
      [EVENTS.QUEUE_UPDATED]: (payload) => {
        const p = payload as { open: number; claimed: number; ai: number };
        setCounts(p);
        // Refresh whichever tab is visible — cheaper than dispatching reconciliation logic.
        void refreshList(tab);
      },
    },
  });

  useRealtimeChannel({
    client: realtimeClient,
    channelName: selectedId ? chatChannel(selectedId) : null,
    events: {
      [EVENTS.MESSAGE_NEW]: (payload) => {
        const p = payload as { message: Message };
        setThread((prev) => (prev ? { ...prev, messages: dedupe([...prev.messages, p.message]) } : prev));
      },
      [EVENTS.MESSAGE_AI]: (payload) => {
        const p = payload as { message: Message };
        setThread((prev) => (prev ? { ...prev, messages: dedupe([...prev.messages, p.message]) } : prev));
      },
      [EVENTS.CHAT_CLAIMED]: (payload) => {
        const p = payload as { staffId: string };
        setThread((prev) =>
          prev
            ? { ...prev, chat: { ...prev.chat, status: CHAT_STATUS.CLAIMED, assignedStaffId: p.staffId } }
            : prev
        );
      },
      [EVENTS.CHAT_AI_TAKEOVER]: () => {
        setThread((prev) =>
          prev ? { ...prev, chat: { ...prev.chat, status: CHAT_STATUS.AI } } : prev
        );
      },
      [EVENTS.CHAT_CLOSED]: () => {
        setThread((prev) =>
          prev ? { ...prev, chat: { ...prev.chat, status: CHAT_STATUS.CLOSED } } : prev
        );
      },
    },
  });

  // Load thread when selection changes.
  useEffect(() => {
    if (!selectedId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    const selected =
      chatsByStatus.open.find((c) => c.id === selectedId) ??
      chatsByStatus.claimed.find((c) => c.id === selectedId) ??
      chatsByStatus.ai.find((c) => c.id === selectedId);
    if (!selected) return;
    api
      .listMessages(apiOpts, selectedId, undefined)
      .then((r) => !cancelled && setThread({ chat: selected, messages: r.messages }))
      .catch(() => !cancelled && setThread({ chat: selected, messages: [] }));
    return () => {
      cancelled = true;
    };
  }, [selectedId, chatsByStatus, apiOpts]);

  useEffect(() => {
    if (!threadRef.current) return;
    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [thread?.messages.length]);

  const claim = useCallback(async () => {
    if (!thread) return;
    try {
      const { chat } = await api.claimChat(apiOpts, thread.chat.id);
      setThread((prev) => (prev ? { ...prev, chat, error: undefined } : prev));
    } catch (err) {
      const message =
        (err as { status?: number }).status === 409
          ? t('admin.chat.error.claimLost')
          : (err as Error).message;
      setThread((prev) => (prev ? { ...prev, error: message } : prev));
    }
  }, [thread, apiOpts, t]);

  const close = useCallback(async () => {
    if (!thread) return;
    const { chat } = await api.closeChat(apiOpts, thread.chat.id);
    setThread((prev) => (prev ? { ...prev, chat } : prev));
  }, [thread, apiOpts]);

  const send = useCallback(async () => {
    if (!thread || sending) return;
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    try {
      const r = await api.sendMessage(apiOpts, { chatId: thread.chat.id, body });
      setThread((prev) =>
        prev ? { ...prev, messages: dedupe([...prev.messages, r.message]) } : prev
      );
      setDraft('');
    } finally {
      setSending(false);
    }
  }, [thread, sending, draft, apiOpts]);

  if (viewer && !viewer.isStaff) {
    return <div className="lcb-admin-blank">Staff only.</div>;
  }

  const list = chatsByStatus[tab];

  return (
    <div className="lcb-admin">
      <aside className="lcb-admin-sidebar">
        <div className="lcb-admin-header">
          <h1>{t('admin.title')}</h1>
          <div className="lcb-admin-tabs" role="tablist">
            <TabButton tab="open" current={tab} setTab={setTab} count={counts.open} label={t('admin.queue.open')} />
            <TabButton tab="claimed" current={tab} setTab={setTab} count={counts.claimed} label={t('admin.queue.claimed')} />
            <TabButton tab="ai" current={tab} setTab={setTab} count={counts.ai} label={t('admin.queue.ai')} />
          </div>
        </div>
        <div className="lcb-admin-list" role="listbox">
          {list.length === 0 ? (
            <div className="lcb-admin-empty">{t('admin.queue.empty')}</div>
          ) : (
            list.map((c) => (
              <div
                key={c.id}
                className="lcb-admin-row"
                role="option"
                aria-selected={c.id === selectedId}
                onClick={() => setSelectedId(c.id)}
              >
                <span className="name">{c.user.name}</span>
                <span className="preview">{c.user.email ?? c.user.id}</span>
                <span className="badge">{statusLabel(c, t)}</span>
              </div>
            ))
          )}
        </div>
      </aside>

      <main className="lcb-admin-main">
        {!thread ? (
          <div className="lcb-admin-blank">{t('admin.queue.empty')}</div>
        ) : (
          <>
            <div className="lcb-admin-main-header">
              <div>
                <h2>{thread.chat.user.name}</h2>
                <div className="status">{statusLabel(thread.chat, t)}</div>
              </div>
              <div className="lcb-admin-actions">
                {thread.chat.status !== CHAT_STATUS.CLAIMED ||
                thread.chat.assignedStaffId !== viewer?.id ? (
                  <button
                    className="primary"
                    onClick={() => void claim()}
                    disabled={thread.chat.status === CHAT_STATUS.CLOSED}
                    type="button"
                  >
                    {t('admin.chat.claim')}
                  </button>
                ) : null}
                <button
                  onClick={() => void close()}
                  disabled={thread.chat.status === CHAT_STATUS.CLOSED}
                  type="button"
                >
                  {t('admin.chat.close')}
                </button>
              </div>
            </div>
            <div className="lcb-admin-thread" ref={threadRef}>
              {thread.messages.map((m) => (
                <AdminRow key={m.id} message={m} />
              ))}
            </div>
            {thread.error ? <div className="lcb-admin-error">{thread.error}</div> : null}
            <div className="lcb-admin-composer">
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('admin.chat.composer.placeholder')}
                disabled={
                  thread.chat.status === CHAT_STATUS.CLOSED ||
                  thread.chat.assignedStaffId !== viewer?.id
                }
              />
              <button
                onClick={() => void send()}
                disabled={
                  !draft.trim() ||
                  thread.chat.status === CHAT_STATUS.CLOSED ||
                  thread.chat.assignedStaffId !== viewer?.id ||
                  sending
                }
                type="button"
              >
                {t('admin.chat.composer.send')}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function TabButton({
  tab,
  current,
  setTab,
  count,
  label,
}: {
  tab: Tab;
  current: Tab;
  setTab: (t: Tab) => void;
  count: number;
  label: string;
}) {
  return (
    <button
      className="lcb-admin-tab"
      aria-pressed={tab === current}
      onClick={() => setTab(tab)}
      type="button"
    >
      {label} <span className="count">{count}</span>
    </button>
  );
}

function AdminRow({ message }: { message: Message }) {
  const variant =
    message.senderType === 'staff'
      ? 'staff'
      : message.senderType === 'ai'
        ? 'ai'
        : message.senderType === 'system'
          ? 'system'
          : 'user';
  return (
    <div className={`lcb-msg ${variant}`}>
      {variant !== 'system' && message.senderName ? (
        <div className="meta">{message.senderName}</div>
      ) : null}
      <div className="bubble">{message.body}</div>
    </div>
  );
}

function statusLabel(chat: Chat, t: (k: string, v?: Record<string, string>) => string): string {
  if (chat.status === CHAT_STATUS.CLAIMED) {
    return t('admin.chat.claimed', { name: chat.assignedStaffId ?? '' });
  }
  if (chat.status === CHAT_STATUS.AI) return t('admin.chat.ai');
  if (chat.status === CHAT_STATUS.CLOSED) return 'Closed';
  return t('admin.queue.open');
}

function dedupe(messages: Message[]): Message[] {
  const seen = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}
