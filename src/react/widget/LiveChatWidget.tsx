'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type Pusher from 'pusher-js';
import { CHAT_STATUS, EVENTS, chatChannel, type Chat, type Message } from '../../core/index.js';
import { api, type Viewer } from '../shared/api.js';
import { useRealtimeChannel } from '../shared/useRealtimeChannel.js';
import { PusherRealtimeClient } from '../shared/pusherRealtime.js';
import type { RealtimeClient } from '../shared/realtime.js';
import { useI18n, type Locale, type Messages } from '../shared/i18n.js';

export interface LiveChatWidgetProps {
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
  /** Where the server handlers are mounted. Defaults to `/api/livechat`. */
  basePath?: string;
  /** UI locale. */
  locale?: Locale;
  /** Override individual translation keys. */
  translations?: Partial<Messages>;
  /** URL to send guests to. If unset, the sign-in card hides the link. */
  signInUrl?: string;
  /** Open the widget on mount instead of waiting for a click. */
  defaultOpen?: boolean;
  /** Optional fetch override (SSR, custom auth). */
  fetch?: typeof fetch;
}

interface ChatState {
  chat: Pick<Chat, 'id' | 'status' | 'assignedStaffId'> | null;
  messages: Message[];
  staffName?: string;
  error?: string;
}

const initialState: ChatState = { chat: null, messages: [] };

