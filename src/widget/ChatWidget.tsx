/**
 * The embeddable visitor widget: a launcher bubble plus a chat panel.
 *
 * This component runs on someone else's page, which drives most of the design
 * decisions here — every class name is `lcb-` prefixed, the panel traps focus
 * while open so keyboard users are not dropped back into the host document
 * mid-conversation, and nothing is rendered until the visitor opens it.
 *
 * All connection behaviour lives in `useChatSocket` / `ChatTransport`; this
 * file is presentation plus the small amount of local state a chat UI needs
 * (draft text, scroll pinning, the pre-chat form).
 *
 * The stylesheet is *not* imported here — bundlers in host apps handle CSS
 * imports inconsistently. Consumers import `livechat-bridge/widget/widget.css`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Attachment, Message, SenderType, SiteId } from '../types.js';
import { useChatSocket, type OptimisticMessage } from './useChatSocket.js';

export interface ChatWidgetProps {
  siteId: SiteId;
  /** Base URL of the mounted server routes, e.g. `/api/livechat`. */
  baseUrl: string;
  /** Overrides the `socketUrl` the session hands back. */
  socketUrl?: string;
  /** Host-vouched identity; requires `identityHmac` to be trusted. */
  identity?: { id: string; name?: string; email?: string };
  identityHmac?: string;
  /** Extra context stored on the conversation (plan, current URL, …). */
  metadata?: Record<string, unknown>;
  title?: string;
  greeting?: string;
  position?: 'bottom-right' | 'bottom-left';
  accentColor?: string;
  /** BCP-47 tag. Unknown locales fall back to English. */
  locale?: string;
  /** Start with the panel open — handy for a "Chat with us" link. */
  defaultOpen?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Strings                                                                     */
/* -------------------------------------------------------------------------- */

interface Strings {
  launcherOpen: string;
  launcherClose: string;
  panelLabel: string;
  online: string;
  connecting: string;
  offline: string;
  preChatIntro: string;
  name: string;
  email: string;
  optional: string;
  start: string;
  placeholder: string;
  send: string;
  attach: string;
  typing: string;
  retry: string;
  failed: string;
  closedNotice: string;
  startNew: string;
  thread: string;
  you: string;
  assistant: string;
  system: string;
}

const EN: Strings = {
  launcherOpen: 'Open chat',
  launcherClose: 'Close chat',
  panelLabel: 'Live chat',
  online: 'Connected',
  connecting: 'Connecting…',
  offline: 'Reconnecting…',
  preChatIntro: 'Tell us who you are so we can follow up.',
  name: 'Name',
  email: 'Email',
  optional: 'optional',
  start: 'Start chatting',
  placeholder: 'Write a message…',
  send: 'Send message',
  attach: 'Attach a file',
  typing: 'is typing',
  retry: 'Retry',
  failed: 'Not delivered',
  closedNotice: 'This conversation has been closed.',
  startNew: 'Start a new conversation',
  thread: 'Conversation transcript',
  you: 'You',
  assistant: 'Assistant',
  system: 'System',
};

const BN: Strings = {
  launcherOpen: 'চ্যাট খুলুন',
  launcherClose: 'চ্যাট বন্ধ করুন',
  panelLabel: 'লাইভ চ্যাট',
  online: 'সংযুক্ত',
  connecting: 'সংযোগ হচ্ছে…',
  offline: 'পুনরায় সংযোগ হচ্ছে…',
  preChatIntro: 'আপনার পরিচয় দিন যেন আমরা যোগাযোগ করতে পারি।',
  name: 'নাম',
  email: 'ইমেইল',
  optional: 'ঐচ্ছিক',
  start: 'চ্যাট শুরু করুন',
  placeholder: 'বার্তা লিখুন…',
  send: 'বার্তা পাঠান',
  attach: 'ফাইল সংযুক্ত করুন',
  typing: 'লিখছেন',
  retry: 'আবার চেষ্টা',
  failed: 'পৌঁছায়নি',
  closedNotice: 'এই কথোপকথনটি বন্ধ করা হয়েছে।',
  startNew: 'নতুন কথোপকথন শুরু করুন',
  thread: 'কথোপকথনের রেকর্ড',
  you: 'আপনি',
  assistant: 'সহকারী',
  system: 'সিস্টেম',
};

function stringsFor(locale: string | undefined): Strings {
  return locale?.toLowerCase().startsWith('bn') ? BN : EN;
}

/* -------------------------------------------------------------------------- */
/* Widget                                                                      */
/* -------------------------------------------------------------------------- */

