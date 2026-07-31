/**
 * React binding for `ChatTransport`.
 *
 * Intentionally thin: every hard problem — transport selection, backoff,
 * cursors, deduplication — is solved once in `transport.ts`, where it can be
 * tested without a DOM. What is left here is genuinely React-shaped work:
 * owning the session/transport lifecycle in an effect, projecting envelopes
 * into render state, and holding the optimistic messages that only exist on
 * this client.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Attachment,
  ConnectionState,
  Conversation,
  Message,
  SiteId,
  Visitor,
} from '../types.js';
import {
  ChatTransport,
  createSession,
  type FetchLike,
  type WebSocketFactory,
} from './transport.js';

/** A message plus the delivery state that exists only on the sending client. */
export interface OptimisticMessage extends Message {
  /** Rendered immediately; still awaiting the server's echo. */
  pending?: boolean;
  /** The POST failed — the UI offers a retry. */
  failed?: boolean;
}

export interface UseChatSocketOptions {
  siteId: SiteId;
  baseUrl: string;
  socketUrl?: string | undefined;
  identity?: { id: string; name?: string; email?: string } | undefined;
  identityHmac?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  /**
   * Gate for the pre-chat form: no session is minted (and no visitor record
   * created) until the widget decides it actually has a conversation to start.
   */
  enabled?: boolean;
  fetchImpl?: FetchLike | undefined;
  WebSocketImpl?: WebSocketFactory | undefined;
}

export interface UseChatSocketResult {
  state: ConnectionState;
  messages: OptimisticMessage[];
  conversation: Conversation | undefined;
  visitor: Visitor | undefined;
  /** True while the other side is composing. Self-expiring. */
  typing: boolean;
  /** Name to show next to the typing indicator, when the server sent one. */
  typingName: string | undefined;
  error: Error | undefined;
  sendMessage(body: string, attachments?: Attachment[]): Promise<void>;
  /** Throttled upstream ping so agents see the visitor composing. */
  notifyTyping(): void;
  retry(clientId: string): void;
  /** Abandon a `closed` conversation and start a fresh one. */
  startNew(): void;
  uploadAttachment(file: unknown, name: string): Promise<Attachment>;
}

/** How long a received typing ping keeps the indicator alive. */
const TYPING_TTL_MS = 4_000;
/** Upstream typing pings are rate-limited to one per this window. */
const TYPING_THROTTLE_MS = 2_000;