export function LiveChatWidget({
  realtime,
  pusher,
  basePath,
  locale = 'en',
  translations,
  signInUrl,
  defaultOpen = false,
  fetch: fetchOverride,
}: LiveChatWidgetProps) {
  const apiOpts = useMemo(() => ({ basePath, fetch: fetchOverride }), [basePath, fetchOverride]);
  const { t } = useI18n(locale, translations);

  const realtimeClient = useMemo<RealtimeClient | null>(
    () => realtime ?? (pusher ? new PusherRealtimeClient(pusher) : null),
    [realtime, pusher]
  );

  const [open, setOpen] = useState(defaultOpen);
  const [viewer, setViewer] = useState<Viewer | null | undefined>(undefined);
  const [state, setState] = useState<ChatState>(initialState);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Fetch viewer once on open.
  useEffect(() => {
    if (!open || viewer !== undefined) return;
    let cancelled = false;
    api
      .viewer(apiOpts)
      .then((r) => !cancelled && setViewer(r.viewer))
      .catch(() => !cancelled && setViewer(null));
    return () => {
      cancelled = true;
    };
  }, [open, viewer, apiOpts]);

  const channelName = state.chat ? chatChannel(state.chat.id) : null;

  useRealtimeChannel({
    client: realtimeClient,
    channelName,
    events: {
      [EVENTS.MESSAGE_NEW]: (payload) => {
        const p = payload as { message: Message; chat: ChatState['chat'] };
        setState((s) => ({
          ...s,
          chat: p.chat ?? s.chat,
          messages: dedupe([...s.messages, p.message]),
        }));
      },
      [EVENTS.MESSAGE_AI]: (payload) => {
        const p = payload as { message: Message; chat: ChatState['chat'] };
        setState((s) => ({
          ...s,
          chat: p.chat ?? s.chat,
          messages: dedupe([...s.messages, p.message]),
        }));
      },
      [EVENTS.CHAT_CLAIMED]: (payload) => {
        const p = payload as { staffId: string; staffName: string };
        setState((s) => ({
          ...s,
          chat: s.chat ? { ...s.chat, status: CHAT_STATUS.CLAIMED, assignedStaffId: p.staffId } : s.chat,
          staffName: p.staffName,
          messages: [
            ...s.messages,
            systemMessage(s.chat?.id ?? '', t('widget.system.staffJoined', { name: p.staffName })),
          ],
        }));
      },
      [EVENTS.CHAT_AI_TAKEOVER]: () => {
        setState((s) => ({
          ...s,
          chat: s.chat ? { ...s.chat, status: CHAT_STATUS.AI } : s.chat,
          messages: [...s.messages, systemMessage(s.chat?.id ?? '', t('widget.system.aiTakeover'))],
        }));
      },
      [EVENTS.CHAT_CLOSED]: () => {
        setState((s) => ({
          ...s,
          chat: s.chat ? { ...s.chat, status: CHAT_STATUS.CLOSED } : s.chat,
          messages: [...s.messages, systemMessage(s.chat?.id ?? '', t('widget.system.chatClosed'))],
        }));
      },
    },
  });

  useEffect(() => {
    if (!bodyRef.current) return;
    bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [state.messages.length, open]);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setState((s) => ({ ...s, error: undefined }));
    try {
      const r = await api.sendMessage(apiOpts, { chatId: state.chat?.id, body });
      setState((s) => ({
        ...s,
        chat: s.chat ?? {
          id: r.message.chatId,
          status: CHAT_STATUS.OPEN,
          assignedStaffId: undefined,
        },
        messages: dedupe([...s.messages, r.message]),
      }));
      setDraft('');
    } catch {
      setState((s) => ({ ...s, error: t('widget.error.send') }));
    } finally {
      setSending(false);
    }
  }, [draft, sending, apiOpts, state.chat?.id, t]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send]
  );

  const subtitle =
    state.chat?.status === CHAT_STATUS.AI
      ? t('widget.header.subtitle.ai')
      : state.chat?.status === CHAT_STATUS.CLAIMED && state.staffName
        ? t('widget.header.subtitle.staff', { name: state.staffName })
        : t('widget.header.subtitle.online');

  if (!open) {
    return (
      <div className="lcb-widget">
        <button className="lcb-launcher" onClick={() => setOpen(true)} type="button">
          💬 {t('widget.launcher.label')}
        </button>
      </div>
    );
  }

  return (
    <div className="lcb-widget">
      <div className="lcb-panel" role="dialog" aria-label={t('widget.header.title')}>
        <div className="lcb-header">
          <div>
            <h2>{t('widget.header.title')}</h2>
            <p>{subtitle}</p>
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close" type="button">
            ×
          </button>
        </div>

        {viewer === null ? (
          <div className="lcb-body">
            <div className="lcb-guest">
              <h3>{t('widget.signIn.title')}</h3>
              <p>{t('widget.signIn.body')}</p>
              {signInUrl ? <a href={signInUrl}>{t('widget.signIn.action')}</a> : null}
            </div>
          </div>
        ) : (
          <>
            <div className="lcb-body" ref={bodyRef}>
              {state.messages.length === 0 ? (
                <div className="lcb-empty">
                  <strong>{t('widget.empty.title')}</strong>
                  {t('widget.empty.body')}
                </div>
              ) : (
                state.messages.map((m) => (
                  <MessageRow key={m.id} message={m} viewer={viewer} t={t} />
                ))
              )}
            </div>
            {state.error ? <div className="lcb-error">{state.error}</div> : null}
            <div className="lcb-composer">
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('widget.composer.placeholder')}
                disabled={
                  !viewer || state.chat?.status === CHAT_STATUS.CLOSED || sending
                }
              />
              <button
                onClick={() => void send()}
                disabled={
                  !viewer ||
                  !draft.trim() ||
                  state.chat?.status === CHAT_STATUS.CLOSED ||
                  sending
                }
                type="button"
              >
                {t('widget.composer.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function MessageRow({
  message,
  viewer,
  t,
}: {
  message: Message;
  viewer: Viewer | null | undefined;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const isUser = viewer?.id && message.senderId === viewer.id;
  const variant = message.senderType === 'system'
    ? 'system'
    : message.senderType === 'ai'
      ? 'ai'
      : isUser
        ? 'user'
        : 'other';
  const meta =
    variant === 'user'
      ? t('widget.sender.you')
      : message.senderType === 'ai'
        ? t('widget.sender.assistant')
        : message.senderName ?? '';
  return (
    <div className={`lcb-msg ${variant}`}>
      {variant !== 'system' && meta ? <div className="lcb-msg-meta">{meta}</div> : null}
      <div className="lcb-msg-bubble">{message.body}</div>
    </div>
  );
}

function systemMessage(chatId: string, body: string): Message {
  return {
    id: `sys_${Math.random().toString(36).slice(2)}`,
    chatId,
    senderType: 'system',
    body,
    createdAt: new Date(),
  };
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