export function ChatWidget(props: ChatWidgetProps): JSX.Element {
  const {
    siteId,
    baseUrl,
    socketUrl,
    identity,
    identityHmac,
    metadata,
    title = 'Chat with us',
    greeting = 'Hi! How can we help?',
    position = 'bottom-right',
    accentColor,
    locale,
    defaultOpen = false,
  } = props;

  const t = useMemo(() => stringsFor(locale), [locale]);

  const [open, setOpen] = useState(defaultOpen);
  /** Anonymous visitors answer the pre-chat form before a session is minted. */
  const [preChatDone, setPreChatDone] = useState(Boolean(identity));
  const [preChat, setPreChat] = useState<{ name: string; email: string }>({ name: '', email: '' });
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const chatMetadata = useMemo(() => {
    const url = typeof location !== 'undefined' ? location.href : undefined;
    return {
      ...(url ? { url } : {}),
      ...(preChat.name ? { name: preChat.name } : {}),
      ...(preChat.email ? { email: preChat.email } : {}),
      ...metadata,
    };
  }, [metadata, preChat.name, preChat.email]);

  const chat = useChatSocket({
    siteId,
    baseUrl,
    socketUrl,
    identity,
    identityHmac,
    metadata: chatMetadata,
    // No session — and therefore no visitor record — until the visitor has
    // both opened the panel and cleared the pre-chat form.
    enabled: open && preChatDone,
  });

  const isClosed = chat.conversation?.status === 'closed';

  /* -- Escape to close, focus trap ---------------------------------------- */

  useEffect(() => {
    if (!open) return;
    const node = panelRef.current;
    if (!node) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = getFocusable(node);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = node.ownerDocument.activeElement;

      // Wrap at both ends so Tab can never walk out into the host page while
      // the panel is open.
      if (event.shiftKey && (active === first || !node.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // Move focus in on open and back to the launcher on close, so the widget is
  // never a keyboard dead end.
  useEffect(() => {
    if (open) {
      const target = preChatDone ? composerRef.current : panelRef.current;
      target?.focus();
    } else {
      launcherRef.current?.focus({ preventScroll: true });
    }
    // `preChatDone` intentionally excluded: focus moves on open, not on submit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* -- Keep the thread pinned to the newest message ------------------------ */

  useLayoutEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat.messages, chat.typing, open]);

  /* -- Actions ------------------------------------------------------------- */

  const submitPreChat = useCallback((event: { preventDefault(): void }): void => {
    event.preventDefault();
    setPreChatDone(true);
    // Defer to the next frame so the composer exists before we focus it.
    setTimeout(() => composerRef.current?.focus(), 0);
  }, []);

  const send = useCallback((): void => {
    const body = draft.trim();
    if (!body && pendingAttachments.length === 0) return;
    setDraft('');
    setPendingAttachments([]);
    void chat.sendMessage(body, pendingAttachments.length ? pendingAttachments : undefined);
  }, [chat, draft, pendingAttachments]);

  const onComposerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
      // Enter sends; Shift+Enter is a newline. IME composition must never send.
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        send();
        return;
      }
      chat.notifyTyping();
    },
    [chat, send],
  );

  const onPickFile = useCallback(
    async (event: { target: { files: FileList | null; value: string } }): Promise<void> => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const attachment = await chat.uploadAttachment(file, file.name);
        setPendingAttachments((prev) => [...prev, attachment]);
      } catch {
        // `chat.error` already carries the failure; the composer stays usable.
      }
    },
    [chat],
  );

  const rootStyle = useMemo<CSSProperties>(
    () => (accentColor ? ({ ['--lcb-accent']: accentColor } as CSSProperties) : {}),
    [accentColor],
  );

  const status =
    chat.state === 'open' || chat.state === 'polling'
      ? t.online
      : chat.state === 'connecting'
        ? t.connecting
        : t.offline;

  return (
    <div className="lcb-root" data-position={position} data-open={open} style={rootStyle}>
      {open ? (
        <div
          className="lcb-panel"
          role="dialog"
          aria-modal="true"
          aria-label={t.panelLabel}
          ref={panelRef}
          tabIndex={-1}
        >
          <header className="lcb-header">
            <div className="lcb-header-text">
              <h2 className="lcb-title">{title}</h2>
              <p className="lcb-status">
                <span
                  className="lcb-status-dot"
                  data-state={chat.state}
                  aria-hidden="true"
                />
                <span>{status}</span>
              </p>
            </div>
            <button
              type="button"
              className="lcb-icon-button"
              onClick={() => setOpen(false)}
              aria-label={t.launcherClose}
            >
              <CloseIcon />
            </button>
          </header>

          <div
            className="lcb-thread"
            ref={threadRef}
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            aria-label={t.thread}
            tabIndex={0}
          >
            {greeting ? (
              <div className="lcb-bubble-row" data-sender="system">
                <div className="lcb-bubble" data-sender="system">
                  {greeting}
                </div>
              </div>
            ) : null}

            {chat.messages.map((message) => (
              <MessageBubble
                key={message.clientId ?? message.id}
                message={message}
                strings={t}
                locale={locale}
                onRetry={chat.retry}
              />
            ))}

            {chat.typing ? (
              <div className="lcb-bubble-row" data-sender="agent">
                <Avatar name={chat.typingName ?? t.assistant} senderType="agent" />
                <div className="lcb-bubble lcb-typing" aria-label={`${chat.typingName ?? t.assistant} ${t.typing}`}>
                  <span className="lcb-dot" />
                  <span className="lcb-dot" />
                  <span className="lcb-dot" />
                </div>
              </div>
            ) : null}
          </div>

          {!preChatDone ? (
            <form className="lcb-prechat" onSubmit={submitPreChat}>
              <p className="lcb-prechat-intro">{t.preChatIntro}</p>
              <label className="lcb-field">
                <span className="lcb-label">{t.name}</span>
                <input
                  className="lcb-input"
                  name="name"
                  autoComplete="name"
                  value={preChat.name}
                  onChange={(e) => setPreChat((p) => ({ ...p, name: e.target.value }))}
                />
              </label>
              <label className="lcb-field">
                <span className="lcb-label">
                  {t.email} <span className="lcb-muted">({t.optional})</span>
                </span>
                <input
                  className="lcb-input"
                  name="email"
                  type="email"
                  autoComplete="email"
                  value={preChat.email}
                  onChange={(e) => setPreChat((p) => ({ ...p, email: e.target.value }))}
                />
              </label>
              <button type="submit" className="lcb-primary-button">
                {t.start}
              </button>
            </form>
          ) : isClosed ? (
            <div className="lcb-closed">
              <p className="lcb-closed-notice">{t.closedNotice}</p>
              <button type="button" className="lcb-primary-button" onClick={chat.startNew}>
                {t.startNew}
              </button>
            </div>
          ) : (
            <div className="lcb-composer">
              {pendingAttachments.length > 0 ? (
                <ul className="lcb-attachments">
                  {pendingAttachments.map((attachment) => (
                    <li key={attachment.id} className="lcb-attachment">
                      {attachment.name}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="lcb-composer-row">
                <button
                  type="button"
                  className="lcb-icon-button"
                  aria-label={t.attach}
                  onClick={() => fileRef.current?.click()}
                >
                  <ClipIcon />
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  className="lcb-visually-hidden"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(e) => void onPickFile(e)}
                />
                <textarea
                  ref={composerRef}
                  className="lcb-textarea"
                  rows={1}
                  value={draft}
                  placeholder={t.placeholder}
                  aria-label={t.placeholder}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKeyDown}
                />
                <button
                  type="button"
                  className="lcb-send-button"
                  aria-label={t.send}
                  disabled={!draft.trim() && pendingAttachments.length === 0}
                  onClick={send}
                >
                  <SendIcon />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      <button
        type="button"
        ref={launcherRef}
        className="lcb-launcher"
        aria-expanded={open}
        aria-label={open ? t.launcherClose : t.launcherOpen}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                      */
/* -------------------------------------------------------------------------- */

function MessageBubble({
  message,
  strings,
  locale,
  onRetry,
}: {
  message: OptimisticMessage;
  strings: Strings;
  locale: string | undefined;
  onRetry: (clientId: string) => void;
}): JSX.Element {
  const mine = message.senderType === 'visitor';
  const who = mine
    ? strings.you
    : message.senderType === 'ai'
      ? strings.assistant
      : message.senderType === 'system'
        ? strings.system
        : (message.senderName ?? '');

  return (
    <div className="lcb-bubble-row" data-sender={message.senderType} data-mine={mine}>
      {!mine ? <Avatar name={who} senderType={message.senderType} /> : null}
      <div className="lcb-bubble-stack">
        {!mine && who ? <span className="lcb-sender">{who}</span> : null}
        <div className="lcb-bubble" data-sender={message.senderType} data-pending={message.pending}>
          {message.body ? <span className="lcb-body">{message.body}</span> : null}
          {message.attachments?.length ? (
            <ul className="lcb-bubble-attachments">
              {message.attachments.map((attachment) => (
                <li key={attachment.id}>
                  <a href={attachment.url} target="_blank" rel="noreferrer noopener">
                    {attachment.name}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <span className="lcb-meta">
          <time dateTime={message.createdAt}>{formatTime(message.createdAt, locale)}</time>
          {message.failed ? (
            <>
              <span className="lcb-failed">{strings.failed}</span>
              <button
                type="button"
                className="lcb-link-button"
                onClick={() => message.clientId && onRetry(message.clientId)}
              >
                {strings.retry}
              </button>
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function Avatar({ name, senderType }: { name: string; senderType: SenderType }): JSX.Element {
  return (
    <span className="lcb-avatar" data-sender={senderType} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

function ChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.5 8.5 0 0 1 21 11.5Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 12 20 4l-4 16-4-6-8-2Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClipIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

function formatTime(iso: string, locale: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
  } catch {
    return date.toISOString().slice(11, 16);
  }
}

export type { Message, OptimisticMessage };