export function useChatSocket(options: UseChatSocketOptions): UseChatSocketResult {
  const {
    siteId,
    baseUrl,
    socketUrl,
    identity,
    identityHmac,
    metadata,
    enabled = true,
    fetchImpl,
    WebSocketImpl,
  } = options;

  const [state, setState] = useState<ConnectionState>('idle');
  const [messages, setMessages] = useState<OptimisticMessage[]>([]);
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [visitor, setVisitor] = useState<Visitor | undefined>();
  const [typing, setTyping] = useState(false);
  const [typingName, setTypingName] = useState<string | undefined>();
  const [error, setError] = useState<Error | undefined>();

  const transportRef = useRef<ChatTransport | null>(null);
  const conversationRef = useRef<Conversation | undefined>(undefined);
  /** Mirror of `messages` for callbacks that must not be re-created per render. */
  const messagesRef = useRef<OptimisticMessage[]>(messages);
  messagesRef.current = messages;
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingSentRef = useRef(0);
  /** Bumped by `startNew()` to re-run the session effect from scratch. */
  const [epoch, setEpoch] = useState(0);

  // Mutable inputs are read through a ref so that a fresh `metadata` object
  // literal on every render does not tear the socket down and back up.
  const latest = useRef({ identity, identityHmac, metadata });
  latest.current = { identity, identityHmac, metadata };

  const identityKey = identity ? `${identity.id}:${identityHmac ?? ''}` : '';

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let transport: ChatTransport | null = null;

    const boot = async (): Promise<void> => {
      try {
        const session = await createSession(
          baseUrl,
          {
            siteId,
            ...(latest.current.identity ? { identity: latest.current.identity } : {}),
            ...(latest.current.identityHmac ? { identityHmac: latest.current.identityHmac } : {}),
            ...(latest.current.metadata ? { metadata: latest.current.metadata } : {}),
          },
          fetchImpl,
        );
        if (cancelled) return;

        setVisitor(session.visitor);
        setConversation(session.conversation);
        conversationRef.current = session.conversation;

        transport = new ChatTransport({
          baseUrl,
          socketUrl: socketUrl ?? session.socketUrl,
          token: session.token,
          conversationId: session.conversation?.id,
          WebSocketImpl,
          fetchImpl,
        });
        transportRef.current = transport;

        transport.onStateChange(setState);
        transport.onError(setError);

        transport.on('message:new', ({ message }) => {
          setMessages((prev) => mergeMessage(prev, message));
        });
        transport.on('message:updated', ({ message }) => {
          setMessages((prev) => mergeMessage(prev, message));
        });
        transport.on('conversation:updated', ({ conversation: next }) => {
          conversationRef.current = next;
          setConversation(next);
        });
        transport.on('conversation:assigned', ({ conversationId, agent }) => {
          setConversation((prev) =>
            prev && prev.id === conversationId
              ? { ...prev, status: 'assigned', assignedAgentId: agent.id }
              : prev,
          );
        });
        transport.on('conversation:closed', ({ conversationId }) => {
          setConversation((prev) =>
            prev && prev.id === conversationId ? { ...prev, status: 'closed' } : prev,
          );
        });
        transport.on('typing', (payload) => {
          // Only the *other* side's typing is worth rendering.
          if (payload.senderType === 'visitor') return;
          setTypingName(payload.senderName);
          setTyping(true);
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
          typingTimerRef.current = setTimeout(() => setTyping(false), TYPING_TTL_MS);
        });

        transport.connect();

        // Backfill before live events land; `mergeMessage` makes the overlap
        // between the two sources idempotent.
        if (session.conversation) {
          const history = await transport.fetchMessages(session.conversation.id);
          if (cancelled) return;
          setMessages((prev) => history.reduce(mergeMessage, prev));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void boot();

    return () => {
      cancelled = true;
      transport?.close();
      transportRef.current = null;
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
        typingTimerRef.current = null;
      }
    };
  }, [enabled, siteId, baseUrl, socketUrl, identityKey, epoch, fetchImpl, WebSocketImpl]);

  const deliver = useCallback(async (draft: OptimisticMessage): Promise<void> => {
    const transport = transportRef.current;
    if (!transport) {
      setError(new Error('Chat is not connected yet'));
      return;
    }
    try {
      const sent = await transport.sendMessage({
        ...(conversationRef.current ? { conversationId: conversationRef.current.id } : {}),
        body: draft.body,
        clientId: draft.clientId,
        ...(draft.attachments ? { attachments: draft.attachments } : {}),
      });
      // First message of a conversation: the POST is what tells us the id, so
      // point the resume cursor at it before any events can arrive.
      if (!conversationRef.current && sent.conversationId) {
        transport.setConversation(sent.conversationId);
      }
      setMessages((prev) => mergeMessage(prev, sent));
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      setMessages((prev) =>
        prev.map((m) => (m.clientId === draft.clientId ? { ...m, pending: false, failed: true } : m)),
      );
    }
  }, []);

  const sendMessage = useCallback(
    async (body: string, attachments?: Attachment[]): Promise<void> => {
      const trimmed = body.trim();
      if (!trimmed && !attachments?.length) return;

      const clientId = newClientId();
      const draft: OptimisticMessage = {
        id: `local:${clientId}`,
        siteId,
        conversationId: conversationRef.current?.id ?? '',
        senderType: 'visitor',
        body: trimmed,
        clientId,
        createdAt: new Date().toISOString(),
        pending: true,
        ...(attachments?.length ? { attachments } : {}),
      };
      setError(undefined);
      setMessages((prev) => [...prev, draft]);
      await deliver(draft);
    },
    [siteId, deliver],
  );

  const retry = useCallback(
    (clientId: string): void => {
      // Read from the ref, not from inside a `setMessages` updater: updaters
      // are not guaranteed to run synchronously under concurrent rendering.
      const draft = messagesRef.current.find((m) => m.clientId === clientId);
      if (!draft) return;
      setMessages((prev) =>
        prev.map((m) => (m.clientId === clientId ? { ...m, failed: false, pending: true } : m)),
      );
      void deliver(draft);
    },
    [deliver],
  );

  const notifyTyping = useCallback((): void => {
    const transport = transportRef.current;
    const conversationId = conversationRef.current?.id;
    if (!transport || !conversationId) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < TYPING_THROTTLE_MS) return;
    lastTypingSentRef.current = now;
    transport.sendTyping(conversationId);
  }, []);

  const uploadAttachment = useCallback(async (file: unknown, name: string): Promise<Attachment> => {
    const transport = transportRef.current;
    const conversationId = conversationRef.current?.id;
    if (!transport || !conversationId) throw new Error('Start the conversation before attaching');
    return transport.uploadAttachment(conversationId, file, name);
  }, []);

  const startNew = useCallback((): void => {
    conversationRef.current = undefined;
    setConversation(undefined);
    setMessages([]);
    setError(undefined);
    setTyping(false);
    // Re-running the effect re-mints the session, which is also how the server
    // learns the old conversation was abandoned rather than resumed.
    setEpoch((n) => n + 1);
  }, []);

  // `conversationRef` shadows the state for callbacks that must not re-create.
  useEffect(() => {
    conversationRef.current = conversation;
  }, [conversation]);

  return useMemo(
    () => ({
      state,
      messages,
      conversation,
      visitor,
      typing,
      typingName,
      error,
      sendMessage,
      notifyTyping,
      retry,
      startNew,
      uploadAttachment,
    }),
    [
      state,
      messages,
      conversation,
      visitor,
      typing,
      typingName,
      error,
      sendMessage,
      notifyTyping,
      retry,
      startNew,
      uploadAttachment,
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Idempotent insert keyed on `clientId` first, then `id`.
 *
 * `clientId` is what closes the optimistic loop: the server echoes it back on
 * the message it persisted, so the bubble already on screen is *replaced*
 * rather than joined by a twin. History backfill and live events overlap by
 * design, hence the `id` fallback.
 */
function mergeMessage(list: OptimisticMessage[], message: Message): OptimisticMessage[] {
  const index = list.findIndex(
    (m) => (message.clientId && m.clientId === message.clientId) || m.id === message.id,
  );
  const settled: OptimisticMessage = { ...message, pending: false, failed: false };
  if (index >= 0) {
    const next = list.slice();
    next[index] = settled;
    return next;
  }
  // Late arrivals are rare but real (a slow POST racing its own echo), so keep
  // the thread ordered by timestamp instead of by arrival.
  const next = [...list, settled];
  next.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return next;
}

function newClientId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
